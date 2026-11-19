# Short Design: Thumbnail Previews in `UnusedImagesModal`

**Date:** 2026-11-19
**Context:** Users reviewing unused remote images in `UnusedImagesModal` want visual thumbnail previews before confirming deletion.

## Design
- Add optional `loader?: Pick<OnDemandImageLoader, 'observeAndLoad'>` to `UnusedImagesModalOptions` in `src/images/cleanup.ts` and pass `this.loader` from `src/main.ts`.
- Render each modal row as `<div class="gitlab-cleanup-modal-item">` containing:
  - `<label class="gitlab-cleanup-modal-label">` wrapping the checkbox and file path text (so clicking an inline Reload button inside the thumbnail never toggles the checkbox).
  - `<div class="gitlab-cleanup-modal-thumb"><img class="gitlab-cleanup-thumb-img" alt="..."></div>` (`48x48` px, `object-fit: cover`).
- When `loader` is provided, call `loader.observeAndLoad(thumbImg, filePath, this.opts.branch)` and store the returned cleanup callbacks; invoke and clear all of them in `onClose()` (and before re-rendering `onOpen()`).
