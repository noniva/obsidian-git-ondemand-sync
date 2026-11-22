# Auto-Merge (Keep-Both 3-Way Line Merge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically merge conflicting text files during `SyncEngine.sync()` using a 3-way line merge that keeps both Remote and Local lines on collisions and preserves edited files over deletions, pushing directly to the target branch.

**Architecture:** Add a pure, zero-dependency 3-way line-merge module (`src/sync/merge.ts`) using LCS line diffing, then integrate it into `SyncEngine` (`src/sync/engine.ts`) right after `resolveConvergedConflicts` with safe fallback to `mobile-conflict/...` if base/remote text cannot be fetched.

**Tech Stack:** TypeScript, Vitest, ESLint (`eslint-plugin-obsidianmd`), esbuild.

**Spec:** [2026-11-23-auto-merge-keep-both-design.md](file:///D:/Process/Osidian-plugin-imgLazyLoad/docs/superpowers/specs/2026-11-23-auto-merge-keep-both-design.md)

## Global Constraints
- Zero new runtime dependencies in `package.json`.
- Never inject Git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) into merged output.
- Preserve existing `activeConflictBranch` / `clearConflictBranch` behavior when `activeConflictBranch` is already open or when base/remote text cannot be fetched.
- Must pass `npm test`, `npm run build`, and `npm run lint` (`eslint src --max-warnings=0`).

## Review Focus
- **CRLF vs LF line endings:** Mobile/Windows edits may mix `\r\n` and `\n`; line splitting must normalize `\r\n` so unchanged lines aren't misclassified as colliding.
- **Unreachable base commit (404 / squashed history):** If `getRawText(path, lastSyncedCommitSha)` throws or returns non-string, `SyncEngine` must catch and fall back to `mobile-conflict/...` rather than failing the whole sync.
- **Merged result equals Remote:** If auto-merge produces content identical to `remoteText`, `SyncEngine` must not push a redundant empty-diff commit and must update `state.files[path]` cleanly.
- **One side edited, other side deleted:** Remote-edited + Local-deleted must restore Remote's file (`pullDownloads`); Local-edited + Remote-deleted must push Local's file (`pushUpdates`), never deleting either edit.
- **Active conflict branch already open:** When `state.activeConflictBranch` is non-null, `SyncEngine` must preserve `targetPushBranch = 'active-conflict'` and not bypass conflict-branch reconciliation.

---

### Task 1: Pure 3-Way Keep-Both Line Merge (`src/sync/merge.ts`)

**Files:**
- Create: `src/sync/merge.ts`
- Test: `tests/merge.test.ts`

**Interfaces:**
- Produces: `export function mergeThreeWayKeepBoth(base: string, remote: string, local: string): string`

- [ ] **Step 1: Write the failing unit tests in `tests/merge.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mergeThreeWayKeepBoth } from '../src/sync/merge';

describe('mergeThreeWayKeepBoth', () => {
  it('merges non-overlapping edits from remote and local cleanly', () => {
    const base = 'line 1\nline 2\nline 3\nline 4';
    const remote = 'line 1 (desktop)\nline 2\nline 3\nline 4';
    const local = 'line 1\nline 2\nline 3\nline 4 (mobile)';
    expect(mergeThreeWayKeepBoth(base, remote, local)).toBe(
      'line 1 (desktop)\nline 2\nline 3\nline 4 (mobile)',
    );
  });

  it('keeps both remote and local lines without markers on colliding edits', () => {
    const base = 'header\ntarget\nfooter';
    const remote = 'header\ndesktop edit\nfooter';
    const local = 'header\nmobile edit\nfooter';
    const merged = mergeThreeWayKeepBoth(base, remote, local);
    expect(merged).toBe('header\ndesktop edit\nmobile edit\nfooter');
    expect(merged).not.toContain('<<<<<<<');
  });

  it('deduplicates identical edits made on both sides', () => {
    const base = 'a\nb\nc';
    const remote = 'a\nshared\nc';
    const local = 'a\nshared\nc';
    expect(mergeThreeWayKeepBoth(base, remote, local)).toBe('a\nshared\nc');
  });

  it('keeps both sides when base is empty (both created same path)', () => {
    expect(mergeThreeWayKeepBoth('', 'from desktop', 'from mobile')).toBe(
      'from desktop\nfrom mobile',
    );
  });

  it('normalizes CRLF line endings without false collisions', () => {
    const base = 'one\r\ntwo\r\nthree';
    const remote = 'one (d)\r\ntwo\r\nthree';
    const local = 'one\ntwo\nthree (m)';
    expect(mergeThreeWayKeepBoth(base, remote, local)).toBe('one (d)\ntwo\nthree (m)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/merge.test.ts`
Expected: FAIL with module `../src/sync/merge` not found.

- [ ] **Step 3: Implement `mergeThreeWayKeepBoth(base: string, remote: string, local: string): string` in `src/sync/merge.ts`**

Use LCS-based line alignment between `base` and `remote`, and `base` and `local`, partition into base-anchored hunks (unchanged spans vs edit/insert spans), and emit:
- unchanged lines once,
- single-side changes directly,
- identical two-side changes once,
- colliding two-side changes as `remote` hunk lines followed by `local` hunk lines.
Normalize `\r\n` to `\n` before splitting; handle empty string `''` as `[]` lines so `mergeThreeWayKeepBoth('', 'a', 'b')` produces `'a\nb'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/merge.test.ts`
Expected: PASS (all 5 tests).

---

### Task 2: Integrate Keep-Both Auto-Merge into `SyncEngine` (`src/sync/engine.ts`)

**Files:**
- Modify: `src/sync/engine.ts:1-10,225-245,397-432`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `mergeThreeWayKeepBoth(base: string, remote: string, local: string): string` from `./merge`
- Modifies: `SyncEngine` private method `resolveAutoMergeConflicts(plan: SyncPlan, headSha: string, remoteTextFiles: Record<string, string>, localContents: Record<string, string>, localHashes: LocalFileSnapshot): Promise<void>`

- [ ] **Step 1: Write failing integration tests in `tests/engine.test.ts`**

Add tests covering:
1. Non-overlapping & colliding edits on a tracked file both auto-merge via `mergeThreeWayKeepBoth`, write merged content to vault, push to `main` (`createCommit` called with `branch: 'main'`, no `startSha`), and leave `res.conflictBranch === null`.
2. Both sides creating an untracked file merges with empty base (`remote\nlocal`) and pushes to `main`.
3. One side edits while the other deletes:
   - Remote edited + Local deleted -> restores Remote file to disk (`res.pulled >= 1`, `res.conflictBranch === null`).
   - Local edited + Remote deleted -> pushes Local file to `main` (`res.pushed >= 1`, `res.conflictBranch === null`).
4. Base fetch failure (`getRawText` throws 404 on `lastSyncedCommitSha`) -> falls back safely to `mobile-conflict/...` branch.
5. Update existing `pushes conflicts to mobile-conflict branch and keeps local edits on disk` test expectation ONLY if needed — verify first: in that test `getRawText` returns `undefined`, so fallback should keep it passing unchanged!

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx vitest run tests/engine.test.ts`
Expected: New auto-merge tests FAIL because `SyncEngine` still creates `mobile-conflict/...`.

- [ ] **Step 3: Implement `resolveAutoMergeConflicts` in `src/sync/engine.ts`**

- Import `mergeThreeWayKeepBoth` from `./merge`.
- In `SyncEngine.sync()`, right after `resolveConvergedConflicts(...)`, if `plan.conflicts.length > 0 && !this.state.activeConflictBranch`, call `await this.resolveAutoMergeConflicts(plan, headSha, remoteTextFiles, localContents, localHashes)`.
- Inside `resolveAutoMergeConflicts`:
  - For each `path` in `plan.conflicts`:
    - If `remoteTextFiles[path] === undefined && localContents[path] !== undefined` (Local edited, Remote deleted): mark resolved (keep in `plan.pushUpdates`, remove from `plan.conflicts`).
    - If `remoteTextFiles[path] !== undefined && localContents[path] === undefined` (Remote edited, Local deleted): remove from `plan.conflicts` and `plan.pushDeletes`, add to `plan.pullDownloads`.
    - If both `remoteTextFiles[path] !== undefined` and `localContents[path] !== undefined`:
      - Fetch `remoteText = await this.client.getRawText(path, headSha)` inside `try/catch`; if not a string, leave in `plan.conflicts` (fallback).
      - If `this.state.files[path]` exists: if `!this.state.lastSyncedCommitSha`, leave in `plan.conflicts`; else fetch `baseText = await this.client.getRawText(path, this.state.lastSyncedCommitSha)` inside `try/catch`; if not a string, leave in `plan.conflicts`.
      - If `!this.state.files[path]`: `baseText = ''`.
      - Compute `merged = mergeThreeWayKeepBoth(baseText, remoteText, localContents[path])`.
      - Write `merged` via `await this.vault.writeText(path, merged)`, update `localContents[path] = merged` and `localHashes[path] = await sha256Hex(merged)`.
      - Remove `path` from `plan.conflicts`.
      - If `merged === remoteText`: remove `path` from `plan.pushCreates` and `plan.pushUpdates`, and update `this.state.files[path] = { blobSha: remoteTextFiles[path], contentHash: localHashes[path] }`.
  - Recompute `plan.hasConflict = plan.conflicts.length > 0` and `plan.targetPushBranch = plan.hasConflict ? 'conflict' : 'target'`.

- [ ] **Step 4: Run full verification suite**

Run: `npm test && npm run build && npm run lint`
Expected: All tests pass, `tsc --noEmit` + `esbuild` succeed, and `eslint src --max-warnings=0` exits with 0 warnings/errors.
