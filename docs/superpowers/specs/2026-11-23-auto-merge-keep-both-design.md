# Auto-Merge (Keep-Both 3-Way Line Merge) Design

**Date:** 2026-11-23
**Status:** Approved

## Intent & Why
When both mobile and desktop edit the same note, the current file-hash conflict check pushes mobile edits to a `mobile-conflict/...` branch, which desktop workflows do not surface automatically. The user wants mobile sync to automatically merge conflicting text files by keeping all lines from both sides ("รวมทุกบรรทัดไว้ไม่สนความถูกผิดเน้นครบ") and pushing directly to the target branch (`main`).

## Goals, Non-Goals, Anti-Goals
- **Goals:**
  - Auto-merge non-overlapping line edits cleanly via 3-way line merge.
  - On overlapping line collisions (or both sides creating the same path), keep both Remote and Local lines without `<<<<<<<` / `=======` / `>>>>>>>` conflict markers.
  - When one side edits a file and the other deletes it, preserve the edited version rather than deleting it.
  - Write the merged result to the local vault and push directly to the target branch (`main`) without creating a `mobile-conflict/...` branch.
- **Non-Goals:**
  - Removing `activeConflictBranch` / `clearConflictBranch` recovery support (keep intact for any pre-existing conflict branch or unreachable-base fallback).
  - Semantic/AST Markdown merging or interactive conflict UI.
- **Anti-Goals:**
  - Never silently drop lines edited on either side.
  - Never inject Git conflict markers (`<<<<<<<`) into Markdown notes.

## Constraints
- Zero new runtime dependencies (`package.json` has no runtime deps).
- Must pass `npm test`, `npm run build`, and `npm run lint` (`eslint src --max-warnings=0`).

## Approaches Considered
1. **3-Way Line Auto-Merge (Keep-Both on Collision) in `SyncEngine` (Chosen):** Uses `lastSyncedCommitSha` (base), `headSha` (remote), and local vault text to merge line-by-line, keeping Remote + Local lines on colliding hunks and preserving edited files over deletions. Self-contained on mobile with zero GitLab MR permissions or desktop setup required.
2. **Git Conflict Markers (`<<<<<<<`) in Vault Files:** Rejected because markers clutter Markdown notes and can accidentally be pushed to `main`.
3. **Desktop / GitLab MR Auto-Merge:** Rejected because it still depends on opening desktop or having MR/branch permissions.

## Design Summary
- Add `src/sync/merge.ts` exporting `mergeThreeWayKeepBoth(base: string, remote: string, local: string): string`:
  - Normalizes `\r\n` to `\n` for line diffing, preserving trailing newline behavior cleanly.
  - Computes LCS-based line hunks for `(base -> remote)` and `(base -> local)`.
  - Non-conflicting hunks apply the changed side; identical changes deduplicate; colliding hunks emit `remote` lines followed by `local` lines (no markers).
- In `SyncEngine.sync()` (`src/sync/engine.ts`), when `plan.conflicts.length > 0` and `!this.state.activeConflictBranch`:
  - After `resolveConvergedConflicts`, run `resolveAutoMergeConflicts(...)` for each remaining conflict:
    - **Both sides exist:** Fetch `remoteText` (`headSha`) and `baseText` (`lastSyncedCommitSha` if tracked, or `''` if untracked). If fetching fails (e.g. unreachable/404 base), leave the path in `plan.conflicts` to fall back safely to `mobile-conflict/...`. Otherwise compute `merged = mergeThreeWayKeepBoth(baseText, remoteText, localText)`, write `merged` to vault, update `localContents`/`localHashes`, remove from `plan.conflicts`, and if `merged === remoteText` treat as converged (update `state.files` without pushing).
    - **Remote edited, Local deleted:** Remove from `plan.conflicts` and `plan.pushDeletes`, add to `plan.pullDownloads` so Remote's edited file is restored locally.
    - **Local edited, Remote deleted:** Remove from `plan.conflicts` (stays in `plan.pushUpdates` so Local's edited file is pushed to `main`).
  - Recompute `plan.hasConflict` and `plan.targetPushBranch`.
