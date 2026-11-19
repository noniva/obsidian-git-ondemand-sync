# Design: Unpushed File Count & Remote Pull Indicator

**Date:** 2026-11-19  
**Status:** Draft (awaiting CEO approval)

---

## 1. Intent & Why

Instead of silent periodic auto-syncing (which risks unwanted commits and API rate-limit usage), users should see at a glance on both Desktop and Mobile when they have:
1. Local text changes that have not been pushed (`unpushedCount`).
2. New commits waiting on the remote branch (`hasRemoteUpdates`).

This keeps syncing explicitly On-Demand while preventing forgotten pushes or editing stale notes across devices.

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **Local Unpushed Count (Zero API Calls):**
  - On `onLayoutReady`, asynchronously scan allowlisted local text files and compare against `syncState.files` (deleted tracked files, new untracked files, or modified files whose `sha256Hex` differs) to populate a dirty-path `Set<string>`.
  - Listen to `vault.on('create' | 'modify' | 'delete' | 'rename')` via `this.registerEvent(...)` and incrementally re-evaluate affected allowlisted paths (debounced ~400ms) to keep `unpushedCount` accurate.
- **Remote Pull-Available Indicator (1 API Call on Open / Resume):**
  - Check `client.getBranchHead(settings.branch)` and set `hasRemoteUpdates = (headSha !== syncState.lastSyncedCommitSha)` when `lastSyncedCommitSha !== null`, `token` and `projectId` are configured, and `isEnabled()` is true.
  - Trigger on `onLayoutReady` and when the app/window regains visibility/focus (`document` `visibilitychange` when `visible`, and `window` `focus`), guarded by a **60-second cooldown** and skipped while `isSyncing` is true.
- **Desktop & Mobile UI:**
  - **Ribbon Icon (`ribbonEl`):** Render a compact badge showing `unpushedCount` when `> 0`, a pull-available visual indicator when `hasRemoteUpdates` is true, and an updated `aria-label` / tooltip summarizing pending push/pull status.
  - **Status Bar (`statusBarEl`, Desktop):** Display concise text reflecting pending push/pull state (e.g., `Git: 3 to push`, `Git: Pull available`, `Git: 3 to push, Pull available`, or `Git: Synced` / `Git: Idle` / `Git: Conflict`).
- **Post-Sync Reconciliation:**
  - Recompute/clear dirty paths and `hasRemoteUpdates` right after `syncWithNotice()` and `clearConflictState()` succeed.

### Non-Goals
- Automatic background commits or interval-based polling.
- Showing exact count of remote files waiting to be pulled (only boolean `hasRemoteUpdates` from `getBranchHead`).

### Anti-Goals
- Calling `getTreeRecursive` on focus/resume.
- Showing error `Notice` popups when background `getBranchHead` fails offline (silent no-op on background check errors).
- Blocking `onload()` or typing with synchronous full-vault hashing.

## 3. Constraints

- `minAppVersion` remains `"1.4.0"`; `obsidian` devDependency remains `"^1.7.2"`.
- Must pass `npm run lint` (`eslint src --max-warnings=0`), `npx vitest run`, and `npx tsc --noEmit`.
- Zero raw Unicode emojis in code, UI labels, notices, or CSS content.
- Register all DOM/vault listeners via `this.registerEvent` / `this.registerDomEvent` and clear pending debounce timers in `onunload()`.

## 4. Approaches Considered

### Approach A (Selected): Dirty-Path Tracker + Single `getBranchHead` Check on Open/Resume
- Tracks local unpushed files offline via `syncState.files` + vault events, and checks remote updates with a single `getBranchHead` call on open and app resume (with 60s cooldown).
- *Trade-off:* Minimal battery, network, and API rate-limit impact; shows boolean pull-available status rather than exact remote file count.

### Approach B (Rejected): Full `getTreeRecursive` Scan on Open/Resume
- Fetches the full repository tree on open/resume to compute exact remote pull counts.
- *Trade-off:* Excessive API calls, bandwidth, and mobile battery drain on larger repositories.

## 5. Left to Implementation Plan / Builder

- Clean helper abstraction (`src/sync/status.ts` or methods in `src/main.ts`) for computing dirty local paths and managing debounce/cooldown state.
- CSS styling in `styles.css` for the Ribbon numeric badge and pull-available dot/indicator.
- Unit tests in `tests/` covering dirty-path detection (create/modify/delete/rename), `getBranchHead` cooldown + offline error suppression, and Ribbon/Status Bar updates.
