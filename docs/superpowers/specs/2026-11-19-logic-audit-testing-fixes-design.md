# Design Doc: Logic Audit, End-to-End Testing & Bug Fixes

**Date:** 2026-11-19
**Status:** Ready for Approval (Builder Check passed)

---

## 1. Intent & Why

The initial implementation of the **Obsidian GitLab On-Demand Sync** plugin passed 55 isolated unit tests, but the user has not yet installed it on real Obsidian and requested a thorough logic recheck, comprehensive test plan, and bug fixes before real usage.

A deep audit across all 10 source files (`src/`), `styles.css`, `manifest.json`, and `tests/` revealed critical end-to-end logic gaps that isolated mocks missed—most notably an infinite conflict loop after a real Desktop 3-way merge, incremental pull/push race risks, editor/Live Preview bugs, and 0% test coverage across the 4 Obsidian UI/wiring modules (`reading-view.ts`, `live-preview.ts`, `settings.ts`, `main.ts`).

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Fix all confirmed bugs across sync/conflict recovery, Live Preview, Reading View, mobile image paste/drop/camera upload, path parsing, image loader, GitLab client, settings, and plugin wiring.
- Build a **Stateful Fake-GitLab Integration Test Harness** (`tests/helpers/fake-gitlab.ts` + `tests/integration/sync-lifecycle.test.ts`) to exercise full Desktop + Mobile workflows without touching a live repository.
- Add DOM and CodeMirror 6 tests using `happy-dom` covering the 4 untested UI/wiring files (`reading-view.ts`, `live-preview.ts`, `settings.ts`, `main.ts`), reaching 10/10 module coverage.
- Create a concise manual pre-flight verification checklist (`docs/manual-test-checklist.md`) for final smoke testing on real Obsidian Desktop + Mobile + private GitLab.
- Comply with applicable **Sandy PM 6 Native Quality Gates**:
  - **Gate 1 (Task & Process Cleanliness):** Zero lingering background tasks/processes.
  - **Gate 2 (Code Integrity & Security):** Syntax verification (`node -c main.js`), strict `tsc --noEmit`, and security-hardened `.gitignore` (`.env`, `.secret/`, `node_modules/`).
  - **Gate 3 (Network, Encoding & Error Boundaries):** Explicit HTTP request timeout guard (30s default, injectable for tests) and error cause preservation (`Error(..., { cause })`).
  - **Gate 4 (UI & Brand Compliance):** Zero raw Unicode emojis anywhere in plugin UI, `Notice` messages, or status logs; version label adheres to `<= 1.0` (`0.1.0`).

### Non-Goals
- Changing v1 scope (remains private GitLab REST API only; no GitHub/Gitea/SSH; no offline image disk caching; no replacement of Desktop Obsidian Git).
- Requiring live GitLab network access or personal access tokens during automated `npm test` runs.
- Adding web server / dual-database / multimedia features unrelated to an Obsidian client plugin.

### Anti-Goals
- **Never** write viewed or pasted images to mobile disk (`vault.adapter.writeBinary` remains forbidden).
- **Never** silently overwrite concurrent Desktop commits on `targetBranch`.
- **Never** silently discard Mobile edits made *after* a conflict branch push when clearing conflict state.
- **Never** emit raw Unicode emojis in plugin UI, notices, or logs.

---

## 3. Constraints

- Preserve all constraints from [2026-11-19-gitlab-ondemand-sync-design.md](file:///D:/Process/Osidian-plugin-imgLazyLoad/docs/superpowers/specs/2026-11-19-gitlab-ondemand-sync-design.md).
- `src/` must remain free of Node-only runtime imports (`node:*`, `Buffer`, `fs`) so the bundle runs inside Obsidian Mobile WebView.
- Existing `manifest.json` metadata (`"isDesktopOnly": false`, `"version": "0.1.0"`) stays intact.
- Verification commands `npx vitest run`, `npx tsc --noEmit`, `node esbuild.config.mjs`, and `node -c main.js` must all exit 0 cleanly.

---

## 4. Approaches Considered

1. **Approach 1 (Chosen): Stateful Fake-GitLab Integration Harness + `happy-dom` UI/CM6 Tests + Fix All Confirmed Bugs + Manual Pre-Flight Checklist**
   - *How:* Implement a stateful in-memory GitLab API simulator supporting branches, commits, `start_sha`, paginated trees, Desktop 3-way merges, branch deletion, and fault/race injection. Add `happy-dom` tests for `reading-view.ts`, `live-preview.ts`, `settings.ts`, and `main.ts`. Fix all 5 groups of confirmed logic defects via TDD.
   - *Trade-offs:* Takes slightly more test-harness work upfront than Approach 2, and still needs one final smoke check on real Obsidian Mobile; in return, it exercises full cross-module integration and UI behavior offline and deterministically.

2. **Approach 2: Targeted Bug Fixes + Expand Existing Mocked Unit Tests Only**
   - *How:* Patch bugs and add isolated unit tests in existing test files without a stateful simulator or DOM tests.
   - *Trade-offs:* Faster, zero new devDependencies, but leaves 4 UI/wiring modules at 0% coverage and cannot catch multi-step Desktop-merge / conflict-recovery bugs.

3. **Approach 3: Live Sandbox Testing Against a Real Private GitLab Repo**
   - *How:* Fix bugs and execute an API script against a throwaway private GitLab repository.
   - *Trade-offs:* Verifies real GitLab HTTP headers/status codes, but requires internet + dedicated PAT/repo and cannot test Obsidian DOM/CM6 rendering. Better kept as an optional manual verification step (`docs/manual-test-checklist.md`) after Approach 1.

**Why Approach 1:** The user wants high confidence in end-to-end logic before installing on real Obsidian. Approach 1 closes both the multi-step state-machine testing gap and the 4-file UI/wiring coverage gap deterministically offline.

---

## 5. Confirmed Defects & Target Designs

*(Decision attribution: The user chose Approach 1 to audit and test all end-to-end logic before real usage. Architectural details below are proposed technical calls aligned with the original v1 spec unless otherwise noted.)*

### 5.1 Desktop 3-Way Merge Conflict Recovery (`src/types.ts`, `src/sync/engine.ts`, `src/settings.ts`)
- **Problem:** After a real Desktop 3-way merge produces merged content (different from Mobile's edit), `SyncEngine.clearConflictBranch()` only updates `state.files[path]` if remote text hashes identically to Mobile's local file. Merged files remain stale in `state.files`, causing the next `sync()` to enter an infinite conflict loop. Additionally, if GitLab deletes `mobile-conflict/...` upon MR merge before the user clicks "Clear Conflict State", `SyncEngine.sync()` fails with an unhandled 404.
- **Design (Our call):**
  - Extend `SyncState` in `src/types.ts` with optional fields:
    - `conflictPushedHashes?: Record<string, string>` (records `sha256Hex` of each file Mobile pushed to `activeConflictBranch`)
    - `conflictDeletedPaths?: string[]` (records paths deleted on Mobile and pushed to `activeConflictBranch`)
  - Populate/update `conflictPushedHashes` and `conflictDeletedPaths` whenever `SyncEngine` creates or pushes to `activeConflictBranch`.
  - Update `SyncEngine.clearConflictBranch()`:
    1. Fetch `targetBranch` head SHA and recursive tree, plus scan local allowlisted text files and compute `localHashes`.
    2. Pre-fetch remote text for files present on `targetBranch` where `localHash !== undefined` or where the path was untouched/pushed on the conflict branch so no disk writes happen before network calls succeed.
    3. For each file on `targetBranch`:
       - If Mobile did **not** modify the file after its last conflict push (`localHash === undefined` when in `conflictDeletedPaths`, or `localHash === conflictPushedHashes[path]`, or `localHash === state.files[path]?.contentHash`), pull and write `targetBranch`'s merged content to Mobile vault and update `state.files[path]` to `{ blobSha: entry.id, contentHash: remoteHash }`.
       - If Mobile **did** modify the file locally *after* pushing to the conflict branch (`localHash !== conflictPushedHashes[path]` and `localHash !== state.files[path]?.contentHash`), keep Mobile's newer local edit on disk and set `state.files[path]` to `targetBranch`'s baseline `{ blobSha: entry.id, contentHash: remoteHash }` so the next `sync()` pushes Mobile's newer edit cleanly to `targetBranch` without looping.
    4. For tracked or `conflictPushedHashes` files deleted on `targetBranch` during Desktop merge (absent from remote tree): if Mobile did not edit them further (`localHash === conflictPushedHashes[path]` or `localHash === state.files[path]?.contentHash`), delete them locally and remove from `state.files`; if Mobile edited them further, delete `state.files[path]` so the next `sync()` pushes the local file as a clean create.
    5. Only after all network fetches and vault updates succeed: set `state.activeConflictBranch = null`, clear `conflictPushedHashes` and `conflictDeletedPaths`, set `state.lastSyncedCommitSha = headSha`, and `await saveState()`.
  - Update `SyncEngine.sync()`: if `getBranchHead(this.state.activeConflictBranch)` throws a 404/not-found error (e.g., MR merged and branch deleted on GitLab), throw a descriptive error instructing the user to open Settings and click "Clear Conflict State" to adopt the merged target branch state (without wiping Mobile edits silently).

### 5.2 Sync Engine Safety (`src/sync/engine.ts`)
- **Problem 1 (Incremental pull partial failure):** Non-initial incremental pulls currently download and write files one by one, calling `saveState()` only at the end of `applyPulls()`. If file #3 fails to download after files #1–2 were written, disk and `state.files` diverge, causing false conflicts next sync.
  - **Fix (Our call):** Download all `plan.pullDownloads` into an in-memory `Map<string, string>` *before* performing any disk writes/deletes on **both** initial and incremental pulls. Wrap the local disk apply phase (`writeText` + `deleteFile` + `state.files` updates) in `try/finally` so if any disk operation fails mid-apply, `saveState()` still persists the files that were written/deleted.
- **Problem 2 (TOCTOU target-branch push race):** Desktop may push a commit to `targetBranch` in the window between `getBranchHead` at sync start and `createCommit` at sync end, causing Mobile to overwrite Desktop's commit.
  - **Fix (Our call):** Right before `createCommit` when `plan.targetPushBranch === 'target'`, re-fetch `latestHead = await this.client.getBranchHead(this.settings.branch)`. If `latestHead !== headSha`, abort the target commit cleanly and throw a clear retry error (noting `saveState()` already persisted any pulls), so the user can re-run `sync()` against the new head without overwriting Desktop work.
- **Problem 3 (Redundant image merge call):** Remove the redundant `this.mergeRemoteImagePaths(this.state.remoteImagePaths, initialRemoteImages)` call after pulls; update `remoteImagePaths` cleanly while preserving images pasted concurrently during the async sync window.

### 5.3 Live Preview & Reading View (`src/images/live-preview.ts`, `src/images/reading-view.ts`, `src/utils/paths.ts`, `src/main.ts`)
- **Problem:**
  1. Live Preview regex matches `![[img.png]]` / `![alt](img.png)` inside fenced code blocks and inline code spans.
  2. Live Preview regex `([^)\s]+)` cuts off filenames containing parentheses like `photo(1).png`.
  3. Live Preview drops `alt` text on wikilinks like `![[sub/img.png|caption|300]]`.
  4. Already-open notes in Live Preview do not refresh decorations when background/manual sync or image paste updates `remoteImagePaths`.
- **Design (Our call):**
  - Extend `parseImageEmbed(rawTarget)` in `src/utils/paths.ts` to return `{ target: string; alt?: string; width?: number } | null`, cleanly parsing multi-pipe wikilinks (`img.png|caption|300` -> `alt: 'caption', width: 300`; `img.png|300` -> `width: 300`; `img.png|caption` -> `alt: 'caption'`), and share this between Reading View and Live Preview.
  - In `src/images/live-preview.ts`:
    - Check `@codemirror/language` `syntaxTree(view.state)` (via helper testing node type names containing `codeblock`, `hmd-codeblock`, `inline-code`, or `HyperMD-codeblock`) and skip matches inside code contexts.
    - Replace `([^)\s]+)` with balanced-parenthesis matching (supporting single-level nested `(...)` in un-angled Markdown paths like `![alt](folder/pic(1).png)`).
    - Pass parsed `alt` (from `parseImageEmbed` for wikilinks and `parseMarkdownAlt` for Markdown links) to `RemoteImageWidget`.
    - Export `refreshRemoteImagesEffect = StateEffect.define<void>()` and trigger `buildDecorations` in `ViewPlugin.update` whenever a transaction carries `refreshRemoteImagesEffect`.
  - In `src/main.ts`: After `syncWithNotice()` completes (and after paste upload succeeds, if needed), iterate Markdown leaves and dispatch `refreshRemoteImagesEffect.of(undefined)` to active CodeMirror `EditorView` instances (and trigger markdown view preview rerenders where supported).

### 5.4 Mobile Image Paste / Drop / Camera Upload (`src/images/paste-upload.ts`)
- **Problem:**
  1. `extractImageFiles` checks only `file.type.startsWith('image/')`, missing dropped image files where the OS/WebView leaves `file.type` empty despite an image filename extension.
  2. `editor.replaceSelection` runs *after* `await uploadPastedImage`, so moving the cursor during a slow upload inserts `![[...]]` at the wrong place.
  3. `handleVaultImageCreate` calls `editor.setValue(...)`, wiping the editor's undo stack, scroll position, and selection.
- **Design (Our call):**
  - In `extractImageFiles`: accept `file.type.toLowerCase().startsWith('image/') || isImagePath(file.name)`, inferring fallback MIME type from `file.name` when `file.type` is empty.
  - In `handleImageTransfer`: before awaiting upload, insert a unique temporary marker (e.g., `<!-- uploading-gitlab-image-<id> -->`) at the selection (or batch marker), capture line/offset, upload each image sequentially, and replace ONLY the marker range via `editor.replaceRange(replacement, from, to)` (or delete the marker range on failure before showing `Notice`).
  - In `handleVaultImageCreate`: locate the exact range of `![[file.path]]` or `![[file.name]]` (or `![...](file.path)` / percent-encoded equivalent) in `editor.getValue()`, convert indices via `editor.offsetToPos`, and call `editor.replaceRange(result.wikilink, fromPos, toPos)` instead of `editor.setValue(...)`.

### 5.5 Path Parsing, Loader, GitLab Client, Settings & Main Polish
- **`src/utils/paths.ts`:**
  - In `parseImageEmbed`: reject protocol-relative external URLs (`pathWithoutFragment.startsWith('//')`) as `null`.
  - Avoid double-decoding `%2520`: decode `%`-sequences at most once across `parseImageEmbed` + `resolveRemoteImagePath` (add an option or pass raw decoded flag / normalize safely so `parseImageEmbed` + `resolveRemoteImagePath` preserves literal `%20` filenames when encoded as `%2520`).
  - `isIgnoredPath(path, syncObsidianDir, configDir = '.obsidian')`: respect custom `configDir` while still ignoring all other dot-prefixed segments.
- **`src/images/loader.ts`:**
  - Guard `maxConcurrent`: `Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : 3`.
  - Add bounded LRU cache (default `maxMemoryImages = 20`) to `memoryImages`: on `registerMemoryImage` (and `get` refresh), move key to most-recent; if size exceeds limit, evict oldest entry and call `revokeUrl`.
- **`src/gitlab/client.ts`:**
  - Add `seenPages = new Set<string>()` guard in `getTreeRecursive` to throw if the server repeats a page number (preventing infinite loops).
  - Add configurable `timeoutMs` (default `30_000`) wrapping `requestFn` with a timeout race (clearing timer in `finally`) and chaining underlying error causes (`new Error(..., { cause: err })`) per Sandy Gate 3.
- **`src/settings.ts`:**
  - Allow empty `attachmentFolder` (`value.trim()` stored directly, even `""` for vault root; default `'attachments'` only when uninitialized in `DEFAULT_SETTINGS`).
  - Debounce text-input `saveAndRefreshSettings()` calls by `300ms` (flushing or clearing on `hide()`); keep toggles and the "Clear Conflict State" button immediate.
- **`src/main.ts`:**
  - Remove duplicate `DEFAULT_SYNC_STATE` constant (use `createDefaultSyncState()`).
  - Pass `this.app.vault.configDir || '.obsidian'` to `isIgnoredPath`.
  - On `onLayoutReady`, if `isEnabled()` and `this.syncState.activeConflictBranch` is set, show a clean startup `Notice` (zero raw emojis) reminding the user of the open conflict branch.

---

## 6. Testing Strategy (Approach 1)

1. **Stateful Fake-GitLab Simulator (`tests/helpers/fake-gitlab.ts`):**
   - Simulates private GitLab repository state in memory: branches (`main`, `mobile-conflict/...`), commit graph, tree entries with deterministic blob SHAs, paginated `getTreeRecursive`, `getRawText`/`getRawBinary`, `createCommit` with `start_sha` + `actions`, Desktop 3-way merge helper, branch deletion, and fault/race hooks (mid-pull failure, concurrent commit injection, 404 on deleted branch).
2. **End-to-End Lifecycle Integration Tests (`tests/integration/sync-lifecycle.test.ts`):**
   - Initial empty vault sync -> Desktop edits + Mobile edits -> conflict pushed to `mobile-conflict/...` -> Desktop performs 3-way merge -> GitLab deletes conflict branch -> Mobile sync 404 prompts Clear Conflict -> user calls `clearConflictBranch()` (adopting merged files while keeping any post-conflict-push Mobile edits!) -> subsequent clean `sync()` converges with zero conflict loop.
   - Partial incremental pull failure leaving disk & `SyncState` consistent.
   - TOCTOU concurrent Desktop commit detection before `createCommit`.
   - Image lifecycle: paste upload -> sync preserves image -> Reading View / loader fetches on demand with zero `writeBinary` calls.
3. **DOM & CM6 UI/Wiring Tests (`tests/reading-view.test.ts`, `tests/live-preview.test.ts`, `tests/settings.test.ts`, `tests/main.test.ts`):**
   - Use `happy-dom` (per-file `// @vitest-environment happy-dom` pragma) and enhanced Obsidian mocks (`tests/__mocks__/obsidian.ts`) to test all 4 previously untested modules:
     - `reading-view.ts`: `.internal-embed` and `<img>` replacement, `src` removal, multi-pipe alt/width, `MarkdownRenderChild` cleanup, `isLocalFilePresent` bypass, disabled bypass.
     - `live-preview.ts`: CM6 `EditorView` decoration replacement, cursor-overlap reveal, code-block/inline-code exclusion, `photo(1).png` parentheses, `refreshRemoteImagesEffect` refresh, `destroy()` cleanup.
     - `settings.ts`: empty `attachmentFolder`, debounced text saves, immediate toggles, `Clear Conflict State` button enabled/disabled & error handling.
     - `main.ts`: `Platform.isMobile` vs `enableOnDesktop` gating, `loadPluginData` defaults, `VaultTextAdapter` (custom `configDir`, dot-folders), `syncWithNotice` (zero raw emojis), `onunload` `revokeAll()`.
4. **Expanded Edge-Case Unit Tests:**
   - Update `tests/paths.test.ts`, `tests/client.test.ts`, `tests/loader.test.ts`, `tests/paste-upload.test.ts` for all new edge cases (protocol-relative URLs, `%2520` non-double-decoding, pagination loop guard, request timeout, `NaN` concurrency, memory image LRU eviction, empty-MIME drop, placeholder paste preservation, targeted `replaceRange` on vault create).
5. **Manual Pre-Flight Checklist (`docs/manual-test-checklist.md`):**
   - Concise step-by-step smoke verification checklist for real Obsidian Desktop + Obsidian Mobile + a private GitLab repository before production vault usage.

---

## 7. What's Left to the Builder

- Installing `happy-dom` as a `devDependency` (only when implementing after plan approval) and configuring `tests/__mocks__/obsidian.ts` / `@vitest-environment happy-dom` pragmas cleanly so existing Node/Vitest tests remain fast.
- Passing optional `configDir` via `SyncEngineOptions` (`Our call`) so `SyncEngine` matches `VaultTextAdapter` when Obsidian uses a non-default `.obsidian` directory.
- Ensuring `undefined` guards in `clearConflictBranch()` (`Our call`) so brand-new remote-only files on `targetBranch` are pulled cleanly rather than skipped or misclassified as local deletions.
- Enabling `ES2022.Error` in `tsconfig.json` `lib` (or assigning `.cause` compatibly) (`Our call`) so `tsc --noEmit` compiles error cause chaining cleanly.
- Exact CM6 `syntaxTree` helper implementation and `EditorView` access pattern in `main.ts` (`(view.editor as { cm?: EditorView }).cm`).
- Exact debounce timer cleanup in `GitLabSyncSettingTab.hide()`.
- Exact task/commit breakdown during `writing-plans`.
