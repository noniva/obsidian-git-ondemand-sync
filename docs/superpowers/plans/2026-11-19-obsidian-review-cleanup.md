# Obsidian Community Review Cleanup (`0.2.3`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all `1.4.0`-compatible Obsidian Community Review `[Warning]` items, add GitHub Artifact Attestations to the release workflow, and install `eslint-plugin-obsidianmd` locally so `npm run lint` catches Obsidian rules before pushing.

**Architecture:** Install `eslint`, `typescript-eslint`, and `eslint-plugin-obsidianmd` as devDependencies with a flat `eslint.config.mjs` (`npm run lint`), then fix the warnings in two focused code tasks (timers/globals/configDir/trash/instanceOf first, then `createEl` DOM helpers), and finally bump to `0.2.3` and push the tag so `.github/workflows/release.yml` builds, attests, and publishes the release.

**Tech Stack:** TypeScript 5.6, Vitest (`happy-dom`), esbuild, `eslint` + `eslint-plugin-obsidianmd`, GitHub Actions (`actions/attest-build-provenance@v4`).

**Spec:** [2026-11-19-obsidian-review-cleanup-design.md](docs/superpowers/specs/2026-11-19-obsidian-review-cleanup-design.md)

## Global Constraints

- `manifest.json` `minAppVersion` MUST remain `"1.4.0"`.
- `package.json` `obsidian` devDependency MUST remain `"^1.7.2"` (do NOT adopt `getSettingDefinitions()` which requires `1.13.0+`).
- Zero raw Unicode emojis in code, notices, logs, or docs.
- On `0.2.3` release, let `.github/workflows/release.yml` create the GitHub Release on tag push (do NOT pre-create via REST API).

## Review Focus

- `happy-dom` in Vitest does not ship Obsidian's `HTMLElement.prototype.createEl` / `createDiv` / `createSpan` or `Node.prototype.instanceOf` by default: tests must polyfill or mock them cleanly without leaking into production code.
- Replacing `globalThis` with `window` in `src/utils/paths.ts`, `src/images/loader.ts`, and `src/main.ts` must still work in Vitest (`happy-dom` provides `window`).
- Replacing `.obsidian` fallback literals in `src/utils/paths.ts`, `src/sync/engine.ts`, `src/images/paste-upload.ts`, `src/main.ts`, and `src/settings.ts` must preserve default ignore behavior when `configDir` is passed from `app.vault.configDir` or test fixtures.
- `FileManager.trashFile(file)` in `src/images/paste-upload.ts` must be tested with an explicit mock assertion on `plugin.app.fileManager.trashFile`.
- `npm run lint` must exit `0` (or zero errors/warnings on all `1.4.0`-compatible rules) before bumping `0.2.3`.

---

### Task 1: Local Obsidian ESLint (`eslint-plugin-obsidianmd`) & Release Attestation CI

**Files:**
- Create: `eslint.config.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Produces: `npm run lint` (`eslint src`) and updated `.github/workflows/release.yml` with `actions/attest-build-provenance@v4`.

- [ ] **Step 1: Install ESLint & `eslint-plugin-obsidianmd` devDependencies**

Run: `npm install -D eslint typescript-eslint eslint-plugin-obsidianmd`
Expected: `package.json` and `package-lock.json` updated cleanly with exit code 0.

- [ ] **Step 2: Create `eslint.config.mjs` and add `"lint": "eslint src"` to `package.json`**

Configure flat ESLint config using `typescript-eslint` + `eslint-plugin-obsidianmd` recommended rules targeting `src/**/*.ts`.

- [ ] **Step 3: Run `npm run lint` to confirm baseline matches Obsidian Community Review warnings**

Run: `npm run lint`
Expected: Reports the known Obsidian warnings (zero crashes/config errors).

- [ ] **Step 4: Update `.github/workflows/release.yml`**

Add `id-token: write` and `attestations: write` permissions, add `- run: npm run lint` before build, and add `actions/attest-build-provenance@v4` with `subject-path` for `main.js`, `manifest.json`, `styles.css` before `softprops/action-gh-release@v2`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json eslint.config.mjs .github/workflows/release.yml
git commit -m "chore: add eslint-plugin-obsidianmd lint script and release provenance attestation"
```

---

### Task 2: Timers, `window`, `Vault#configDir`, `FileManager.trashFile()`, and `.instanceOf()`

**Files:**
- Modify: `src/github/client.ts:99`
- Modify: `src/gitlab/client.ts:68`
- Modify: `src/remote/http.ts:98-130`
- Modify: `src/settings.ts:20-40,170-180`
- Modify: `src/images/loader.ts:84,288,363-366,435,456,485`
- Modify: `src/main.ts:67,146`
- Modify: `src/utils/paths.ts:91-97,251`
- Modify: `src/sync/engine.ts:115`
- Modify: `src/images/paste-upload.ts:391,419`
- Modify: `src/images/reading-view.ts:167`
- Test: `tests/paste-upload.test.ts`, `tests/reading-view.test.ts`, `tests/settings.test.ts`, `tests/paths.test.ts`

**Interfaces:**
- Consumes: `npm run lint` from Task 1.
- Produces: Zero lint warnings for `setTimeout`, `clearTimeout`, `globalThis`, `.obsidian` / `Vault#configDir`, `Vault.delete()`, and `instanceof HTMLImageElement`.

- [ ] **Step 1: Update tests for `trashFile` and `Node.prototype.instanceOf` in `tests/`**

Update `tests/paste-upload.test.ts` mock `app.fileManager.trashFile` and `tests/reading-view.test.ts` mock/polyfill for `el.instanceOf(HTMLImageElement)`.

- [ ] **Step 2: Replace `setTimeout` / `clearTimeout` with `window.setTimeout` / `window.clearTimeout`**

Update `src/github/client.ts`, `src/gitlab/client.ts`, `src/remote/http.ts`, `src/settings.ts`.

- [ ] **Step 3: Replace `globalThis` with `window`**

Update `src/images/loader.ts`, `src/main.ts`, `src/utils/paths.ts`.

- [ ] **Step 4: Replace hardcoded `.obsidian` literals with `configDir` parameter / `app.vault.configDir` and `Vault.delete()` with `FileManager.trashFile()`**

Update `src/utils/paths.ts`, `src/sync/engine.ts`, `src/images/paste-upload.ts`, `src/main.ts`, `src/settings.ts`.

- [ ] **Step 5: Replace `el instanceof HTMLImageElement` with `el.instanceOf(HTMLImageElement)` in `src/images/reading-view.ts:167`**

- [ ] **Step 6: Verify tests and lint**

Run: `npx vitest run; npm run lint`
Expected: All 151+ tests pass; zero warnings remain for timers, `globalThis`, `configDir`, `trashFile`, and `instanceOf`.

- [ ] **Step 7: Commit**

```bash
git add src/ tests/
git commit -m "fix: resolve window timer, globalThis, configDir, trashFile, and instanceOf warnings"
```

---

### Task 3: Migrate `document.createElement` to Obsidian `createEl` / `createDiv` / `createSpan`

**Files:**
- Modify: `src/images/cleanup.ts:250-315`
- Modify: `src/images/compress.ts:54`
- Modify: `src/images/live-preview.ts:123-126`
- Modify: `src/images/loader.ts:560-585`
- Modify: `src/images/reading-view.ts:87`
- Modify: `src/main.ts:485-500`
- Test: `tests/cleanup.test.ts`, `tests/compress.test.ts`, `tests/live-preview.test.ts`, `tests/loader.test.ts`, `tests/reading-view.test.ts`, `tests/main.test.ts`

**Interfaces:**
- Consumes: `npm run lint` from Task 1.
- Produces: Zero `obsidianmd/prefer-create-el` warnings across `src/`.

- [ ] **Step 1: Add/verify Obsidian DOM helper polyfills (`createEl`, `createDiv`, `createSpan`) in test setup where `happy-dom` is used**

Ensure `createEl` / `createDiv` / `createSpan` on `HTMLElement.prototype` (and global `createEl` for detached elements like `<canvas>` or `<img>`) work cleanly in Vitest.

- [ ] **Step 2: Convert all 27 `document.createElement` calls in `src/` to `createEl` / `createDiv` / `createSpan`**

Convert parented elements via `parent.createEl(...)` / `parent.createDiv(...)` / `parent.createSpan(...)` and detached elements (`compress.ts`, `live-preview.ts`, `reading-view.ts`, `loader.ts`) via `createEl(...)` / `createDiv(...)` / `createSpan(...)`.

- [ ] **Step 3: Verify tests, lint, and typecheck**

Run: `npx vitest run; npm run lint; npx tsc --noEmit`
Expected: All tests pass, `obsidianmd/prefer-create-el` reports 0 warnings, `tsc --noEmit` exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/ tests/
git commit -m "refactor: replace document.createElement with Obsidian createEl helpers"
```

---

### Task 4: Bump `0.2.3`, Full Verification, Tag Push & Test Vault Deploy

**Files:**
- Modify: `manifest.json`, `package.json`, `versions.json`
- Deploy: `D:\Obsidian\TestPlugin\.obsidian\plugins\gitlab-ondemand-sync\`

- [ ] **Step 1: Bump version to `0.2.3` in `manifest.json`, `package.json`, `versions.json`**
- [ ] **Step 2: Run full local verification**

Run: `npm run lint; npx vitest run; npx tsc --noEmit; node esbuild.config.mjs production; node -c main.js`
Expected: All exit 0.

- [ ] **Step 3: Commit, tag `0.2.3`, and push `main` + `0.2.3` to `origin`**

Let `.github/workflows/release.yml` build, attest (`actions/attest-build-provenance@v4`), and publish GitHub Release `0.2.3`.

- [ ] **Step 4: Deploy `main.js`, `manifest.json`, `styles.css` to `D:\Obsidian\TestPlugin\.obsidian\plugins\gitlab-ondemand-sync\` (without touching `data.json`)**
