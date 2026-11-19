# Obsidian GitLab On-Demand Sync — Logic Audit, E2E Testing & Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all confirmed sync, conflict-recovery, Live Preview, Reading View, paste/upload, loader, client, and settings bugs, build a stateful fake-GitLab end-to-end integration test suite plus `happy-dom` UI/CM6 tests across all 10 source files, and ship a manual verification checklist before real Obsidian usage.

**Architecture:** We keep the existing zero-disk mobile image design (`GitLabClient` -> `SyncEngine` -> `OnDemandImageLoader` -> Reading View / CM6 Live Preview / Paste Upload) and fix root causes once across shared modules (`paths.ts`, `engine.ts`, `live-preview.ts`, `paste-upload.ts`, `client.ts`, `loader.ts`, `settings.ts`, `main.ts`) under Ponytail (`full`) smallest-complete-change discipline. A stateful in-memory fake GitLab simulator exercises real Desktop 3-way merge recovery and failure boundaries, while per-file `happy-dom` tests cover all 4 Obsidian UI/wiring modules.

**Tech Stack:** TypeScript, Obsidian Plugin API, CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/language`), esbuild, Vitest, `happy-dom`.

**Spec:** `docs/superpowers/specs/2026-11-19-logic-audit-testing-fixes-design.md`

## Global Constraints

- Zero persistent image storage on mobile: never call `vault.adapter.writeBinary` for viewed or pasted images.
- Zero `.git` or `isomorphic-git` packfiles on mobile; all remote operations use GitLab REST API via Obsidian `requestUrl`.
- Keep `src/` free of Node-only runtime imports (`node:*`, `Buffer`, `fs`) so the bundle runs inside Obsidian Mobile WebView.
- Never silently overwrite concurrent Desktop commits on `targetBranch` or silently discard Mobile edits made after the last conflict push.
- Zero raw Unicode emojis in plugin UI, `Notice` messages, or status logs; keep `manifest.json` `"isDesktopOnly": false` and `"version": "0.1.0"`.
- Apply `ponytail` (`full` mode) on every coding/review task: smallest complete change, zero speculative abstractions, check all callers, leave a small focused test for non-trivial logic, and end replies with 1-2 lines noting what was skipped/not checked and key risks.
- Pass `.agents/skills/sandy-pm/resources/mistakes/self_mistakes.md` or `research_mistakes.md` to subagents before they start; verify `npx vitest run`, `npx tsc --noEmit`, `node esbuild.config.mjs`, and `node -c main.js` exit 0 with zero lingering background tasks.

## Review Focus

1. Desktop 3-way merge produces a 3rd merged file content AND deletes `mobile-conflict/...` on GitLab -> `sync()` returns an actionable 404 message, `clearConflictBranch()` pulls merged content for untouched/conflict-pushed files while preserving any post-push mobile edits, and the next `sync()` runs cleanly with zero conflict loop (Task 2 & Task 5).
2. Mid-pull network drop during incremental pull OR concurrent Desktop push right before `createCommit` -> zero disk/`SyncState` divergence and zero silent Desktop overwrite (Task 2 & Task 5).
3. Live Preview embed syntax inside fenced code blocks / inline code, filenames with parentheses `photo(1).png`, protocol-relative `//example.com/a.png`, and `%2520` literal percent filenames -> code blocks untouched, `photo(1).png` renders, `//` ignored, no double-decode (Task 1, Task 3 & Task 6).
4. Slow async paste/drop upload when user taps elsewhere + `vault.on('create')` mobile camera picker + empty-MIME drop -> placeholder marker keeps exact insertion site (cleaned up on failure), `editor.replaceRange` preserves undo/cursor, empty-MIME image drop intercepted (Task 3).
5. Custom Obsidian `configDir`, empty `attachmentFolder: ""`, debounced settings flush on `hide()`, `NaN` concurrency, bounded `memoryImages` LRU eviction (20), and `GitLabClient` timeout/pagination loop guard -> all handled cleanly without hangs, leaks, or silent resets (Task 1, Task 4 & Task 6).

---

## File Structure

- Modify: `tsconfig.json` — add `"ES2022.Error"` to `compilerOptions.lib` for standard `Error(..., { cause })`.
- Modify: `package.json` — add `happy-dom` as `devDependency` (Task 6).
- Modify: `src/types.ts` — add `conflictPushedHashes` and `conflictDeletedPaths` to `SyncState`.
- Modify: `src/utils/paths.ts` — parse `{ target, alt, width }`, reject `//...`, prevent double-decoding `%2520`, support `configDir` in `isIgnoredPath`.
- Modify: `src/images/loader.ts` — `Number.isFinite` `maxConcurrent` guard and bounded LRU (`maxMemoryImages = 20`) eviction in `memoryImages`.
- Modify: `src/gitlab/client.ts` — `seenPages` pagination guard, injectable `timeoutMs` (default `30_000`), and error `{ cause }` chaining.
- Modify: `src/sync/engine.ts` — Desktop 3-way merge `clearConflictBranch()`, 404 conflict-branch message, unified in-memory pull + `try/finally` disk flush, TOCTOU `getBranchHead` push guard, optional `configDir`.
- Modify: `src/images/reading-view.ts` — shared `parseImageEmbed` `{ target, alt, width }`, `decodeTarget: false` on `resolveRemoteImagePath`.
- Modify: `src/images/live-preview.ts` — CM6 `syntaxTree` code exclusion, balanced-paren Markdown paths, wikilink `alt`, `refreshRemoteImagesEffect`, `decodeTarget: false`.
- Modify: `src/images/paste-upload.ts` — empty-MIME image drop detection, async placeholder marker range replacement, `editor.replaceRange` in `handleVaultImageCreate`, `configDir` & `onUploaded`.
- Modify: `src/settings.ts` — empty `attachmentFolder` support, 300ms text-input debounce + `hide()` flush.
- Modify: `src/main.ts` — remove duplicate `DEFAULT_SYNC_STATE`, pass `configDir`, `refreshOpenEditors()`, startup conflict `Notice` (zero raw emojis).
- Modify: `tests/__mocks__/obsidian.ts`, `tests/paths.test.ts`, `tests/loader.test.ts`, `tests/client.test.ts`, `tests/engine.test.ts`, `tests/paste-upload.test.ts`.
- Create: `tests/helpers/fake-gitlab.ts`, `tests/integration/sync-lifecycle.test.ts`, `tests/reading-view.test.ts`, `tests/live-preview.test.ts`, `tests/settings.test.ts`, `tests/main.test.ts`, `docs/manual-test-checklist.md`.

---

### Task 1: Path Parsing, Loader LRU/Bounds & GitLab Client Resilience

**Files:**
- Modify: `tsconfig.json`
- Modify: `src/utils/paths.ts`
- Modify: `src/images/loader.ts`
- Modify: `src/gitlab/client.ts`
- Test: `tests/paths.test.ts`
- Test: `tests/loader.test.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Produces in `src/utils/paths.ts`:
  - `isIgnoredPath(path: string, syncObsidianDir: boolean, configDir?: string): boolean` (`configDir` defaults to `'.obsidian'`)
  - `parseImageEmbed(rawTarget: string): { target: string; alt?: string; width?: number } | null`
  - `resolveRemoteImagePath(target: string, noteDir: string, remoteImagePaths: string[], options?: { decodeTarget?: boolean }): string | null`
- Produces in `src/images/loader.ts`:
  - `new OnDemandImageLoader(client, blobApi?: BlobUrlApi, maxConcurrent?: number, maxMemoryImages?: number)` (`maxMemoryImages` defaults to `20`)
- Produces in `src/gitlab/client.ts`:
  - `GitLabClientConfig`: `{ baseUrl: string; projectId: string; token: string; timeoutMs?: number }` (`timeoutMs` defaults to `30_000`)

- [ ] **Step 1: Write the failing tests in `tests/paths.test.ts`, `tests/loader.test.ts`, and `tests/client.test.ts`**

Update `tests/paths.test.ts` expectations for `{ target, alt, width }` and add edge-case assertions:
```ts
// In tests/paths.test.ts:
expect(parseImageEmbed('folder/img.png|300')).toEqual({ target: 'folder/img.png', alt: undefined, width: 300 });
expect(parseImageEmbed('img.png|300x200')).toEqual({ target: 'img.png', alt: undefined, width: 300 });
expect(parseImageEmbed('img.png|alt text')).toEqual({ target: 'img.png', alt: 'alt text', width: undefined });
expect(parseImageEmbed('img.png|alt text|300')).toEqual({ target: 'img.png', alt: 'alt text', width: 300 });
expect(parseImageEmbed('img.png|alt text|300x200')).toEqual({ target: 'img.png', alt: 'alt text', width: 300 });
expect(parseImageEmbed('//example.com/a.png')).toBeNull();
expect(isIgnoredPath('.custom-obsidian/app.json', true, '.custom-obsidian')).toBe(false);
expect(isIgnoredPath('.obsidian/app.json', true, '.custom-obsidian')).toBe(true);

const encodedIndex = ['attachments/my%20literal.png'];
const parsedLiteral = parseImageEmbed('attachments/my%2520literal.png');
expect(parsedLiteral).toEqual({ target: 'attachments/my%20literal.png', alt: undefined, width: undefined });
expect(resolveRemoteImagePath(parsedLiteral!.target, '', encodedIndex, { decodeTarget: false })).toBe('attachments/my%20literal.png');
```

Add tests to `tests/loader.test.ts`:
```ts
it('falls back to default concurrency 3 when maxConcurrent is NaN and evicts oldest LRU memoryImage past maxMemoryImages', async () => {
  let seq = 0;
  const blobApi = {
    createObjectURL: vi.fn(() => `blob:lru-${++seq}`),
    revokeObjectURL: vi.fn(),
  };
  const client = { getRawBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer) } as any;
  const loader = new OnDemandImageLoader(client, blobApi, Number.NaN, 2);

  loader.registerMemoryImage('a.png', new Blob([new Uint8Array([1])]));
  loader.registerMemoryImage('b.png', new Blob([new Uint8Array([2])]));
  // Touch a.png via loadIntoElement so b.png becomes least recently used
  loader.loadIntoElement(createMockImg(), 'a.png', 'main');
  loader.registerMemoryImage('c.png', new Blob([new Uint8Array([3])]));

  expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:lru-2');
  const img = createMockImg();
  loader.loadIntoElement(img, 'c.png', 'main');
  expect(img.src).toBe('blob:lru-3');
  expect(client.getRawBinary).not.toHaveBeenCalled();
});
```

Add tests to `tests/client.test.ts`:
```ts
it('throws on repeated x-next-page pagination headers and enforces request timeout with cause', async () => {
  const loopReq = vi.fn().mockResolvedValue({
    status: 200,
    json: [],
    headers: { 'x-next-page': '1' },
    text: '',
    arrayBuffer: new ArrayBuffer(0),
  });
  const loopClient = new GitLabClient(cfg, loopReq);
  await expect(loopClient.getTreeRecursive('abc')).rejects.toThrow(/pagination loop/i);

  const slowReq = vi.fn(() => new Promise<never>(() => {}));
  const timeoutClient = new GitLabClient({ ...cfg, timeoutMs: 15 }, slowReq);
  await expect(timeoutClient.getBranchHead('main')).rejects.toThrow(/timed out/i);

  const rootCause = new Error('ECONNRESET');
  const failReq = vi.fn().mockRejectedValue(rootCause);
  const causeClient = new GitLabClient(cfg, failReq);
  try {
    await causeClient.getBranchHead('main');
    expect.unreachable();
  } catch (err) {
    expect((err as Error & { cause?: unknown }).cause).toBe(rootCause);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npx vitest run tests/paths.test.ts tests/loader.test.ts tests/client.test.ts`
  Expected: FAIL on missing features/mismatched expectations.

- [ ] **Step 3: Implement updates in `tsconfig.json`, `src/utils/paths.ts`, `src/images/loader.ts`, and `src/gitlab/client.ts`**
  - `tsconfig.json`: add `"ES2022.Error"` to `compilerOptions.lib`.
  - `src/utils/paths.ts`:
    - `isIgnoredPath(path, syncObsidianDir, configDir = '.obsidian')`: normalize `configDir` via `normalizeVaultPath(configDir) || '.obsidian'`, check `i === 0 && segment === normalizedConfigDir && syncObsidianDir` (and skip nested `.git`).
    - `parseImageEmbed`: reject `pathWithoutFragment.startsWith('//')` before stripping slashes; parse multi-pipe alias into `{ target, alt, width }` where trailing `EMBED_SIZE_RE` is `width` and preceding pipe parts (joined by `|` if any, trimmed) become `alt` when non-empty.
    - `resolveRemoteImagePath(..., options?: { decodeTarget?: boolean })`: only call `safeDecodeURIComponent` when `options?.decodeTarget !== false`.
  - `src/images/loader.ts`: guard `maxConcurrent` with `Number.isFinite(maxConcurrent)` fallback `3`; add `maxMemoryImages = 20` (same `Number.isFinite` floor `1`); in `registerMemoryImage` and `loadIntoElement` cache hit, refresh insertion order in `memoryImages` Map (`delete` + `set`) and evict oldest key + `revokeUrl` when `memoryImages.size > maxMemoryImages`.
  - `src/gitlab/client.ts`: track `seenPages = new Set<string>(['1'])` in `getTreeRecursive` and throw if `seenPages.has(nextPage)` before setting `page = nextPage`; store `timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs! > 0 ? config.timeoutMs! : 30_000`; in `request`, race `requestFn(...)` against a `setTimeout` rejecting with `GitLab API ${method} ${projectRelativePath} timed out after ${this.timeoutMs}ms` (clearing timer in `finally`), and wrap non-API transport errors in `new Error(..., { cause: err })`.

- [ ] **Step 4: Run tests and typecheck to verify they pass**
  Run: `npx vitest run tests/paths.test.ts tests/loader.test.ts tests/client.test.ts; npx tsc --noEmit`
  Expected: PASS (all tests green, 0 TypeScript errors).

- [ ] **Step 5: Commit**
  `git add tsconfig.json src/utils/paths.ts src/images/loader.ts src/gitlab/client.ts tests/paths.test.ts tests/loader.test.ts tests/client.test.ts`
  `git commit -m "fix: harden path parsing, image loader LRU bounds, and GitLab client timeouts"`

---

### Task 2: Desktop 3-Way Merge Recovery & SyncEngine Safety

**Files:**
- Modify: `src/types.ts`
- Modify: `src/sync/engine.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `isIgnoredPath(path, syncObsidianDir, configDir)` from `src/utils/paths.ts`; `GitLabClient`; `computeSyncPlan`.
- Produces in `src/types.ts`:
  - `SyncState` adds optional `conflictPushedHashes?: Record<string, string>` and `conflictDeletedPaths?: string[]`.
- Produces in `src/sync/engine.ts`:
  - `SyncEngineOptions` adds optional `configDir?: string`.
  - `SyncEngine.clearConflictBranch(): Promise<void>` and updated `SyncEngine.sync(): Promise<SyncResult>`.

- [ ] **Step 1: Write the failing tests in `tests/engine.test.ts`**

```ts
it('clearConflictBranch adopts 3-way merged target files while preserving post-push mobile edits and eliminating conflict loops', async () => {
  const mobilePushed = 'line1\nmobile line2';
  const mergedOnDesktop = 'line1\ndesktop line1.5\nmobile line2';
  const newerMobileEdit = 'draft written after conflict push';
  const files: Record<string, string> = {
    'merged.md': mobilePushed,
    'edited-later.md': newerMobileEdit,
  };
  const state: SyncState = {
    lastSyncedCommitSha: 'c0',
    activeConflictBranch: 'mobile-conflict/20261119-040000',
    files: {
      'merged.md': { blobSha: 'r0', contentHash: 'h0' },
      'edited-later.md': { blobSha: 're0', contentHash: 'he0' },
    },
    remoteImagePaths: [],
    conflictPushedHashes: {
      'merged.md': await sha256Hex(mobilePushed),
      'edited-later.md': await sha256Hex('older conflict push'),
    },
    conflictDeletedPaths: [],
  };
  const client = {
    getBranchHead: vi.fn().mockResolvedValue('c_merged'),
    getTreeRecursive: vi.fn().mockResolvedValue([
      { id: 'r_merged', name: 'merged.md', type: 'blob', path: 'merged.md', mode: '100644' },
      { id: 're_merged', name: 'edited-later.md', type: 'blob', path: 'edited-later.md', mode: '100644' },
      { id: 'r_brandnew', name: 'brandnew.md', type: 'blob', path: 'brandnew.md', mode: '100644' },
    ]),
    getRawText: vi.fn(async (p: string) => {
      if (p === 'merged.md') return mergedOnDesktop;
      if (p === 'edited-later.md') return 'older remote text';
      if (p === 'brandnew.md') return 'new remote';
      return '';
    }),
    createCommit: vi.fn(),
  } as any;
  const vault = {
    listTextFiles: async () => Object.keys(files),
    readText: async (p: string) => files[p],
    writeText: async (p: string, c: string) => { files[p] = c; },
    deleteFile: async (p: string) => { delete files[p]; },
  };

  const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
  await engine.clearConflictBranch();

  expect(files['merged.md']).toBe(mergedOnDesktop);
  expect(files['brandnew.md']).toBe('new remote');
  expect(files['edited-later.md']).toBe(newerMobileEdit);
  expect(state.activeConflictBranch).toBeNull();
  expect(state.conflictPushedHashes).toBeUndefined();
  expect(state.lastSyncedCommitSha).toBe('c_merged');
  expect(state.files['merged.md']).toEqual({ blobSha: 'r_merged', contentHash: await sha256Hex(mergedOnDesktop) });
});

it('gives actionable 404 error if conflict branch was deleted on GitLab, aborts incremental pull before disk write, and guards target TOCTOU head movement', async () => {
  // 1. 404 on deleted activeConflictBranch
  const state404: SyncState = {
    lastSyncedCommitSha: 'c0',
    activeConflictBranch: 'mobile-conflict/deleted',
    files: {},
    remoteImagePaths: [],
  };
  const client404 = {
    getBranchHead: vi
      .fn()
      .mockResolvedValueOnce('c1')
      .mockRejectedValueOnce(new Error('GitLab API GET failed (404): 404 Branch Not Found')),
    getTreeRecursive: vi.fn().mockResolvedValue([]),
    getRawText: vi.fn(),
    createCommit: vi.fn(),
  } as any;
  const vaultEmpty = { listTextFiles: async () => [], readText: async () => '', writeText: vi.fn(), deleteFile: vi.fn() };
  const engine404 = new SyncEngine({ settings: DEFAULT_SETTINGS, state: state404, client: client404, vault: vaultEmpty, saveState: vi.fn() });
  await expect(engine404.sync()).rejects.toThrow(/Clear Conflict State/i);

  // 2. Incremental pull failure must not write partial files to disk
  const incFiles: Record<string, string> = {};
  const incWrite = vi.fn(async (p: string, c: string) => { incFiles[p] = c; });
  const incClient = {
    getBranchHead: vi.fn().mockResolvedValue('c1'),
    getTreeRecursive: vi.fn().mockResolvedValue([
      { id: '1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' },
      { id: '2', name: 'b.md', type: 'blob', path: 'b.md', mode: '100644' },
    ]),
    getRawText: vi.fn().mockResolvedValueOnce('# A').mockRejectedValueOnce(new Error('Timeout')),
    createCommit: vi.fn(),
  } as any;
  const incVault = { listTextFiles: async () => Object.keys(incFiles), readText: async (p: string) => incFiles[p], writeText: incWrite, deleteFile: vi.fn() };
  const incState: SyncState = { lastSyncedCommitSha: 'c0', activeConflictBranch: null, files: {}, remoteImagePaths: [] };
  await expect(new SyncEngine({ settings: DEFAULT_SETTINGS, state: incState, client: incClient, vault: incVault, saveState: vi.fn() }).sync()).rejects.toThrow('Timeout');
  expect(incWrite).not.toHaveBeenCalled();

  // 3. TOCTOU head check before target createCommit
  const pushFiles: Record<string, string> = { 'new.md': 'local' };
  const pushClient = {
    getBranchHead: vi.fn().mockResolvedValueOnce('c0').mockResolvedValueOnce('c_desktop_moved'),
    getTreeRecursive: vi.fn().mockResolvedValue([]),
    getRawText: vi.fn(),
    createCommit: vi.fn(),
  } as any;
  const pushVault = { listTextFiles: async () => Object.keys(pushFiles), readText: async (p: string) => pushFiles[p], writeText: vi.fn(), deleteFile: vi.fn() };
  const pushState: SyncState = { lastSyncedCommitSha: 'c0', activeConflictBranch: null, files: {}, remoteImagePaths: [] };
  await expect(new SyncEngine({ settings: DEFAULT_SETTINGS, state: pushState, client: pushClient, vault: pushVault, saveState: vi.fn() }).sync()).rejects.toThrow(/target branch moved/i);
  expect(pushClient.createCommit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/engine.test.ts`
  Expected: FAIL on assertions above.

- [ ] **Step 3: Implement updates in `src/types.ts` and `src/sync/engine.ts`**
  - `src/types.ts`: add `conflictPushedHashes?: Record<string, string>` and `conflictDeletedPaths?: string[]` to `SyncState`.
  - `src/sync/engine.ts`:
    - Store `configDir = options.configDir ?? '.obsidian'` and pass to all `isIgnoredPath(..., this.configDir)` calls.
    - Wrap `getBranchHead(this.state.activeConflictBranch)` in `try/catch`: if error message contains `(404)`, rethrow `new Error(\`Conflict branch "${this.state.activeConflictBranch}" no longer exists on GitLab (likely merged and deleted). Open Settings and click "Clear Conflict State" to adopt the merged target branch.\`, { cause: err })`.
    - Remove the redundant `this.mergeRemoteImagePaths(this.state.remoteImagePaths, initialRemoteImages)` call after pulls; keep the initial merge + final merge.
    - Unify `applyPulls()`: download all `plan.pullDownloads` into `Map<string, string>` BEFORE writing to `vault`, then wrap disk writes/deletes and `this.state.files` updates in `try/finally` that persists `saveState()` if any disk change occurred before an error.
    - In `applyPushes()`:
      - For `'target'`: re-check `const latestHead = await this.client.getBranchHead(this.settings.branch)` before `createCommit`; if `latestHead !== headSha`, throw `new Error('Remote target branch moved during sync; please run sync again to merge or pull latest changes.')`.
      - For `'conflict'` / `'active-conflict'`: after `createCommit` succeeds, update `this.state.conflictPushedHashes` (mapping each created/updated path in `actions` to `localHashes[path]`) and `this.state.conflictDeletedPaths` (recording deleted paths in `actions`, clearing paths recreated).
    - Implement `clearConflictBranch()` per Design Spec §5.1: pre-fetch remote texts for all allowlisted non-ignored blobs in `targetBranch` before mutating disk/state; then for each remote file decide whether Mobile kept untouched/conflict-pushed content (write remote text & update `state.files`) vs edited post-push (keep local edit & update baseline `state.files` to remote `{ blobSha, contentHash }`); handle remote-deleted files similarly; clear `activeConflictBranch`, `conflictPushedHashes`, `conflictDeletedPaths`; advance `lastSyncedCommitSha = headSha`; `await this.saveState()`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/engine.test.ts; npx tsc --noEmit`
  Expected: PASS (all `engine.test.ts` tests pass, 0 TypeScript errors).

- [ ] **Step 5: Commit**
  `git add src/types.ts src/sync/engine.ts tests/engine.test.ts`
  `git commit -m "fix(sync): support 3-way merge conflict recovery and atomic pull/push guards"`

---

### Task 3: Live Preview, Reading View & Mobile Paste/Upload Fixes

**Files:**
- Modify: `src/images/reading-view.ts`
- Modify: `src/images/live-preview.ts`
- Modify: `src/images/paste-upload.ts`
- Test: `tests/paste-upload.test.ts`

**Interfaces:**
- Consumes: `parseImageEmbed` (`{ target, alt, width }`), `resolveRemoteImagePath(target, noteDir, paths, { decodeTarget: false })`, `isImagePath`, `isIgnoredPath` from `src/utils/paths.ts`.
- Produces in `src/images/live-preview.ts`:
  - `refreshRemoteImagesEffect` (`StateEffect.define<void>()`)
  - `createLivePreviewImageExtension(getContext: () => ImageRenderContext): Extension`
- Produces in `src/images/paste-upload.ts`:
  - `PasteUploadDeps` adds optional `configDir?: string` and `onUploaded?: () => void`.

- [ ] **Step 1: Write failing tests in `tests/paste-upload.test.ts`**

Add tests covering:
1. Empty `file.type` with image filename (`photo.png`) on `editor-drop` is intercepted and uploaded.
2. Async `editor-paste` replaces only its placeholder marker range (`editor.replaceRange`) even if cursor moved, and deletes its placeholder marker if upload fails offline.
3. `handleVaultImageCreate` uses targeted `editor.replaceRange` (not `editor.setValue`) when `offsetToPos` & `replaceRange` exist on `editor` and calls `deps.onUploaded()`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/paste-upload.test.ts`
  Expected: FAIL on missing empty-MIME / `replaceRange` / `onUploaded` behavior.

- [ ] **Step 3: Implement updates in `src/images/reading-view.ts`, `src/images/live-preview.ts`, and `src/images/paste-upload.ts`**
  - `src/images/reading-view.ts`: pass `{ decodeTarget: false }` to `resolveRemoteImagePath`; apply `parsed.alt ?? altAttr` in `applyImageAttributes`.
  - `src/images/live-preview.ts`:
    - Export `refreshRemoteImagesEffect = StateEffect.define<void>()`.
    - Import `syntaxTree` from `@codemirror/language`; add `isInsideCodeContext(view, pos)` checking ancestor node names (`node.name.toLowerCase()` matching `code` / `inline-code` / `hmd-codeblock` / `fencedcode`, excluding `code` false positives only by checking known CM6/HyperMD code node names: `codeblock`, `hmd-codeblock`, `hypermd-codeblock`, `inlinecode`, `inline-code`, `fencedcode`, `codeinfo`, `codemarks`, `codetext`).
    - Match balanced single-level parens in un-angled Markdown paths: `([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)` in `IMAGE_EMBED_RE`.
    - Pass `{ decodeTarget: false }` to `resolveRemoteImagePath`; for wikilinks use `parsed.alt ?? ''` as `alt`.
    - Rebuild `decorations` in `ViewPlugin.update` when `update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshRemoteImagesEffect)))`.
  - `src/images/paste-upload.ts`:
    - `PasteUploadDeps` adds `configDir?: string` and `onUploaded?: () => void`.
    - `extractImageFiles` accepts `file.type.toLowerCase().startsWith('image/') || isImagePath(file.name)`, using `mimeTypeFromExtension(file.name)` fallback when `file.type` is empty.
    - In `handleImageTransfer`: if `editor.getValue`, `editor.offsetToPos`, and `editor.replaceRange` exist, insert a unique marker `<!-- uploading-gitlab-image-${counter} -->` via `editor.replaceSelection` before `await`, then locate the marker index in `editor.getValue()` and replace only `[idx, idx + marker.length]` via `editor.replaceRange(wikilinks, fromPos, toPos)` (or `''` on failure); otherwise fall back cleanly to `editor.replaceSelection` on success (preserving existing mock test compatibility!).
    - In `handleVaultImageCreate`: pass `deps.configDir ?? '.obsidian'` to `isIgnoredPath`; use `offsetToPos` + `editor.replaceRange` to replace `![[file.path]]`, `![[file.name]]`, or Markdown links (`![...](file.path)` / percent-encoded) when `offsetToPos` & `replaceRange` exist, falling back to `setValue` only on minimal mock editors; invoke `deps.onUploaded?.()`.

- [ ] **Step 4: Run tests and typecheck to verify they pass**
  Run: `npx vitest run tests/paste-upload.test.ts; npx tsc --noEmit`
  Expected: PASS (`paste-upload.test.ts` green, 0 TypeScript errors).

- [ ] **Step 5: Commit**
  `git add src/images/reading-view.ts src/images/live-preview.ts src/images/paste-upload.ts tests/paste-upload.test.ts`
  `git commit -m "fix(images): harden Live Preview code-block skip, alt/parens, and non-destructive paste/upload"`

---

### Task 4: Settings Tab & Plugin Entry Point Polish

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `refreshRemoteImagesEffect` from `src/images/live-preview.ts`, `isIgnoredPath(..., configDir)` from `src/utils/paths.ts`, `SyncEngine` (`configDir`), `PasteUploadDeps` (`configDir`, `onUploaded`).
- Produces: Polished `GitLabSyncSettingTab` and `GitLabOnDemandSyncPlugin` compiling and bundling cleanly to `main.js`.

- [ ] **Step 1: Update `src/settings.ts`**
  - In `Attachment Folder` `onChange`: store `value.trim()` directly (allowing `""` for vault root instead of snapping back to `'attachments'`).
  - Add private `saveTimer: ReturnType<typeof setTimeout> | null = null`, helper `scheduleTextSave()` (300ms debounce calling `void this.plugin.saveAndRefreshSettings()`), and `override hide(): void` that flushes any pending `saveTimer` immediately via `void this.plugin.saveAndRefreshSettings()`.
  - Keep toggles and the `Clear Conflict State` button immediate.

- [ ] **Step 2: Update `src/main.ts`**
  - Remove duplicate `DEFAULT_SYNC_STATE`; use `createDefaultSyncState()` in `loadPluginData()`, preserving `conflictPushedHashes` and `conflictDeletedPaths` when loaded from disk.
  - Add `getConfigDir()` returning `normalizeVaultPath(this.app.vault.configDir || '.obsidian') || '.obsidian'`, and pass it to `isIgnoredPath`, `SyncEngine`, and `PasteUploadDeps` (`onUploaded: () => this.refreshOpenEditors()`).
  - Implement `refreshOpenEditors()` iterating `this.app.workspace.getLeavesOfType?.('markdown') ?? []`, accessing `(view.editor as { cm?: EditorView })?.cm` to dispatch `effects: refreshRemoteImagesEffect.of(undefined)` and calling `view.previewMode?.rerender?.(true)` if present.
  - On `onLayoutReady`: if `this.isEnabled() && this.syncState.activeConflictBranch`, show a zero-emoji `Notice` reminding that `activeConflictBranch` is awaiting desktop merge & "Clear Conflict State".
  - After `syncWithNotice()` succeeds, call `this.refreshOpenEditors()`.

- [ ] **Step 3: Verify tests, typecheck, production build, and Node syntax check**
  Run: `npx vitest run; npx tsc --noEmit; node esbuild.config.mjs production; node -c main.js`
  Expected: All existing tests PASS, 0 TypeScript errors, `main.js` built and passes `node -c main.js` (Sandy Gate 2).

- [ ] **Step 4: Commit**
  `git add src/settings.ts src/main.ts`
  `git commit -m "fix(plugin): allow root attachments, debounce settings, refresh open editors, and pass configDir"`

---

### Task 5: Stateful Fake-GitLab Simulator & End-to-End Lifecycle Integration Tests

**Files:**
- Create: `tests/helpers/fake-gitlab.ts`
- Create: `tests/integration/sync-lifecycle.test.ts`

**Interfaces:**
- Consumes: `RequestUrlFn`, `GitLabClient` (`src/gitlab/client.ts`), `SyncEngine`, `VaultTextAdapter` (`src/sync/engine.ts`), `OnDemandImageLoader` (`src/images/loader.ts`), `uploadPastedImage` (`src/images/paste-upload.ts`), `DEFAULT_SETTINGS`, `SyncState`, `GitLabTreeEntry`, `GitLabCommitAction`.
- Produces in `tests/helpers/fake-gitlab.ts`:
  - `class FakeGitLabServer` with `requestFn: RequestUrlFn`, `seedBranch`, `commitOnBranch`, `mergeBranch` (3-way merge helper), `deleteBranch`, `failNextRawFetch`, `onBeforeCommit`, `getBranchFiles`.

- [ ] **Step 1: Write `tests/helpers/fake-gitlab.ts`**
  Implement a minimal, self-contained stateful GitLab API simulator using deterministic SHA-1/SHA-256-like blob IDs (via Web Crypto or simple deterministic hash) and commit IDs, supporting:
  - `GET /repository/branches/:branch` (404 when branch absent/deleted)
  - `GET /repository/tree?recursive=true&per_page=...&ref=...&page=...` (paginates with configurable page size so pagination works end-to-end)
  - `GET /repository/files/:encodedPath/raw?ref=...` (UTF-8 text & `Uint8Array` binary bytes, 404 if missing)
  - `POST /repository/commits` (`branch`, `start_sha`, `actions` supporting `create`/`update`/`delete` and `base64`/`text` encoding; rejects duplicate creates or missing-file deletes/updates just like real GitLab!)
  - Test helpers: `commitOnBranch`, `mergeBranch` (with custom merged contents), `deleteBranch`, `failNextRawFetch`, `onBeforeCommit`.

- [ ] **Step 2: Write `tests/integration/sync-lifecycle.test.ts`**
  Test full end-to-end scenarios against `FakeGitLabServer` + real `GitLabClient` + `SyncEngine` + `uploadPastedImage` + `OnDemandImageLoader` (verifying `writeBinary` is never used):
  1. **Full Conflict -> Desktop 3-Way Merge -> MR Branch Delete -> Clear Conflict -> Clean Re-sync:**
     - Seed `main` on FakeGitLab (`notes/doc.md`, `attachments/logo.png`).
     - Mobile initial empty-vault sync pulls `notes/doc.md` (and never writes `logo.png` to disk).
     - Desktop pushes an edit to `notes/doc.md` on `main`; Mobile edits `notes/doc.md` AND `notes/mobile-note.md`.
     - Mobile syncs -> creates `mobile-conflict/...` with `start_sha` at base commit; keeps Mobile edits on disk.
     - Mobile pastes a new image (`uploadPastedImage`) onto `activeConflictBranch`, then edits `notes/later.md` locally after conflict push.
     - Desktop performs 3-way merge into `main` (producing 3rd merged content for `notes/doc.md`, keeping `notes/mobile-note.md` and pasted image), then GitLab deletes `mobile-conflict/...`.
     - Mobile sync hits actionable `"Clear Conflict State"` 404 error.
     - Mobile calls `clearConflictBranch()`: adopts merged `notes/doc.md`, preserves `notes/later.md` edit, clears `activeConflictBranch`, advances `lastSyncedCommitSha`.
     - Next `sync()` pushes `notes/later.md` cleanly to `main` with **zero conflict loop**; final `sync()` is a no-op (`pushed: 0, pulled: 0`).
  2. **Incremental Pull Partial-Failure & Concurrent Desktop Push TOCTOU:**
     - `failNextRawFetch` mid-incremental-pull leaves vault & `SyncState` consistent; retry succeeds cleanly.
     - `onBeforeCommit` injects a Desktop commit right before Mobile's `createCommit`; `sync()` aborts cleanly instead of overwriting Desktop, then next `sync()` detects the conflict cleanly.
  3. **On-Demand Image Load After Sync & Paste:**
     - `OnDemandImageLoader` fetches Desktop-added `attachments/logo.png` over `FakeGitLabServer` into `blob:` URL without touching disk.

- [ ] **Step 3: Run integration tests**
  Run: `npx vitest run tests/integration/sync-lifecycle.test.ts`
  Expected: PASS (all integration tests green).

- [ ] **Step 4: Commit**
  `git add tests/helpers/fake-gitlab.ts tests/integration/sync-lifecycle.test.ts`
  `git commit -m "test: add stateful fake-GitLab server and end-to-end sync lifecycle tests"`

---

### Task 6: DOM/CM6 UI & Wiring Tests (`happy-dom`) + Manual Pre-Flight Checklist

**Files:**
- Modify: `package.json` (add `happy-dom` devDependency)
- Modify: `tests/__mocks__/obsidian.ts`
- Create: `tests/reading-view.test.ts`
- Create: `tests/live-preview.test.ts`
- Create: `tests/settings.test.ts`
- Create: `tests/main.test.ts`
- Create: `docs/manual-test-checklist.md`

**Interfaces:**
- Consumes: `registerReadingViewImageProcessor`, `createLivePreviewImageExtension`, `refreshRemoteImagesEffect`, `GitLabSyncSettingTab`, `GitLabOnDemandSyncPlugin`.

- [ ] **Step 1: Install `happy-dom` and enhance `tests/__mocks__/obsidian.ts`**
  Run: `npm install -D happy-dom`
  Extend `tests/__mocks__/obsidian.ts` minimally so `Setting` renders real DOM elements (`nameEl`, `descEl`, inputs, toggles, buttons), `PluginSettingTab` sets up `containerEl` when `document` exists, `editorLivePreviewField` & `editorInfoField` work as CM6 `StateField` mocks (or lightweight field descriptors accepted by `EditorState.create`), and `Plugin` supports mock `loadData`/`saveData`/`app` wiring.

- [ ] **Step 2: Create UI/wiring tests using `// @vitest-environment happy-dom`**
  - `tests/reading-view.test.ts`: `.internal-embed` and `<img>` processing, `src` removal, multi-pipe `|caption|300` alt/width, `isLocalFilePresent` skip, disabled skip, `MarkdownRenderChild.onunload()` cleanup.
  - `tests/live-preview.test.ts`: Create real CM6 `EditorView` (`@codemirror/view`, `@codemirror/state`, `@codemirror/language` `StreamLanguage`) testing `![[img.png]]`, `![alt](sub/photo(1).png)`, cursor-overlap expansion, code-block exclusion, `refreshRemoteImagesEffect` dispatch updating decorations after sync, and widget `destroy()` cleanup.
  - `tests/settings.test.ts`: Render `GitLabSyncSettingTab`, test empty `attachmentFolder` allowed, 300ms text debounce + `hide()` immediate flush, immediate toggles, `Clear Conflict State` disabled/enabled + error Notice without clearing button on error.
  - `tests/main.test.ts`: `Platform.isMobile` vs `enableOnDesktop` gating, `loadPluginData` partial/legacy recovery, `VaultTextAdapter` with custom `configDir` & dot-folder exclusion, `syncWithNotice` (zero raw emojis), startup conflict reminder Notice, and `onunload()` calling `loader.revokeAll()`.

- [ ] **Step 3: Create `docs/manual-test-checklist.md`**
  Concise step-by-step verification guide for real Obsidian Desktop + Mobile + private GitLab (setup, initial empty-vault pull, on-demand image scroll/memory verification via storage size check, offline paste fail-safe, camera/picker upload, Desktop 3-way merge + Clear Conflict State recovery).

- [ ] **Step 4: Run full verification suite & Sandy PM Gate checks**
  Run: `npx vitest run; npx tsc --noEmit; node esbuild.config.mjs production; node -c main.js`
  Check `manage_task` `list` for zero lingering background tasks.
  Expected: All unit + integration + DOM/CM6 tests PASS, 0 TypeScript errors, `main.js` builds and passes `node -c main.js`, zero raw Unicode emojis in `src/` UI strings.

- [ ] **Step 5: Commit**
  `git add package.json package-lock.json tests/__mocks__/obsidian.ts tests/reading-view.test.ts tests/live-preview.test.ts tests/settings.test.ts tests/main.test.ts docs/manual-test-checklist.md`
  `git commit -m "test: add happy-dom UI/CM6 tests and manual pre-flight verification checklist"`
