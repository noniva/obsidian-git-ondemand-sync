# Unused Remote Image Cleanup & Pre-Upload Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic pre-upload image resizing/WebP compression and an interactive unused remote image cleanup workflow with a confirmation modal.

**Architecture:** Implement `compressImageForUpload` (`src/images/compress.ts`) wired into `uploadPastedImage` (`src/images/paste-upload.ts`), and `findUnusedRemoteImages` + `UnusedImagesModal` (`src/images/cleanup.ts`) wired into `src/main.ts` and `src/settings.ts` using existing `VaultTextAdapter`, `RemoteGitClient`, and `OnDemandImageLoader`.

**Tech Stack:** TypeScript, HTML5 Canvas (`createImageBitmap`, `canvas.toBlob`), Obsidian Plugin API (`Modal`, `Setting`, `Notice`), Vitest + happy-dom, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-19-cleanup-and-image-compression-design.md`

## Global Constraints

- Zero new runtime npm dependencies.
- Zero raw Unicode emojis anywhere in UI, modals, notices, logs, or docs.
- Never delete remote images silently without explicit user confirmation in `UnusedImagesModal`.
- Never delete images while `activeConflictBranch` is active or when remote `headSha !== lastSyncedCommitSha`.
- Follow Ponytail (`full`) discipline and verify with `npx vitest run; npx tsc --noEmit; node esbuild.config.mjs production; node -c main.js`.

## Review Focus

- **Canvas/WebP compression fallback:** When `createImageBitmap` or `canvas.toBlob` is missing, throws, or yields a blob larger than or equal to the original size, `compressImageForUpload` must return the original `{ bytes, mimeType }` unchanged.
- **GIF/SVG/small-image bypass:** `.gif`, `.svg`, `.ico`, and images `<= 51_200` bytes must bypass compression completely.
- **Canvas & frontmatter reference detection:** Images referenced only inside `.canvas` JSON (`"file": "Asset/diagram.png"`) or YAML frontmatter (`banner: "Asset/cover.png"`) or `<img src="...">` must NOT be flagged as unused.
- **Stale remote / conflict guard:** `planUnusedImageCleanup` must abort with an actionable error if `lastSyncedCommitSha` is null, `activeConflictBranch` is non-null, or `client.getBranchHead(branch) !== lastSyncedCommitSha`.
- **Cache & state update after deletion:** Confirming deletion in `UnusedImagesModal` must commit `delete` actions, update `lastSyncedCommitSha`, strip deleted paths from `remoteImagePaths`, save `syncState`, and clear loader cache so deleted images don't remain cached.

---

### Task 1: Pre-Upload Image Compression (`src/images/compress.ts`, `src/types.ts`, `src/images/paste-upload.ts`)

**Files:**
- Modify: `src/types.ts`
- Create: `src/images/compress.ts`
- Modify: `src/images/paste-upload.ts`
- Create: `tests/compress.test.ts`
- Modify: `tests/paste-upload.test.ts`

**Interfaces:**
- Produces in `src/types.ts`: `compressImagesOnUpload: boolean` (default `true`), `maxUploadImageDimension: number` (default `1920`) on `PluginSettings` & `DEFAULT_SETTINGS`.
- Produces in `src/images/compress.ts`:
  - `export interface CompressImageOptions { enabled?: boolean; maxDimension?: number; quality?: number; minBytesToCompress?: number; }`
  - `export async function compressImageForUpload(bytes: ArrayBuffer, mimeType: string, options?: CompressImageOptions): Promise<{ bytes: ArrayBuffer; mimeType: string }>`
- Updates in `src/images/paste-upload.ts`:
  - `UploadPastedImageParams` optional `compressOptions?: CompressImageOptions`
  - `UploadPastedImageResult` includes `bytes: ArrayBuffer; mimeType: string` (so `registerMemoryImage` uses the final compressed `Blob` & MIME type).

- [ ] **Step 1: Write failing tests in `tests/compress.test.ts` and `tests/paste-upload.test.ts`**
- [ ] **Step 2: Run `npx vitest run tests/compress.test.ts tests/paste-upload.test.ts` to verify failure**
- [ ] **Step 3: Implement `src/images/compress.ts`, update `src/types.ts` and `src/images/paste-upload.ts`**
- [ ] **Step 4: Run `npx vitest run tests/compress.test.ts tests/paste-upload.test.ts; npx tsc --noEmit`**
- [ ] **Step 5: Commit `feat: add pre-upload image resizing and WebP compression`**

---

### Task 2: Unused Remote Image Scanner & Confirmation Modal (`src/images/cleanup.ts`, `styles.css`, `tests/__mocks__/obsidian.ts`)

**Files:**
- Create: `src/images/cleanup.ts`
- Modify: `styles.css`
- Modify: `tests/__mocks__/obsidian.ts` (add `Modal` mock if missing)
- Create: `tests/cleanup.test.ts`

**Interfaces:**
- Consumes: `RemoteGitClient`, `PluginSettings`, `SyncState` from `../types`; `VaultTextAdapter` from `../sync/engine`; `resolveRemoteImagePath` from `../utils/paths`
- Produces in `src/images/cleanup.ts`:
  - `export function extractImageTargetsFromText(content: string): string[]`
  - `export async function findUnusedRemoteImages(vault: Pick<VaultTextAdapter, 'listTextFiles' | 'readText'>, remoteImagePaths: string[]): Promise<string[]>`
  - `export async function planUnusedImageCleanup(params: { settings: PluginSettings; state: SyncState; client: Pick<RemoteGitClient, 'getBranchHead' | 'getTreeRecursive'>; vault: Pick<VaultTextAdapter, 'listTextFiles' | 'readText'>; configDir?: string }): Promise<{ headSha: string; unusedPaths: string[] }>`
  - `export async function executeUnusedImageCleanup(params: { branch: string; selectedPaths: string[]; client: Pick<RemoteGitClient, 'createCommit'>; state: SyncState; saveState: () => Promise<void>; clearCache?: () => Promise<void> | void }): Promise<string>`
  - `export class UnusedImagesModal extends Modal` (checkbox list, Select All / Deselect All, Cancel, warning Delete button `Delete (K)`).

- [ ] **Step 1: Write failing tests in `tests/cleanup.test.ts`**
- [ ] **Step 2: Run `npx vitest run tests/cleanup.test.ts` to verify failure**
- [ ] **Step 3: Implement `src/images/cleanup.ts`, `Modal` mock in `tests/__mocks__/obsidian.ts`, and modal styles in `styles.css`**
- [ ] **Step 4: Run `npx vitest run tests/cleanup.test.ts; npx tsc --noEmit`**
- [ ] **Step 5: Commit `feat: add unused remote image scanner and confirmation modal`**

---

### Task 3: Wire Settings, Settings Migration & Commands (`src/main.ts`, `src/settings.ts`) + Full Verification

**Files:**
- Modify: `src/main.ts`
- Modify: `src/settings.ts`
- Modify: `tests/settings.test.ts`
- Modify: `tests/main.test.ts`

**Interfaces:**
- Consumes: `planUnusedImageCleanup`, `executeUnusedImageCleanup`, `UnusedImagesModal` from `./images/cleanup`
- Produces:
  - `GitLabOnDemandSyncPlugin.cleanupUnusedImages(): Promise<void>` + Command `'cleanup-unused-images'` (`Clean Up Unused Images`)
  - Settings controls in `GitLabSyncSettingTab`: **Optimize Images Before Upload** toggle, **Max Upload Image Dimension (px)** input, and **Clean Up Unused Images** button.
  - `loadPluginData()` defaults for `compressImagesOnUpload` (`true`) and `maxUploadImageDimension` (`1920`, clamped `>= 256`).

- [ ] **Step 1: Write failing tests in `tests/settings.test.ts` and `tests/main.test.ts`**
- [ ] **Step 2: Run `npx vitest run tests/settings.test.ts tests/main.test.ts` to verify failure**
- [ ] **Step 3: Implement wiring in `src/main.ts` and `src/settings.ts`**
- [ ] **Step 4: Run full verification `npx vitest run; npx tsc --noEmit; node esbuild.config.mjs production; node -c main.js`**
- [ ] **Step 5: Commit `feat: wire image compression settings and unused image cleanup workflow`**
