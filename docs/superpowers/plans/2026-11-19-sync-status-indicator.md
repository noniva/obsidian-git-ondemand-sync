# Unpushed File Count & Remote Pull Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live count of unpushed local text files and a remote pull-available indicator on both the Obsidian Ribbon icon (Mobile + Desktop) and Desktop Status Bar without background auto-committing.

**Architecture:** Extract a pure, testable `SyncStatusTracker` in `src/sync/status.ts` that maintains a `dirtyPaths` `Set<string>` from `syncState.files` + debounced vault events and checks `getBranchHead` on open/resume with a 60s cooldown. Wire it into `GitLabOnDemandSyncPlugin` (`src/main.ts`) and style the Ribbon badge and pull dot in `styles.css`.

**Tech Stack:** TypeScript 5.6, Vitest (`happy-dom`), esbuild, `eslint` (`eslint-plugin-obsidianmd`).

**Spec:** [2026-11-19-sync-status-indicator-design.md](docs/superpowers/specs/2026-11-19-sync-status-indicator-design.md)

## Global Constraints

- `manifest.json` `minAppVersion` MUST remain `"1.4.0"`.
- Zero raw Unicode emojis in code, UI labels, notices, or CSS.
- Must pass `npm run lint` (`eslint src --max-warnings=0`), `npx vitest run`, `npx tsc --noEmit`, and `node esbuild.config.mjs production`.
- Use `window.setTimeout` / `window.clearTimeout` and `createSpan` (no `globalThis`, no `document.createElement`, no static `.style.*`).

## Review Focus

- Initial `scanDirtyPaths()` must mark locally deleted files that still exist in `state.files` as dirty (included in `unpushedCount`).
- `handleRename(oldPath, newPath)` must re-evaluate both `oldPath` and `newPath` so renaming a dirty or tracked file updates `unpushedCount` accurately.
- `checkRemoteUpdates()` must never throw or show a `Notice` when offline or rate-limited; it must respect the 60-second cooldown and skip when `isSyncing` is true or `lastSyncedCommitSha === null`.
- `onunload()` must clear any pending debounce timer via `statusTracker.dispose()`.
- Ribbon badge and pull dot must be created with Obsidian `createSpan` and styled via CSS classes in `styles.css`.

---

### Task 1: `SyncStatusTracker` (`src/sync/status.ts`) + Unit Tests

**Files:**
- Create: `src/sync/status.ts`
- Create: `tests/sync-status.test.ts`

**Interfaces:**
- Produces: `SyncStatusSummary { unpushedCount: number; hasRemoteUpdates: boolean }` and `class SyncStatusTracker` with `scanDirtyPaths()`, `schedulePathRefresh(path)`, `handleRename(oldPath, newPath)`, `checkRemoteUpdates(force?: boolean)`, `resetAfterSync()`, `getSummary()`, `dispose()`.

- [ ] **Step 1: Write failing tests in `tests/sync-status.test.ts`**

Test cases:
1. `scanDirtyPaths` counts new untracked files, modified files (different hash), and locally deleted tracked files, while ignoring non-allowlisted / ignored paths.
2. `schedulePathRefresh` debounces edits (~400ms) and updates `unpushedCount` when a file becomes dirty or reverts back to its synced hash; `handleRename` updates both old and new paths.
3. `checkRemoteUpdates` sets `hasRemoteUpdates = true` when `getBranchHead` differs from `lastSyncedCommitSha`, enforces 60s cooldown unless `force = true`, and swallows network errors silently.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync-status.test.ts`
Expected: FAIL because `src/sync/status.ts` does not exist.

- [ ] **Step 3: Implement `SyncStatusTracker` in `src/sync/status.ts`**

Implement `SyncStatusTracker` using injected `vault`, `getBranchHead`, `getState`, `getSettings`, `getConfigDir`, `isEnabled`, `isSyncing`, `onChange`, `now`, and `window.setTimeout` / `window.clearTimeout` (400ms debounce, 60_000ms remote check cooldown).

- [ ] **Step 4: Run test and lint to verify they pass**

Run: `npx vitest run tests/sync-status.test.ts; npm run lint`
Expected: PASS and 0 lint warnings/errors.

- [ ] **Step 5: Commit**

```bash
git add src/sync/status.ts tests/sync-status.test.ts
git commit -m "feat: add SyncStatusTracker for unpushed file count and remote pull check"
```

---

### Task 2: Wire Ribbon Badge, Status Bar & Vault/Resume Listeners (`src/main.ts`, `styles.css`, `tests/main.test.ts`)

**Files:**
- Modify: `src/main.ts`
- Modify: `styles.css`
- Modify: `tests/main.test.ts`

**Interfaces:**
- Consumes: `SyncStatusTracker` from `src/sync/status.ts`.
- Produces: Live Ribbon badge + pull dot + Desktop Status Bar indicator wired to vault events, `visibilitychange`/`focus`, `syncWithNotice()`, and `clearConflictState()`.

- [ ] **Step 1: Add failing tests in `tests/main.test.ts`**

Test that `GitLabOnDemandSyncPlugin` updates the Ribbon badge (`unpushedCount`), pull indicator class (`.gitlab-ribbon-has-pull`), `aria-label`, and status bar text on layout ready / vault events / remote head mismatch, and resets after `syncWithNotice()`.

- [ ] **Step 2: Run `tests/main.test.ts` to verify new test fails**

Run: `npx vitest run tests/main.test.ts`
Expected: FAIL on missing badge/indicator assertions.

- [ ] **Step 3: Wire `SyncStatusTracker`, Ribbon badge/dot, Status Bar, and event listeners in `src/main.ts` + styles in `styles.css`**

- Capture `this.ribbonEl = this.addRibbonIcon(...)` and attach `.gitlab-ribbon-badge` + `.gitlab-ribbon-pull-dot` via `createSpan`.
- Register `vault.on('create' | 'modify' | 'delete' | 'rename')` via `this.registerEvent(...)`.
- Register `document` `visibilitychange` and `window` `focus` via `this.registerDomEvent(...)`.
- Reconcile status after `syncWithNotice()` and `clearConflictState()`, and call `this.statusTracker?.dispose()` in `onunload()`.
- Add CSS classes in `styles.css`.

- [ ] **Step 4: Run tests and lint**

Run: `npx vitest run tests/main.test.ts; npm run lint`
Expected: PASS and 0 lint warnings/errors.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts styles.css tests/main.test.ts
git commit -m "feat: display unpushed file badge and remote pull indicator on ribbon and status bar"
```

---

### Task 3: Full Verification & Test Vault Deploy

**Files:**
- Deploy: `D:\Obsidian\TestPlugin\.obsidian\plugins\gitlab-ondemand-sync\`

- [ ] **Step 1: Run full verification suite**

Run: `npm run lint; npx vitest run; npx tsc --noEmit; node esbuild.config.mjs production; node -c main.js`
Expected: All exit 0 with 0 lint errors/warnings.

- [ ] **Step 2: Deploy `main.js`, `manifest.json`, `styles.css` to `D:\Obsidian\TestPlugin\.obsidian\plugins\gitlab-ondemand-sync\` (without touching `data.json`)**
