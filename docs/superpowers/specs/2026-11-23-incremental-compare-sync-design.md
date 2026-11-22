# Incremental Compare Sync (Skip Full Tree Scan) Design

**Date:** 2026-11-23
**Status:** Proposed (Awaiting Approval)

## Intent & Why
Currently, every `SyncEngine.sync()` calls `getTreeRecursive(headSha)` sequentially page-by-page (100 entries/page) and calls `getTreeRecursive(newHeadSha)` again after pushing. On large vaults (1,000+ files), this adds dozens of sequential network round-trips before any pull or push even begins.

## Goals, Non-Goals, Anti-Goals
- **Goals:**
  - Skip `getTreeRecursive` completely (`0` tree requests) when `headSha === state.lastSyncedCommitSha`.
  - When `headSha !== state.lastSyncedCommitSha` and `lastSyncedCommitSha !== null`, use `compareCommits(lastSyncedCommitSha, headSha)` (GitLab `/repository/compare`, GitHub `/compare/:base...:head`) to fetch only changed paths and update `remoteTextFiles` + `remoteImagePaths` incrementally.
  - Eliminate the redundant post-push `getTreeRecursive(newHeadSha)` by using `compareCommits(headSha, newHeadSha)` when available.
  - Parallelize `GitLabClient.getTreeRecursive` pages `2..totalPages` when `x-total-pages` is returned, speeding up initial sync and fallback scans.
- **Non-Goals:**
  - Changing local file hashing or `computeSyncPlan` 3-way diff semantics.
- **Anti-Goals:**
  - Never silently drop files if a compare API response is truncated, timed out, or returns 404 (must fall back to `getTreeRecursive`).

## Design Summary
- Add optional `compareCommits?(fromRef: string, toRef: string): Promise<RemoteCompareChange[] | null>` to `RemoteGitClient` (`src/types.ts`), where `null` signals truncation/timeout/unavailable so `SyncEngine` falls back to `getTreeRecursive`.
  - **GitLabClient:** Calls `GET /repository/compare?from=...&to=...`. Returns `null` if `compare_timeout` is true, response is >= 100 diffs (truncation risk), or commit is missing (404). For non-deleted allowlisted text files, resolves `blobSha` via `GET /repository/files/:path?ref=<toRef>` (or `x-gitlab-blob-id` header).
  - **GitHubClient:** Calls `GET /repos/:owner/:repo/compare/:base...:head`. Returns `null` if `files.length >= 300` or 404. Uses `file.sha` directly as `blobSha`.
- **SyncEngine (`src/sync/engine.ts`):**
  - Fast-path when `state.lastSyncedCommitSha !== null && headSha === state.lastSyncedCommitSha`: build `remoteTextFiles` from `state.files` and reuse `state.remoteImagePaths` with `0` tree/compare calls.
  - Incremental path when `headSha !== state.lastSyncedCommitSha`: call `compareCommits(state.lastSyncedCommitSha, headSha)` if implemented; if non-null, apply added/modified/renamed/deleted changes onto a copy of `state.files` + `state.remoteImagePaths`; if null, fall back to `getTreeRecursive(headSha)`.
  - Post-push (`applyPushes`): use `compareCommits(headSha, newHeadSha)` to update `blobSha` for pushed paths instead of `getTreeRecursive(newHeadSha)` (falling back to `getTreeRecursive` only if `compareCommits` is unavailable or returns `null`).
