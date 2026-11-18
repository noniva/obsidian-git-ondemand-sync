# Obsidian GitLab On-Demand Image & Text Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Obsidian Mobile-focused plugin that syncs only allowlisted text files with a private GitLab repository via REST API, renders images on-demand in memory (`blob:` URLs) with zero disk storage, uploads pasted images directly to GitLab, and delegates conflict merges to desktop via GitLab conflict branches.

**Architecture:** The plugin activates on `Platform.isMobile` (with an optional desktop testing override) so desktop continues using Obsidian Git normally. A pure-TypeScript sync diff engine compares GitLab's recursive Repository Tree against `data.json` state, while Reading View (`MarkdownPostProcessor`) and Live Preview (CodeMirror 6 `ViewPlugin`) intercept unresolved image embeds and lazy-load them via `IntersectionObserver` + `URL.createObjectURL`.

**Tech Stack:** TypeScript, Obsidian Plugin API (`requestUrl`, `MarkdownPostProcessor`, `PluginSettingTab`), CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/language`), esbuild, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-gitlab-ondemand-sync-design.md`

## Global Constraints

- Zero persistent image storage on mobile: never call `vault.adapter.writeBinary` for viewed or pasted images.
- Zero `.git` or `isomorphic-git` packfiles on mobile; all remote operations use GitLab REST API via Obsidian `requestUrl`.
- Text-only sync via UTF-8 allowlist (default: `.md`, `.canvas`, `.txt`); non-text binary files (images, PDFs, audio, video) are never synced to mobile disk.
- Initial sync requires an empty vault (abort with warning if local text files already exist when `lastSyncedCommitSha` is unset).
- On conflict, bundle pending mobile changes to `mobile-conflict/YYYYMMDD-HHmmss` (`start_sha: lastSyncedCommitSha`), keep mobile's local edits on disk, and record `activeConflictBranch`.
- Runs only when `Platform.isMobile` is true (unless `enableOnDesktop` test override is enabled).
- `manifest.json` must set `"isDesktopOnly": false`.

## Review Focus

1. Unicode, spaces, and nested slashes in file paths (`notes/บันทึก (1).md`, `attachments/my photo.png`) must be `encodeURIComponent`-encoded in GitLab `/repository/files/:file_path/raw` URLs while remaining unencoded in commit `actions[].file_path`.
2. Embed syntax variants (`![[img.png|300]]`, `![[sub/img.png|alt]]`, `![alt](sub/img.png)`, and external `https://...` URLs) must parse target path vs. display width accurately and leave external URLs untouched.
3. In-flight image fetches aborted or completing after note/view close must immediately revoke any created `blob:` URL and skip DOM mutation.
4. Pasting an image while offline must abort upload, show an Obsidian `Notice`, insert no broken embed link, and leave no file on disk.
5. Re-syncing while `activeConflictBranch` is still open must push further mobile edits to `activeConflictBranch`, pull non-conflicting remote changes from `targetBranch`, and never overwrite mobile's conflicting local files.

---

## File Structure

- `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `styles.css`, `vitest.config.ts` — Project build, test, and Obsidian plugin metadata.
- `src/types.ts` — Shared types (`PluginSettings`, `DEFAULT_SETTINGS`, `SyncState`, `GitLabTreeEntry`, `SyncPlan`, `SyncResult`).
- `src/utils/paths.ts` — Pure path normalization, extension filtering, embed target parsing, and remote image resolution.
- `src/gitlab/client.ts` — `GitLabClient` over injectable `RequestUrlFn` (Obsidian `requestUrl`).
- `src/sync/diff.ts` — Pure `computeSyncPlan` and conflict/branch state transitions.
- `src/sync/engine.ts` — `SyncEngine` coordinating vault I/O, `GitLabClient`, `computeSyncPlan`, and `SyncState`.
- `src/images/loader.ts` — `OnDemandImageLoader` with `IntersectionObserver`, concurrency limit (3), `blob:` URL lifecycle, and cleanup.
- `src/images/reading-view.ts` — `MarkdownPostProcessor` for Reading View unresolved image embeds.
- `src/images/live-preview.ts` — CodeMirror 6 `ViewPlugin` widget for Live Preview unresolved image embeds.
- `src/images/paste-upload.ts` — Mobile editor `paste`/`drop` image upload handler.
- `src/settings.ts` — `GitLabSyncSettingTab` UI.
- `src/main.ts` — Plugin entry point wiring lifecycle, commands, ribbon icon, and cleanup.

---

### Task 1: Project Scaffolding, Types, and Path Utilities

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.config.mjs`
- Create: `vitest.config.ts`
- Create: `manifest.json`
- Create: `styles.css`
- Create: `src/types.ts`
- Create: `src/utils/paths.ts`
- Test: `tests/__mocks__/obsidian.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Produces in `src/types.ts`:
  - `PluginSettings`, `DEFAULT_SETTINGS`
  - `SyncedFileEntry` (`{ blobSha: string; contentHash: string }`)
  - `SyncState` (`{ lastSyncedCommitSha: string | null; activeConflictBranch: string | null; files: Record<string, SyncedFileEntry>; remoteImagePaths: string[] }`)
  - `GitLabTreeEntry` (`{ id: string; name: string; type: 'blob' | 'tree'; path: string; mode: string }`)
  - `GitLabCommitAction` (`{ action: 'create' | 'update' | 'delete'; file_path: string; content?: string; encoding?: 'text' | 'base64' }`)
- Produces in `src/utils/paths.ts`:
  - `normalizeVaultPath(path: string): string`
  - `isImagePath(path: string): boolean`
  - `isTextSyncPath(path: string, allowlist: string[]): boolean`
  - `isIgnoredPath(path: string, syncObsidianDir: boolean): boolean`
  - `parseImageEmbed(rawTarget: string): { target: string; width?: number } | null`
  - `resolveRemoteImagePath(target: string, noteDir: string, remoteImagePaths: string[]): string | null`
  - `sha256Hex(content: string): Promise<string>`

- [ ] **Step 1: Create project config and test mock files**
  Create `package.json` (with `obsidian`, `@codemirror/view`, `@codemirror/state`, `@codemirror/language`, `esbuild`, `typescript`, `vitest`), `tsconfig.json`, `esbuild.config.mjs` (outputs `main.js`), `vitest.config.ts` (aliasing `obsidian` to `tests/__mocks__/obsidian.ts`), `manifest.json` (`id: "gitlab-ondemand-sync"`, `isDesktopOnly: false`), `styles.css`, and `tests/__mocks__/obsidian.ts`.
  Run `npm install` to verify dependencies install cleanly.

- [ ] **Step 2: Write the failing tests in `tests/paths.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  isImagePath,
  isTextSyncPath,
  isIgnoredPath,
  parseImageEmbed,
  resolveRemoteImagePath,
  sha256Hex,
} from '../src/utils/paths';

describe('paths', () => {
  it('detects image and allowlisted text extensions', () => {
    expect(isImagePath('attachments/Photo.PNG')).toBe(true);
    expect(isImagePath('docs/manual.pdf')).toBe(false);
    expect(isTextSyncPath('notes/daily.md', ['.md', '.canvas', '.txt'])).toBe(true);
    expect(isTextSyncPath('docs/manual.pdf', ['.md', '.canvas', '.txt'])).toBe(false);
  });

  it('ignores .git always and .obsidian unless enabled', () => {
    expect(isIgnoredPath('.git/config', true)).toBe(true);
    expect(isIgnoredPath('.obsidian/app.json', false)).toBe(true);
    expect(isIgnoredPath('.obsidian/app.json', true)).toBe(false);
  });

  it('parses wikilink sizing/aliases and ignores external URLs', () => {
    expect(parseImageEmbed('folder/img.png|300')).toEqual({ target: 'folder/img.png', width: 300 });
    expect(parseImageEmbed('img.png|alt text')).toEqual({ target: 'img.png', width: undefined });
    expect(parseImageEmbed('https://example.com/a.png')).toBeNull();
  });

  it('resolves short and relative remote image paths', () => {
    const index = ['attachments/pic.png', 'sub/nested.jpg'];
    expect(resolveRemoteImagePath('pic.png', 'notes', index)).toBe('attachments/pic.png');
    expect(resolveRemoteImagePath('sub/nested.jpg', '', index)).toBe('sub/nested.jpg');
    expect(resolveRemoteImagePath('missing.png', '', index)).toBeNull();
  });

  it('computes deterministic sha256 hex', async () => {
    const hash = await sha256Hex('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**
  Run: `npx vitest run tests/paths.test.ts`
  Expected: FAIL with module not found (`../src/utils/paths`).

- [ ] **Step 4: Implement `src/types.ts` and `src/utils/paths.ts`**
  Define `PluginSettings`, `DEFAULT_SETTINGS`, `SyncState`, `GitLabTreeEntry`, `GitLabCommitAction` in `src/types.ts` and implement all exported functions in `src/utils/paths.ts` using Web Crypto `crypto.subtle.digest('SHA-256', ...)`.

- [ ] **Step 5: Run test to verify it passes**
  Run: `npx vitest run tests/paths.test.ts`
  Expected: PASS (5 tests).

- [ ] **Step 6: Commit**
  `git add package.json tsconfig.json esbuild.config.mjs vitest.config.ts manifest.json styles.css src/types.ts src/utils/paths.ts tests/`
  `git commit -m "feat: scaffold plugin and implement types and path utilities"`

---

### Task 2: GitLab REST API Client

**Files:**
- Create: `src/gitlab/client.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Consumes: `GitLabTreeEntry`, `GitLabCommitAction` from `src/types.ts`.
- Produces in `src/gitlab/client.ts`:
  - `RequestUrlFn` type (`(req: { url: string; method?: string; headers?: Record<string, string>; body?: string; throw?: boolean }) => Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer; json: unknown; headers: Record<string, string> }>`)
  - `GitLabClientConfig` (`{ baseUrl: string; projectId: string; token: string }`)
  - `class GitLabClient` with methods:
    - `getBranchHead(branch: string): Promise<string>`
    - `getTreeRecursive(ref: string): Promise<GitLabTreeEntry[]>`
    - `getRawText(filePath: string, ref: string): Promise<string>`
    - `getRawBinary(filePath: string, ref: string): Promise<ArrayBuffer>`
    - `createCommit(params: { branch: string; commitMessage: string; actions: GitLabCommitAction[]; startSha?: string }): Promise<string>`

- [ ] **Step 1: Write the failing tests in `tests/client.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { GitLabClient } from '../src/gitlab/client';

describe('GitLabClient', () => {
  const cfg = { baseUrl: 'https://gitlab.com/', projectId: 'user/my-vault', token: 'glpat-123' };

  it('encodes nested Unicode file paths for raw fetch and passes PRIVATE-TOKEN', async () => {
    const req = vi.fn().mockResolvedValue({ status: 200, text: '# Note', arrayBuffer: new ArrayBuffer(0), json: {}, headers: {} });
    const client = new GitLabClient(cfg, req);
    const text = await client.getRawText('notes/บันทึก (1).md', 'main');
    expect(text).toBe('# Note');
    expect(req).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://gitlab.com/api/v4/projects/user%2Fmy-vault/repository/files/notes%2F%E0%B8%9A%E0%B8%B1%E0%B8%99%E0%B8%97%E0%B8%B6%E0%B8%81%20(1).md/raw?ref=main',
      headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'glpat-123' }),
    }));
  });

  it('paginates recursive tree using x-next-page header', async () => {
    const req = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: [{ id: '1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }], headers: { 'x-next-page': '2' }, text: '', arrayBuffer: new ArrayBuffer(0) })
      .mockResolvedValueOnce({ status: 200, json: [{ id: '2', name: 'b.md', type: 'blob', path: 'b.md', mode: '100644' }], headers: { 'x-next-page': '' }, text: '', arrayBuffer: new ArrayBuffer(0) });
    const client = new GitLabClient(cfg, req);
    const entries = await client.getTreeRecursive('abc123');
    expect(entries).toHaveLength(2);
    expect(req).toHaveBeenCalledTimes(2);
  });

  it('sends start_sha and unencoded file_path in createCommit', async () => {
    const req = vi.fn().mockResolvedValue({ status: 201, json: { id: 'newsha' }, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) });
    const client = new GitLabClient(cfg, req);
    const sha = await client.createCommit({
      branch: 'mobile-conflict/20261119-040000',
      commitMessage: 'Mobile conflict',
      startSha: 'base123',
      actions: [{ action: 'update', file_path: 'notes/บันทึก (1).md', content: 'hi', encoding: 'text' }],
    });
    expect(sha).toBe('newsha');
    const body = JSON.parse(req.mock.calls[0][0].body);
    expect(body.start_sha).toBe('base123');
    expect(body.actions[0].file_path).toBe('notes/บันทึก (1).md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/client.test.ts`
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement `GitLabClient` in `src/gitlab/client.ts`**
  Normalize `baseUrl` trailing slash, URL-encode `projectId` and `filePath`, handle `x-next-page` (case-insensitive header lookup), throw descriptive `Error` on non-2xx responses.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/client.test.ts`
  Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
  `git add src/gitlab/client.ts tests/client.test.ts`
  `git commit -m "feat: add GitLab REST API client with pagination and encoding"`

---

### Task 3: Pure Sync Diffing & Conflict State Machine

**Files:**
- Create: `src/sync/diff.ts`
- Test: `tests/diff.test.ts`

**Interfaces:**
- Consumes: `SyncState`, `SyncedFileEntry`, `GitLabTreeEntry` from `src/types.ts`.
- Produces in `src/sync/diff.ts`:
  - `LocalFileSnapshot` (`Record<string, string>` mapping path to `contentHash`)
  - `SyncPlan` (`{ pullDownloads: string[]; pullDeletes: string[]; pushCreates: string[]; pushUpdates: string[]; pushDeletes: string[]; conflicts: string[]; hasConflict: boolean; targetPushBranch: 'target' | 'conflict' | 'active-conflict' }`)
  - `computeSyncPlan(params: { state: SyncState; remoteTextFiles: Record<string, string>; localHashes: LocalFileSnapshot }): SyncPlan`

- [ ] **Step 1: Write the failing tests in `tests/diff.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { computeSyncPlan } from '../src/sync/diff';
import type { SyncState } from '../src/types';

const emptyState: SyncState = { lastSyncedCommitSha: null, activeConflictBranch: null, files: {}, remoteImagePaths: [] };

describe('computeSyncPlan', () => {
  it('pulls all remote text files on empty initial vault', () => {
    const plan = computeSyncPlan({ state: emptyState, remoteTextFiles: { 'a.md': 'sha1' }, localHashes: {} });
    expect(plan.pullDownloads).toEqual(['a.md']);
    expect(plan.hasConflict).toBe(false);
  });

  it('throws if initial sync has existing local files', () => {
    expect(() => computeSyncPlan({ state: emptyState, remoteTextFiles: { 'a.md': 'sha1' }, localHashes: { 'existing.md': 'h1' } }))
      .toThrow(/empty vault/i);
  });

  it('detects conflict when both remote blobSha and local contentHash changed', () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'a.md': { blobSha: 'r0', contentHash: 'h0' }, 'b.md': { blobSha: 'rb0', contentHash: 'hb0' } },
      remoteImagePaths: [],
    };
    const plan = computeSyncPlan({
      state,
      remoteTextFiles: { 'a.md': 'r1', 'b.md': 'rb0' },
      localHashes: { 'a.md': 'h1', 'b.md': 'hb1' },
    });
    expect(plan.hasConflict).toBe(true);
    expect(plan.conflicts).toEqual(['a.md']);
    expect(plan.targetPushBranch).toBe('conflict');
    expect(plan.pushUpdates).toEqual(['a.md', 'b.md']);
  });

  it('pulls non-conflicting remote changes and pushes to activeConflictBranch when one is open', () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261119-040000',
      files: { 'a.md': { blobSha: 'r0', contentHash: 'h0' }, 'clean.md': { blobSha: 'rc0', contentHash: 'hc0' } },
      remoteImagePaths: [],
    };
    const plan = computeSyncPlan({
      state,
      remoteTextFiles: { 'a.md': 'r1', 'clean.md': 'rc1' },
      localHashes: { 'a.md': 'h1', 'clean.md': 'hc0' },
    });
    expect(plan.pullDownloads).toEqual(['clean.md']);
    expect(plan.targetPushBranch).toBe('active-conflict');
    expect(plan.pushUpdates).toEqual(['a.md']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/diff.test.ts`
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement `computeSyncPlan` in `src/sync/diff.ts`**
  Handle: initial empty vault check; remote create/update/delete; local create/update/delete; conflict detection; `activeConflictBranch` preservation (never overwrite locally modified files while `activeConflictBranch` is set, still pull unchanged files).

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/diff.test.ts`
  Expected: PASS (4 tests).

- [ ] **Step 5: Commit**
  `git add src/sync/diff.ts tests/diff.test.ts`
  `git commit -m "feat: implement pure text sync diffing and conflict plan"`

---

### Task 4: Sync Engine (Vault I/O + GitLab Commit + Conflict Branching)

**Files:**
- Create: `src/sync/engine.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `GitLabClient`, `computeSyncPlan`, `PluginSettings`, `SyncState`, `isImagePath`, `isTextSyncPath`, `isIgnoredPath`, `sha256Hex`.
- Produces in `src/sync/engine.ts`:
  - `VaultTextAdapter` (`{ listTextFiles(): Promise<string[]>; readText(path: string): Promise<string>; writeText(path: string, content: string): Promise<void>; deleteFile(path: string): Promise<void> }`)
  - `class SyncEngine` with `sync(): Promise<SyncResult>` and `clearConflictBranch(): Promise<void>`.

- [ ] **Step 1: Write the failing tests in `tests/engine.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { SyncEngine } from '../src/sync/engine';
import { DEFAULT_SETTINGS, type SyncState } from '../src/types';

describe('SyncEngine', () => {
  it('syncs text files only, indexes remote images, and skips binary PDFs', async () => {
    const files: Record<string, string> = {};
    const state: SyncState = { lastSyncedCommitSha: null, activeConflictBranch: null, files: {}, remoteImagePaths: [] };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('head1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: 'b1', name: 'note.md', type: 'blob', path: 'note.md', mode: '100644' },
        { id: 'b2', name: 'pic.png', type: 'blob', path: 'attachments/pic.png', mode: '100644' },
        { id: 'b3', name: 'doc.pdf', type: 'blob', path: 'docs/doc.pdf', mode: '100644' },
      ]),
      getRawText: vi.fn().mockResolvedValue('# Hello'),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });
    const res = await engine.sync();

    expect(files['note.md']).toBe('# Hello');
    expect(files['attachments/pic.png']).toBeUndefined();
    expect(files['docs/doc.pdf']).toBeUndefined();
    expect(state.remoteImagePaths).toEqual(['attachments/pic.png']);
    expect(state.lastSyncedCommitSha).toBe('head1');
    expect(res.pulled).toBe(1);
    expect(saveState).toHaveBeenCalled();
  });

  it('pushes conflicts to mobile-conflict branch and keeps local edits on disk', async () => {
    const files: Record<string, string> = { 'a.md': 'mobile edit' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'a.md': { blobSha: 'r0', contentHash: 'h0' } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([{ id: 'r1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c_conflict'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(res.conflictBranch).toMatch(/^mobile-conflict\//);
    expect(client.createCommit).toHaveBeenCalledWith(expect.objectContaining({ startSha: 'c0' }));
    expect(files['a.md']).toBe('mobile edit');
    expect(state.activeConflictBranch).toBe(res.conflictBranch);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/engine.test.ts`
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement `SyncEngine` in `src/sync/engine.ts`**
  Execute pull downloads/deletes, build `GitLabCommitAction[]` for pushes, create `mobile-conflict/YYYYMMDD-HHmmss` on conflict (or push to `activeConflictBranch` if already open), and persist `SyncState`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/engine.test.ts`
  Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
  `git add src/sync/engine.ts tests/engine.test.ts`
  `git commit -m "feat: implement SyncEngine with text allowlist and conflict branching"`

---

### Task 5: On-Demand Image Loader (Concurrency, Lazy Load, Blob Lifecycle)

**Files:**
- Create: `src/images/loader.ts`
- Test: `tests/loader.test.ts`

**Interfaces:**
- Consumes: `GitLabClient` from `src/gitlab/client.ts`.
- Produces in `src/images/loader.ts`:
  - `BlobUrlApi` (`{ createObjectURL(b: Blob): string; revokeObjectURL(url: string): void }`)
  - `class OnDemandImageLoader` with:
    - `loadIntoElement(imgEl: HTMLImageElement, repoPath: string, ref: string): () => void` (returns cleanup/abort callback)
    - `observeAndLoad(imgEl: HTMLImageElement, repoPath: string, ref: string): () => void` (uses `IntersectionObserver` when available, else immediate)
    - `registerMemoryImage(repoPath: string, blob: Blob): string` (used after paste upload to display immediately without disk write)
    - `revokeAll(): void`

- [ ] **Step 1: Write the failing tests in `tests/loader.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { OnDemandImageLoader } from '../src/images/loader';

describe('OnDemandImageLoader', () => {
  it('fetches image bytes, creates blob URL, and revokes on cleanup', async () => {
    const client = { getRawBinary: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer) } as any;
    const blobApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:mock-1'),
      revokeObjectURL: vi.fn(),
    };
    const imgEl = { src: '', dataset: {} as Record<string, string>, classList: { add: vi.fn(), remove: vi.fn() } } as unknown as HTMLImageElement;
    const loader = new OnDemandImageLoader(client, blobApi, 3);
    const cleanup = loader.loadIntoElement(imgEl, 'attachments/pic.png', 'main');
    await vi.waitFor(() => expect(imgEl.src).toBe('blob:mock-1'));

    cleanup();
    expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  it('revokes blob URL if cleanup is called while fetch is still in flight', async () => {
    let resolveFetch!: (buf: ArrayBuffer) => void;
    const client = { getRawBinary: vi.fn().mockReturnValue(new Promise<ArrayBuffer>((r) => { resolveFetch = r; })) } as any;
    const blobApi = { createObjectURL: vi.fn().mockReturnValue('blob:late'), revokeObjectURL: vi.fn() };
    const imgEl = { src: '', dataset: {} as Record<string, string>, classList: { add: vi.fn(), remove: vi.fn() } } as unknown as HTMLImageElement;

    const loader = new OnDemandImageLoader(client, blobApi, 3);
    const cleanup = loader.loadIntoElement(imgEl, 'attachments/late.png', 'main');
    cleanup(); // User closed note before fetch finished

    resolveFetch(new Uint8Array([9]).buffer);
    await new Promise((r) => setTimeout(r, 10));
    expect(imgEl.src).toBe('');
    expect(blobApi.createObjectURL).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/loader.test.ts`
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement `OnDemandImageLoader` in `src/images/loader.ts`**
  Implement bounded concurrency queue (max 3), MIME type inference from extension, `IntersectionObserver` wrapper, abort-on-cleanup before/after `createObjectURL`, and `revokeAll()`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/loader.test.ts`
  Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
  `git add src/images/loader.ts tests/loader.test.ts`
  `git commit -m "feat: add OnDemandImageLoader with concurrency queue and blob cleanup"`

---

### Task 6: Reading View & Live Preview Image Embed Integration

**Files:**
- Create: `src/images/reading-view.ts`
- Create: `src/images/live-preview.ts`

**Interfaces:**
- Consumes: `OnDemandImageLoader`, `parseImageEmbed`, `resolveRemoteImagePath`, `PluginSettings`, `SyncState`.
- Produces:
  - `registerReadingViewImageProcessor(plugin: Plugin, getContext: () => ImageRenderContext): void`
  - `createLivePreviewImageExtension(getContext: () => ImageRenderContext): Extension`

- [ ] **Step 1: Implement `src/images/reading-view.ts`**
  Register `MarkdownPostProcessor` to scan `.internal-embed` and `img` elements whose target resolves to a remote image path not present on local vault disk (`app.vault.getAbstractFileByPath(resolved)` is null). Replace/populate with `<img>` bound to `loader.observeAndLoad(...)` and register cleanup via `ctx.addChild(new MarkdownRenderChild(...))` so `blob:` URLs are revoked when the note closes.

- [ ] **Step 2: Implement `src/images/live-preview.ts`**
  Create a CodeMirror 6 `ViewPlugin` that scans visible lines in Live Preview (when cursor is not inside the embed token) for `![[...]]` and `![](...)` patterns whose target is not on local disk, resolves via `resolveRemoteImagePath`, and renders a `WidgetType` displaying the lazy-loaded `<img>` (with `destroy()` calling the loader's cleanup).

- [ ] **Step 3: Verify TypeScript compilation & build**
  Run: `npx tsc --noEmit && node esbuild.config.mjs`
  Expected: Exit 0, `main.js` generated with no errors.

- [ ] **Step 4: Commit**
  `git add src/images/reading-view.ts src/images/live-preview.ts`
  `git commit -m "feat: add Reading View and Live Preview on-demand image renderers"`

---

### Task 7: Mobile Image Paste / Upload Without Disk Persistence

**Files:**
- Create: `src/images/paste-upload.ts`
- Test: `tests/paste-upload.test.ts`

**Interfaces:**
- Consumes: `GitLabClient`, `OnDemandImageLoader`, `SyncState`, `PluginSettings`.
- Produces in `src/images/paste-upload.ts`:
  - `uploadPastedImage(params: { bytes: ArrayBuffer; mimeType: string; attachmentFolder: string; branch: string; client: GitLabClient; state: SyncState; saveState: () => Promise<void>; now?: Date }): Promise<{ repoPath: string; wikilink: string }>`
  - `registerMobileImageUpload(plugin: Plugin, getDeps: () => PasteUploadDeps): void`

- [ ] **Step 1: Write the failing tests in `tests/paste-upload.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { uploadPastedImage } from '../src/images/paste-upload';
import type { SyncState } from '../src/types';

describe('uploadPastedImage', () => {
  it('uploads base64 image to GitLab, updates remoteImagePaths, and returns wikilink', async () => {
    const state: SyncState = { lastSyncedCommitSha: 'c0', activeConflictBranch: null, files: {}, remoteImagePaths: [] };
    const client = { createCommit: vi.fn().mockResolvedValue('c1') } as any;
    const saveState = vi.fn().mockResolvedValue(undefined);
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;

    const res = await uploadPastedImage({
      bytes,
      mimeType: 'image/png',
      attachmentFolder: 'attachments',
      branch: 'main',
      client,
      state,
      saveState,
      now: new Date('2026-11-19T04:10:00Z'),
    });

    expect(res.repoPath).toBe('attachments/Pasted image 20261119041000.png');
    expect(res.wikilink).toBe('![[attachments/Pasted image 20261119041000.png]]');
    expect(client.createCommit).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'main',
      actions: [expect.objectContaining({ action: 'create', encoding: 'base64', file_path: res.repoPath })],
    }));
    expect(state.remoteImagePaths).toContain(res.repoPath);
  });

  it('propagates network error without mutating remoteImagePaths when offline', async () => {
    const state: SyncState = { lastSyncedCommitSha: 'c0', activeConflictBranch: null, files: {}, remoteImagePaths: [] };
    const client = { createCommit: vi.fn().mockRejectedValue(new Error('Network offline')) } as any;
    await expect(uploadPastedImage({
      bytes: new Uint8Array([1]).buffer,
      mimeType: 'image/png',
      attachmentFolder: 'attachments',
      branch: 'main',
      client,
      state,
      saveState: vi.fn(),
    })).rejects.toThrow(/offline/i);
    expect(state.remoteImagePaths).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/paste-upload.test.ts`
  Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/images/paste-upload.ts`**
  Implement `uploadPastedImage` (converting `ArrayBuffer` to base64 without Node `Buffer` dependency so it works in Mobile WebView) and `registerMobileImageUpload` (handling `editor-paste` and `editor-drop` events: `evt.preventDefault()`, upload, insert `![[...]]`, and on failure show `new Notice(...)` without inserting link or writing to disk).

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/paste-upload.test.ts`
  Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
  `git add src/images/paste-upload.ts tests/paste-upload.test.ts`
  `git commit -m "feat: add mobile image paste upload directly to GitLab"`

---

### Task 8: Settings Tab, Plugin Entry Point, and Final Verification

**Files:**
- Create: `src/settings.ts`
- Create: `src/main.ts`

**Interfaces:**
- Consumes: `PluginSettings`, `DEFAULT_SETTINGS`, `SyncState`, `GitLabClient`, `SyncEngine`, `OnDemandImageLoader`, `registerReadingViewImageProcessor`, `createLivePreviewImageExtension`, `registerMobileImageUpload`.
- Produces: Complete Obsidian plugin bundled to `main.js`.

- [ ] **Step 1: Implement `src/settings.ts`**
  Add `GitLabSyncSettingTab` with fields for GitLab Base URL, Project ID/Path, Branch, Personal Access Token (password-masked input), Text Allowlist (comma-separated), Sync `.obsidian/` toggle, Attachment Folder, Auto-sync on Open toggle, Enable on Desktop (Testing) toggle, and a "Clear Conflict State" button (for after desktop merge).

- [ ] **Step 2: Implement `src/main.ts`**
  Load `settings` and `syncState` from `loadData()`, check `Platform.isMobile || settings.enableOnDesktop`, register ribbon sync button, `Sync with GitLab` command, optional pull-on-layout-ready, Reading View + Live Preview + Paste Upload extensions, and call `loader.revokeAll()` in `onunload()`.

- [ ] **Step 3: Run full test suite, typecheck, and production build**
  Run: `npx vitest run && npx tsc --noEmit && node esbuild.config.mjs`
  Expected: All unit tests pass, 0 TypeScript errors, `main.js` built cleanly.

- [ ] **Step 4: Commit**
  `git add src/settings.ts src/main.ts`
  `git commit -m "feat: wire settings tab and plugin entry point"`
