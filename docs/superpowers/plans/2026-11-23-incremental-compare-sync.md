# Incremental Compare Sync (Skip Full Tree Scan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate full-repository tree scans during normal syncs by short-circuiting when `headSha === lastSyncedCommitSha`, using `compareCommits` when Remote advances, skipping post-push full tree scans, and parallelizing `GitLabClient.getTreeRecursive` pagination for initial/fallback scans.

**Architecture:** Add an optional `compareCommits(fromRef, toRef)` method to `RemoteGitClient` (`src/types.ts`), implement it in `GitLabClient` and `GitHubClient` (returning `null` on truncation/timeout/404 for safe fallback), parallelize `GitLabClient.getTreeRecursive` pages `2..totalPages`, and update `SyncEngine` (`src/sync/engine.ts`) to use the fast-path + incremental compare path before falling back to `getTreeRecursive`.

**Tech Stack:** TypeScript, Vitest, ESLint (`eslint-plugin-obsidianmd`), esbuild.

**Spec:** [2026-11-23-incremental-compare-sync-design.md](file:///D:/Process/Osidian-plugin-imgLazyLoad/docs/superpowers/specs/2026-11-23-incremental-compare-sync-design.md)

## Global Constraints
- Zero new runtime dependencies in `package.json`.
- `compareCommits` is optional on `RemoteGitClient` and returns `null` on truncation/timeout/404 so `SyncEngine` always falls back safely to `getTreeRecursive`.
- Must pass `npm test`, `npm run build`, and `npm run lint` (`eslint src --max-warnings=0`).

## Review Focus
- **Unchanged Remote (`headSha === lastSyncedCommitSha`):** Must perform `0` `getTreeRecursive` and `0` `compareCommits` calls, preserving `state.files` and `state.remoteImagePaths` verbatim.
- **Renamed files in compare:** `old_path` must be removed from `remoteTextFiles` / `remoteImagePaths` and `new_path` added with its new `blobSha` (or image entry).
- **Truncated / 404 compare response:** Must return `null` and trigger `getTreeRecursive(headSha)` fallback without throwing.
- **Post-push `blobSha` resolution:** `applyPushes` must resolve pushed `blobSha`s via `compareCommits(headSha, newHeadSha)` when available, falling back to `getTreeRecursive(newHeadSha)` when unavailable or `null`.
- **Parallel `getTreeRecursive` on GitLab:** When `x-total-pages` > 1, pages `2..totalPages` must be fetched concurrently (capped concurrency) in page order; when `x-total-pages` is absent, fall back to `x-next-page` sequential pagination.

---

### Task 1: Parallel Tree Scan & `compareCommits` on `RemoteGitClient`, `GitLabClient`, and `GitHubClient`

**Files:**
- Modify: `src/types.ts:78-88`
- Modify: `src/gitlab/client.ts:84-130`
- Modify: `src/github/client.ts:115-155`
- Test: `tests/client.test.ts`, `tests/github-client.test.ts`

**Interfaces:**
- Produces in `src/types.ts`:
  ```ts
  export interface RemoteCompareEntry {
    path: string;
    previousPath?: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    blobSha?: string;
  }
  ```
  and optional `compareCommits?(fromRef: string, toRef: string): Promise<RemoteCompareEntry[] | null>` on `RemoteGitClient`.
- Produces in `GitLabClient`:
  - `getTreeRecursive` parallelizing pages `2..totalPages` (concurrency 6) when `x-total-pages` is provided.
  - `compareCommits(fromRef: string, toRef: string): Promise<RemoteCompareEntry[] | null>` calling `/repository/compare` and resolving `blobSha` via `GET /repository/files/:path?ref=...` (or GraphQL/raw header) for non-deleted entries, returning `null` on `compare_timeout`, `diffs.length >= 100`, or 404.
- Produces in `GitHubClient`:
  - `compareCommits(fromRef: string, toRef: string): Promise<RemoteCompareEntry[] | null>` calling `/compare/:base...:head`, returning `null` if `files.length >= 300` or 404.

- [ ] **Step 1: Write failing unit tests in `tests/client.test.ts` and `tests/github-client.test.ts`**
  - Test `GitLabClient.getTreeRecursive` fetches pages `2..3` concurrently when `x-total-pages: 3` is returned on page 1.
  - Test `GitLabClient.compareCommits` maps added/modified/renamed/deleted diffs and resolves `blobSha`, and returns `null` on `compare_timeout: true` or 404.
  - Test `GitHubClient.compareCommits` maps added/modified/renamed/removed files with `sha`, and returns `null` on 404 or `>= 300` files.

- [ ] **Step 2: Run tests to verify they fail**
  - Run: `npx vitest run tests/client.test.ts tests/github-client.test.ts`

- [ ] **Step 3: Implement `RemoteCompareEntry`, `GitLabClient` parallel tree + `compareCommits`, and `GitHubClient.compareCommits`**

- [ ] **Step 4: Run client tests to verify they pass**
  - Run: `npx vitest run tests/client.test.ts tests/github-client.test.ts`

---

### Task 2: Fast-Path & Incremental Compare Sync in `SyncEngine` (`src/sync/engine.ts`)

**Files:**
- Modify: `src/sync/engine.ts:36-38,155-185,771-796`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `RemoteGitClient.compareCommits` (optional) from `src/types.ts`.

- [ ] **Step 1: Write failing unit tests in `tests/engine.test.ts`**
  1. When `headSha === state.lastSyncedCommitSha`, `SyncEngine.sync()` does NOT call `getTreeRecursive` or `compareCommits` and still pushes local edits cleanly.
  2. When `headSha !== state.lastSyncedCommitSha` and `compareCommits` returns added/modified/renamed/deleted entries (text + image), `SyncEngine.sync()` updates `remoteTextFiles` and `remoteImagePaths` incrementally without calling `getTreeRecursive`.
  3. When `compareCommits` returns `null`, `SyncEngine.sync()` falls back to `getTreeRecursive(headSha)`.
  4. `applyPushes` uses `compareCommits(headSha, newHeadSha)` when available instead of calling `getTreeRecursive(newHeadSha)`.

- [ ] **Step 2: Run `npx vitest run tests/engine.test.ts` to verify new tests fail**

- [ ] **Step 3: Implement fast-path, `buildRemoteStateIncremental`, and post-push `compareCommits` in `src/sync/engine.ts`**

- [ ] **Step 4: Run full verification suite**
  - Run: `npm test; if ($LASTEXITCODE -eq 0) { npm run build }; if ($LASTEXITCODE -eq 0) { npm run lint }`
  - Expected: All tests pass, build succeeds, lint exits 0 with 0 warnings.
