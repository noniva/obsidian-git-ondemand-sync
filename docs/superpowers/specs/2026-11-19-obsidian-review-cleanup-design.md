# Design: Obsidian Community Review Cleanup & Pre-Push Linting (`0.2.3`)

**Date:** 2026-11-19  
**Target Version:** `0.2.3`  
**Status:** Draft (awaiting CEO approval)

---

## 1. Intent & Why

Version `0.2.2` passed Obsidian Community Directory's blocking checks (`Status: Completed`, 0 errors), leaving 8 non-blocking `[Warning]` items and 2 `[Recommendation]` items (plus `display` deprecation tied to `1.13.0+`).  
Cleaning up all `1.4.0`-compatible warnings, adding GitHub Artifact Attestations, and installing Obsidian's official ESLint plugin locally prevents future release rejections and improves popout-window and custom-config-dir compatibility.

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- Add local pre-push linting using Obsidian's official `eslint-plugin-obsidianmd` (`npm run lint`).
- Resolve all 7 code-quality `[Warning]` categories compatible with `minAppVersion: "1.4.0"`:
  1. `window.setTimeout()` / `window.clearTimeout()`
  2. `window` / `activeWindow` instead of `globalThis`
  3. `Vault#configDir` instead of hardcoded `.obsidian`
  4. `FileManager.trashFile()` instead of `Vault.delete()`
  5. `.instanceOf(HTMLImageElement)` instead of `instanceof HTMLImageElement`
  6. Obsidian `createEl` / `createDiv` / `createSpan` instead of `document.createElement` (27 sites)
- Add GitHub Artifact Attestations (`actions/attest-build-provenance@v4`) + `npm run lint` to `.github/workflows/release.yml`.
- Keep all 151+ Vitest tests, `tsc --noEmit`, `esbuild` production build, and `npm run lint` passing.

### Non-Goals
- Adopting `getSettingDefinitions()` (requires Obsidian `1.13.0+`, whereas `minAppVersion` is `1.4.0` and `obsidian` devDependency is `^1.7.2`).
- Changing plugin sync/cache behavior, UI layout, or user-facing settings schema.

### Anti-Goals
- Breaking existing happy-dom Vitest tests or Node/non-Obsidian test environments when introducing `createEl` or `.instanceOf()`.
- Bumping `minAppVersion` above `1.4.0`.

## 3. Constraints

- `manifest.json` `minAppVersion` remains `"1.4.0"`.
- `package.json` `obsidian` devDependency remains `"^1.7.2"`.
- Zero raw Unicode emojis anywhere in code, notices, or docs.
- On tag push for `0.2.3`, GitHub Actions `release.yml` creates the GitHub Release and attests `main.js`, `manifest.json`, and `styles.css` (do not pre-create the release via REST API).

## 4. Approaches Considered

### 4.1 Local Pre-Check Script
- **Approach A (Selected by CEO):** Install `eslint`, `typescript-eslint`, and `eslint-plugin-obsidianmd` as `devDependencies`, configure `eslint.config.mjs` with Obsidian's official ruleset, and expose `"lint": "eslint src"` in `package.json`.
  - *Trade-off:* Adds dev dependencies to `package-lock.json` (zero impact on `main.js` bundle), but matches the exact scanner used by `community.obsidian.md`.
- **Approach B (Rejected):** Custom regex/AST script — lighter, but misses type-aware Obsidian rules.

### 4.2 CI Release & Artifact Attestations
- **Approach A (Selected by CEO):** Extend existing `.github/workflows/release.yml` with `id-token: write`, `attestations: write`, `npm run lint`, and `actions/attest-build-provenance@v4` before `softprops/action-gh-release@v2`.
  - *Trade-off:* Keeps full control over `npm test` + `npm run lint` + `npm run build` order.
- **Approach B (Rejected):** Replace workflow with `obsidianmd/obsidian-workflows@v1` — less transparent control over custom test/lint steps.

## 5. High-Level Design

1. **Tooling & CI (`eslint.config.mjs`, `package.json`, `.github/workflows/release.yml`)**
   - Install `eslint`, `typescript-eslint`, `eslint-plugin-obsidianmd`.
   - Add `"lint": "eslint src"` to `package.json` scripts.
   - Update `.github/workflows/release.yml` permissions (`contents: write`, `id-token: write`, `attestations: write`), run `npm run lint`, `npm test`, `npm run build`, run `actions/attest-build-provenance@v4` on `main.js`, `manifest.json`, `styles.css`, then create GitHub Release.
2. **Window, Timer & Type-Check Helpers**
   - Replace `setTimeout` / `clearTimeout` with `window.setTimeout` / `window.clearTimeout` in `src/github/client.ts`, `src/gitlab/client.ts`, `src/remote/http.ts`, `src/settings.ts`.
   - Replace `globalThis` with `window` (or `activeWindow` where appropriate) in `src/images/loader.ts`, `src/main.ts`, `src/utils/paths.ts`.
   - Replace `el instanceof HTMLImageElement` in `src/images/reading-view.ts` with `el.instanceOf(HTMLImageElement)` (with test mock support in `tests/` if happy-dom lacks `Node.prototype.instanceOf`).
3. **Vault Config Dir & Trash Deletion**
   - Thread `configDir` (defaulting to `this.app.vault.configDir` at plugin/engine/settings boundaries) into `src/utils/paths.ts`, `src/sync/engine.ts`, `src/settings.ts`, `src/main.ts`, and `src/images/paste-upload.ts` so no hardcoded `.obsidian` remains in runtime paths.
   - Replace `this.app.vault.delete(file)` with `this.app.fileManager.trashFile(file)` in `src/images/paste-upload.ts`.
4. **Obsidian DOM Helpers (`createEl` / `createDiv` / `createSpan`)**
   - Convert all 27 `document.createElement(...)` calls across `src/images/cleanup.ts`, `src/images/compress.ts`, `src/images/live-preview.ts`, `src/images/loader.ts`, `src/images/reading-view.ts`, and `src/main.ts` to Obsidian's `createEl` / `createDiv` / `createSpan` helpers (and ensure Vitest/happy-dom test setup polyfills `createEl`/`createDiv`/`createSpan` if needed without altering production behavior).

## 6. Left to Implementation Plan / Builder

- Exact `eslint.config.mjs` flat-config wiring compatible with `eslint-plugin-obsidianmd` and TypeScript 5.6.
- Verifying whether `compress.ts` (offscreen `<canvas>` / `<img>`) can use global `createEl` or `activeDocument` cleanly without failing `obsidianmd/prefer-create-el`.
- Updating `tests/` mocks/polyfills so all existing and new tests pass cleanly under happy-dom.
