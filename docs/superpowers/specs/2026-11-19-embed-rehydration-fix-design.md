# Short Design: Live Preview Embed Re-hydration & Image Error Listener Order

**Date:** 2026-11-19
**Context:** Live Inspection of `<div class="internal-embed ... gitlab-ondemand-embed" data-gitlab-processed="true"><img class="gitlab-ondemand-img" style=""></div>` showed that Obsidian temporarily detaches/re-attaches `.internal-embed` DOM nodes during CodeMirror scroll/re-layout. `cleanup()` cleared the status box and loading state, while leaving `data-gitlab-processed="true"` and an empty `<img class="gitlab-ondemand-img">` child so subsequent `hydrateRemoteEmbed` calls skipped it permanently.

## Changes
1. **`src/images/reading-view.ts` (`hydrateRemoteEmbed`):**
   - Return a cleanup callback that calls `loadCleanup()` and deletes `embedEl.dataset.gitlabProcessed` so re-attached elements re-hydrate cleanly (hitting Tier 1 RAM cache in 0ms when already fetched).
   - Skip re-hydration only when `embedEl.dataset.gitlabProcessed === 'true'` **and** the child `.gitlab-ondemand-img` is actively managed (`gitlab-img-loaded` with non-empty `src`, `gitlab-img-loading`, or a visible `.gitlab-img-status-box`/`.gitlab-img-error-box`).
2. **`src/images/loader.ts` (`applyLoadedUrl`):**
   - Register `error` and `load` listeners **before** assigning `imgEl.src = url` so synchronous/microtask image load failures cannot race ahead of listener attachment.
3. **Tests (`tests/reading-view.test.ts`, `tests/live-preview.test.ts`):**
   - Verify `hydrateRemoteEmbed` re-hydrates a stale `<img class="gitlab-ondemand-img">` with `data-gitlab-processed="true"` and resets `data-gitlab-processed` on cleanup.
   - Verify a Live Preview `.internal-embed` detached and re-attached to `view.contentDOM` re-hydrates cleanly.
