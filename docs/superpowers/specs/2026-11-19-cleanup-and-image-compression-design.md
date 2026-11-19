# Design Doc: Unused Remote Image Cleanup & Pre-Upload Image Compression

**Date:** 2026-11-19
**Branch:** `feat/gitlab-ondemand-sync`
**Status:** Draft (awaiting CEO approval)

---

## 1. Intent & Why

Two usability and storage improvements for **Git On-Demand Sync**:
1. **Clean Up Unused Remote Images (with Confirmation Popup):** Users who paste/delete notes over time accumulate orphaned images in their GitLab/GitHub repository. Because images are stored only on remote (never locally on mobile), users need an in-plugin way to find unreferenced remote images across their notes, review them in a confirmation popup, and delete selected images with one commit.
2. **Pre-Upload PNG / Large Image Compression:** Pasting screenshots on desktop or photos on mobile often produces multi-megabyte PNGs. Resizing oversized images and converting PNG/large raster images to WebP before upload drastically cuts repository bloat and mobile bandwidth without adding external dependencies.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- Add an **Optimize Images Before Upload** setting (enabled by default) that resizes images exceeding `maxWidth`/`maxHeight` (default `1920px`) and converts compressible raster images (`.png`, `.jpg`, `.jpeg`, `.bmp`, `.webp` > 50 KB) to `image/webp` (`quality: 0.85`) via HTML5 `<canvas>` (`createImageBitmap` / `HTMLImageElement`), keeping the original bytes/extension if the compressed result is not smaller or if Canvas APIs are unavailable.
- Add a **Clean Up Unused Images** button in Settings and Command Palette (`cleanup-unused-images`) that:
  - Blocks safely when `activeConflictBranch` is set or remote branch moved/needs sync, or fetches the latest remote tree before computing orphans.
  - Scans all allowlisted text files in the vault (`.md`, `.canvas`, `.txt`) for image references (`![[...]]`, `![](...)`, HTML `<img src="...">`, `.canvas` file/node references, and YAML/markdown paths) using `resolveRemoteImagePath`.
  - Opens an Obsidian `Modal` listing every unreferenced remote image path with checkboxes (default all checked), Select All / Deselect All helpers, and explicit `Cancel` and `Delete (N)` buttons.
  - Deletes only user-confirmed images in a single `client.createCommit` (`delete` actions), updates `syncState.remoteImagePaths` + `lastSyncedCommitSha` if clean, and invalidates deleted entries from `OnDemandImageLoader`.

### Non-Goals
- No external WASM/npm image codecs (e.g. `sharp`, `squoosh`, `browser-image-compression`).
- No automatic/silent deletion of remote images during normal sync without explicit user confirmation in the popup modal.
- No compression of animated GIFs (`.gif`), vector SVGs (`.svg`), or icons (`.ico`).

### Anti-Goals
- Never delete an image that is referenced in `.canvas` files, HTML `<img>` tags, or markdown/wikilink embeds.
- Never silently upload a corrupted/empty buffer if `<canvas>` conversion fails; always fall back to the original image bytes.
- Never use raw Unicode emojis in modal titles, buttons, notices, or settings.

---

## 3. Constraints

- Must work in Obsidian Desktop (Electron) and Mobile (iOS WebKit / Android WebView) with zero new runtime npm dependencies.
- Must work cleanly in Vitest (`happy-dom`) with injectable/mockable image compression hooks and `Modal` mocks.
- Follow Ponytail (`full`) discipline and Sandy's 6 Native Quality Gates.

---

## 4. Architecture & Key Decisions

### 4.1 Pre-Upload Image Compression (`src/images/compress.ts` + `src/images/paste-upload.ts`)
- **Settings (`PluginSettings`):**
  - `compressImagesOnUpload: boolean` (default `true`)
  - `maxUploadImageDimension: number` (default `1920`, clamped `>= 256`)
  - `imageUploadQuality: number` (default `0.85`)
- **Compression Pipeline (`compressImageForUpload(bytes, mimeType, options)`):**
  - Skip immediately if `!enabled`, or MIME type is `image/gif`, `image/svg+xml`, `image/x-icon`, `image/vnd.microsoft.icon`, or `bytes.byteLength <= 51_200` (50 KB) unless dimensions exceed `maxDimension`? Simpler & faster: skip `<= 51_200` bytes altogether so small icons/thumbnails stay untouched!
  - Decode via `createImageBitmap(new Blob([bytes], { type: mimeType }))` (closing `bitmap.close()` in `finally`). If `createImageBitmap` is unavailable, gracefully return `{ bytes, mimeType }`.
  - Compute scaled dimensions preserving aspect ratio (`Math.min(1, maxDimension / Math.max(width, height))`).
  - Draw onto an offscreen `<canvas>` (`document.createElement('canvas')`) and export `canvas.toBlob(..., 'image/webp', quality)`.
  - If WebP `blob` is non-null and `blob.size < bytes.byteLength`, return `{ bytes: await blob.arrayBuffer(), mimeType: 'image/webp' }`; otherwise return original `{ bytes, mimeType }`.
  - Wrap the entire function in `try/catch` so any decode/canvas failure falls back safely to the original `{ bytes, mimeType }`.
- **Integration in `paste-upload.ts`:**
  - `uploadPastedImage` runs `compressImageForUpload` before `arrayBufferToBase64`, so the generated filename automatically gets `.webp` when converted and the `Blob` stored in `loader.registerMemoryImage` matches the uploaded format.

### 4.2 Unused Remote Image Cleanup (`src/images/cleanup.ts` + `src/settings.ts` + `src/main.ts`)
- **Reference Scanner (`findUnusedRemoteImages(vault, remoteImagePaths)`):**
  - Read all allowlisted text files via `vault.listTextFiles()` + `vault.readText(path)`.
  - For each file:
    - Extract wikilink embeds/links `![[target]]` / `[[target]]` (stripping `|alias` and `#fragment`).
    - Extract markdown image/link targets `![alt](target)` / `[text](target)` (supporting `<...>` and balanced parentheses).
    - Extract HTML `<img src="...">` attributes.
    - For `.canvas` files (and general fallback): also match any image extension substring (`[^\s"'`<>()[\]{}|]+?\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|ico|tiff?)` case-insensitive) inside `.canvas` JSON / YAML frontmatter (`banner:`, `cover:`, `image:`)!
    - Resolve each candidate target via `resolveRemoteImagePath(target, noteDir, remoteImagePaths)` (with `decodeTarget: true`) and add any resolved path to `referenced`.
  - Return sorted list of `remoteImagePaths` not present in `referenced`.
- **Safety Preconditions before Scanning (`planUnusedImageCleanup`):**
  - Require configured `projectId` and `token` and `lastSyncedCommitSha !== null` (abort with actionable Notice if vault hasn't synced yet).
  - Abort if `activeConflictBranch` is set (user must merge/clear conflict first).
  - Fetch fresh `headSha = await client.getBranchHead(branch)` and `tree = await client.getTreeRecursive(headSha)` to obtain the authoritative live list of `remoteImagePaths` (and abort if `headSha !== lastSyncedCommitSha`, telling user to run **Sync with Git** first so they don't delete images referenced by un-synced remote notes!).
- **Confirmation Popup (`UnusedImagesModal extends Modal`):**
  - If unused list is empty: show `Notice('No unused remote images found.')` without opening a modal.
  - Otherwise open `UnusedImagesModal`:
    - Title: `Clean Up Unused Remote Images`
    - Subtitle: `Found N image(s) not referenced in any note on branch "<branch>".`
    - Select All / Deselect All toggle link/button + scrollable list of checkboxes for each unused path.
    - Footer: `Cancel` button + destructive `Delete (K)` button (`mod-warning`), disabled when `K === 0`.
  - On confirm:
    - Show progress Notice (`Deleting K unused image(s)...`), call `client.createCommit({ branch, commitMessage: 'Clean up unused images', actions: selected.map(p => ({ action: 'delete', file_path: p })) })`.
    - Update `syncState.lastSyncedCommitSha = newHeadSha`, remove deleted paths from `syncState.remoteImagePaths`, save `syncState`, and clear `OnDemandImageLoader` cache (`clearCache()` or evict deleted paths) so deleted images don't linger in cache.
    - Show completion Notice: `Deleted K unused image(s) from "<branch>".`

---

## 5. Left to the Builder

- Exact CSS classes for `.gitlab-cleanup-modal-list` and `.gitlab-cleanup-modal-actions` using Obsidian CSS variables.
- Exact `Modal` mock extensions in `tests/__mocks__/obsidian.ts`.
- Unit tests for `compressImageForUpload`, `findUnusedRemoteImages`, `planUnusedImageCleanup` (stale `headSha` guard, conflict guard, `.canvas` + frontmatter references), and `UnusedImagesModal` confirm/cancel behavior.
