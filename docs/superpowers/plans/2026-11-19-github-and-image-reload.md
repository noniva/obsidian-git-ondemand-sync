# GitHub Support & Per-Image Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class GitHub repository sync/image support alongside GitLab with seamless settings migration and an inline per-image Reload button for failed images in Live Preview and Reading View.

**Architecture:** Introduce a shared `RemoteGitClient` contract and HTTP retry/timeout helper (`src/remote/http.ts`) consumed by both `GitLabClient` and a new `GitHubClient` (`src/github/client.ts`). Update `PluginSettings` (`provider: 'github' | 'gitlab'`, `apiUrl`) with automatic legacy `gitlabUrl` migration, neutralize UI/manifest copy while keeping `id: "gitlab-ondemand-sync"`, and add inline error/Reload recovery to `OnDemandImageLoader`.

**Tech Stack:** TypeScript, Obsidian Plugin API (`requestUrl`, `PluginSettingTab`, `setIcon`, `Notice`), CodeMirror 6, Vitest + happy-dom, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-19-github-and-image-reload-design.md`

## Global Constraints

- All network requests must use Obsidian's `requestUrl`-compatible `RequestUrlFn` (no Node `http`/`fs` or browser `fetch`).
- Zero new runtime npm dependencies.
- Keep `manifest.json` `id: "gitlab-ondemand-sync"` and command ID `"sync-with-gitlab"` unchanged; update `manifest.json` `name` to `"Git On-Demand Sync"`.
- Existing GitLab `data.json` configurations without `provider` must automatically migrate to `provider: 'gitlab'` and preserve `apiUrl`.
- Zero raw Unicode emojis in UI, notices, logs, or documentation (use Lucide icons via `setIcon` or plain text).
- Follow Ponytail (`full`) discipline: smallest complete change, zero duplicated retry/error logic across clients, focused tests, and verify with `npx vitest run`, `npx tsc --noEmit`, `node esbuild.config.mjs production`, and `node -c main.js`.

## Review Focus

- **Legacy GitLab `data.json` migration:** Existing `data.json` containing `{ gitlabUrl: 'https://gitlab.example.com', projectId: 'group/repo' }` and no `provider` must load as `provider: 'gitlab'` and `apiUrl: 'https://gitlab.example.com'`, never silently switching to GitHub.
- **GitHub URL & repo normalization:** Passing `https://github.com` as `apiUrl` must normalize to `https://api.github.com`, and `owner/repo.git` or `/owner/repo/` must normalize to `owner/repo` (while rejecting invalid single-segment strings before sending requests).
- **GitHub `truncated: true` tree fallback:** When `GET /git/trees/{ref}?recursive=1` returns `truncated: true`, `GitHubClient.getTreeRecursive` must recursively fetch subtree SHAs instead of returning a partial file list that would cause false remote deletions.
- **GitHub `403` primary/secondary rate limits:** A `403` response with `x-ratelimit-remaining: 0` or `retry-after` must trigger rate-limit retry/wait, whereas a real `403` permission error (e.g. bad token scope without rate-limit headers) must fail immediately without sleeping.
- **Per-image Reload cleanup & memory safety:** Clicking Reload multiple times or closing/unloading a note mid-retry must revoke any prior/inflight `blob:` URLs cleanly and remove the error/reload DOM container when reloaded or unloaded.

---

### Task 1: Shared Remote Contract & HTTP Retry Helper

**Files:**
- Modify: `src/types.ts`
- Create: `src/remote/http.ts`
- Modify: `src/gitlab/client.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Produces in `src/types.ts`:
  - `export type GitProvider = 'github' | 'gitlab';`
  - `export interface RemoteTreeEntry` (keep `export type GitLabTreeEntry = RemoteTreeEntry;`)
  - `export interface RemoteCommitAction` (keep `export type GitLabCommitAction = RemoteCommitAction;`)
  - `export interface CreateCommitParams`
  - `export interface RemoteGitClient` (`getBranchHead`, `getTreeRecursive`, `getRawText`, `getRawTextsBatch?`, `getRawBinary`, `createCommit`)
  - Updated `PluginSettings` (`provider: GitProvider`, `apiUrl: string`, `gitlabUrl?: string`, `enablePersistentImageCache: boolean`, `maxImageCacheMb: number`) and `DEFAULT_SETTINGS` (`provider: 'github'`, `apiUrl: 'https://api.github.com'`, `enablePersistentImageCache: true`, `maxImageCacheMb: 50`)
- Produces in `src/remote/http.ts`:
  - `export interface RequestUrlResponse`, `export type RequestUrlFn`, `export interface RemoteClientConfig`, `export interface RateLimitRetryOptions`
  - `export function getHeaderCaseInsensitive(headers: Record<string, string>, name: string): string | undefined`
  - `export function parseRateLimitDelayMs(headers: Record<string, string>, attempt: number): number`
  - `export async function sendRemoteRequest(opts: { requestFn: RequestUrlFn; url: string; label: string; headers: Record<string, string>; method?: string; body?: string; timeoutMs: number; maxRateLimitRetries: number; sleep: (ms: number) => Promise<void>; shouldRetryRateLimit?: (res: RequestUrlResponse) => boolean; onRateLimitWait?: RemoteClientConfig['onRateLimitWait'] }): Promise<RequestUrlResponse>`

- [ ] **Step 1: Write failing test for shared `sendRemoteRequest` rate-limit predicate (`429` vs `403` rate-limit vs `403` forbidden)**

Add to `tests/client.test.ts`:
```ts
it('retries 403 rate limits only when shouldRetryRateLimit returns true', async () => {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const req = vi
    .fn()
    .mockResolvedValueOnce({
      status: 403,
      text: 'rate limit',
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '1' },
    })
    .mockResolvedValueOnce({
      status: 200,
      text: 'ok',
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      headers: {},
    });

  const okRes = await sendRemoteRequest({
    requestFn: req,
    url: 'https://api.github.com/test',
    label: '/test',
    headers: {},
    timeoutMs: 5000,
    maxRateLimitRetries: 2,
    sleep,
    shouldRetryRateLimit: (r) => r.status === 429 || r.headers['x-ratelimit-remaining'] === '0',
  });
  expect(okRes.status).toBe(200);
  expect(sleep).toHaveBeenCalledTimes(1);

  const authSleep = vi.fn().mockResolvedValue(undefined);
  const forbiddenReq = vi.fn().mockResolvedValue({
    status: 403,
    text: 'Bad credentials',
    arrayBuffer: new ArrayBuffer(0),
    json: {},
    headers: {},
  });
  const badRes = await sendRemoteRequest({
    requestFn: forbiddenReq,
    url: 'https://api.github.com/test',
    label: '/test',
    headers: {},
    timeoutMs: 5000,
    maxRateLimitRetries: 2,
    sleep: authSleep,
    shouldRetryRateLimit: (r) => r.status === 429 || r.headers['x-ratelimit-remaining'] === '0',
  });
  expect(badRes.status).toBe(403);
  expect(authSleep).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client.test.ts`
Expected: FAIL because `sendRemoteRequest` does not exist yet.

- [ ] **Step 3: Update `src/types.ts`, create `src/remote/http.ts`, and refactor `src/gitlab/client.ts` to use `src/remote/http.ts` and implement `RemoteGitClient`**

- [ ] **Step 4: Run tests to verify `client.test.ts` passes**

Run: `npx vitest run tests/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/remote/http.ts src/gitlab/client.ts tests/client.test.ts
git commit -m "refactor: extract shared RemoteGitClient contract and HTTP retry helper"
```

---

### Task 2: Implement `GitHubClient` (`src/github/client.ts`)

**Files:**
- Create: `src/github/client.ts`
- Create: `tests/github-client.test.ts`

**Interfaces:**
- Consumes: `RemoteGitClient`, `RemoteTreeEntry`, `CreateCommitParams` from `../types`; `RemoteClientConfig`, `RequestUrlFn`, `getHeaderCaseInsensitive`, `sendRemoteRequest` from `../remote/http`
- Produces: `export class GitHubClient implements RemoteGitClient` with `constructor(config: RemoteClientConfig, requestFn?: RequestUrlFn)`

- [ ] **Step 1: Write failing tests in `tests/github-client.test.ts`**

Cover:
1. Base URL normalization (`https://github.com` -> `https://api.github.com`, custom GHE `https://git.corp.local/api/v3/` preserved) and `owner/repo` normalization (`owner/repo.git`, `/owner/repo/` -> `owner/repo`; invalid `only-one-segment` throws).
2. `getBranchHead(branch)` sends `GET /repos/{owner}/{repo}/branches/{encodedBranch}` with `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, and returns `commit.sha`.
3. `getTreeRecursive(ref, onPage)` fetches `/git/trees/{ref}?recursive=1`, maps entries to `RemoteTreeEntry[]`, invokes `onPage`, and recursively walks subtrees when `truncated: true`.
4. `getRawText(filePath, ref)` and `getRawBinary(filePath, ref)` fetch `/contents/{encodedSegments}?ref={ref}` with `Accept: application/vnd.github.raw+json`.
5. `getRawTextsBatch(filePaths, ref)` calls GitHub GraphQL (`/graphql` or GHE `/api/graphql`), returns non-binary non-truncated `text` map, returns empty `Map` on `404`/GraphQL errors, and throws on `401`/`403` rate limit/`429`.
6. `createCommit` creates blobs (`utf-8` / `base64`), creates tree (`base_tree`, `sha: null` for deletes), creates commit, and updates existing branch via `PATCH /git/refs/heads/...` or creates new conflict branch via `POST /git/refs` when `startSha` is provided.
7. Retries `429` and `403` with `x-ratelimit-remaining: 0` / `retry-after`, and fails immediately on non-rate-limit `403`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/github-client.test.ts`
Expected: FAIL because `src/github/client.ts` does not exist.

- [ ] **Step 3: Implement `GitHubClient` in `src/github/client.ts`**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/github-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/github/client.ts tests/github-client.test.ts
git commit -m "feat: add GitHubClient supporting REST, GraphQL batching, and Git Data commits"
```

---

### Task 3: Wire `RemoteGitClient` into `SyncEngine` & `paste-upload.ts` + Fake GitHub E2E Test

**Files:**
- Modify: `src/sync/engine.ts`
- Modify: `src/images/paste-upload.ts`
- Create: `tests/helpers/fake-github.ts`
- Modify: `tests/integration/sync-lifecycle.test.ts`

**Interfaces:**
- Consumes: `RemoteGitClient`, `RemoteTreeEntry`, `RemoteCommitAction` from `../types`
- Produces: `SyncEngineOptions.client` typed against `RemoteGitClient`; `PasteUploadDeps.client` typed against `Pick<RemoteGitClient, 'createCommit'>`

- [ ] **Step 1: Write failing E2E lifecycle test in `tests/integration/sync-lifecycle.test.ts` using `FakeGitHubServer` + `GitHubClient`**

Test initial empty-vault pull, remote image indexing, conflict push to `mobile-conflict/<timestamp>` (`startSha`), and `clearConflictBranch` reconciliation against `FakeGitHubServer`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/sync-lifecycle.test.ts`
Expected: FAIL because `FakeGitHubServer` does not exist yet.

- [ ] **Step 3: Update `src/sync/engine.ts` and `src/images/paste-upload.ts` to use `RemoteGitClient` types and neutral conflict commit messages, and implement `tests/helpers/fake-github.ts`**

- [ ] **Step 4: Run integration tests to verify they pass**

Run: `npx vitest run tests/integration/sync-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync/engine.ts src/images/paste-upload.ts tests/helpers/fake-github.ts tests/integration/sync-lifecycle.test.ts
git commit -m "feat: generalize SyncEngine and paste upload to RemoteGitClient with GitHub E2E tests"
```

---

### Task 4: Two-Tier Image Cache & Per-Image Reload Button on Failed Images

**Files:**
- Modify: `src/images/loader.ts`
- Modify: `styles.css`
- Modify: `tests/loader.test.ts`

**Interfaces:**
- Consumes: `setIcon` from `'obsidian'` (if available in environment, guarded safely with text fallback so `happy-dom` and mocks without `setIcon` work cleanly)
- Produces: Updated `OnDemandImageLoader` with:
  - Tier 1 in-memory LRU cache (`maxMemoryImages` default `50`) storing every fetched image `blob:` URL keyed by `repoPath` + `ref` (while `registerMemoryImage` matches any `ref`) so re-opening notes does not re-fetch or revoke cached `blob:` URLs until LRU eviction / `clearCache()` / `revokeAll()`.
  - Tier 2 optional bounded persistent `Cache` API storage (`gitlab-ondemand-sync-images-v1`, controlled by `isPersistentCacheEnabled?: () => boolean` and `getMaxCacheBytes?: () => number`) that restores images across app restarts and evicts oldest `X-Cached-At` entries when exceeding max MB, gracefully no-oping when `globalThis.caches` is unavailable.
  - `clearCache(): Promise<void>` clearing both Tier 1 and Tier 2 caches.
  - Inline `.gitlab-img-error-box` with `.gitlab-img-reload-btn` when `loadIntoElement` fails, hiding `imgEl` while shown, retrying via `loadIntoElement` when clicked, and cleaning up error box + tracked `blob:` URL on retry or `cleanup()`.

- [ ] **Step 1: Write failing tests in `tests/loader.test.ts`**

Cover:
1. Tier 1 LRU caches fetched remote images across repeated `loadIntoElement` / `observeAndLoad` calls with the same `ref` without extra `getRawBinary` calls, does not revoke cached `blob:` URLs on note `cleanup()`, and re-fetches if `ref` changes.
2. Tier 2 persistent `Cache` API mock hit returns cached bytes without calling `getRawBinary` and promotes to Tier 1; exceeding `maxCacheBytes` evicts oldest entries by `X-Cached-At`; `clearCache()` clears both Tier 1 and Tier 2.
3. When `getRawBinary` fails on an `imgEl` inside a container (`<span class="gitlab-ondemand-embed"><img></span>` or standalone `<img>`), `imgEl` is hidden (`display: none`), `.gitlab-img-error-box` with a `button.gitlab-img-reload-btn` (`type="button"`) is rendered, and clicking Reload triggers a fresh `getRawBinary` call, restores `imgEl`, removes `.gitlab-img-error-box`, and sets `imgEl.src = 'blob:...'`.
4. Calling `cleanup()` after a manual Reload revokes/cleans up cleanly and removes any error box.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/loader.test.ts`
Expected: FAIL because Tier 1 remote caching, Tier 2 Cache API, and `.gitlab-img-error-box` / `.gitlab-img-reload-btn` are not implemented yet.

- [ ] **Step 3: Implement Two-Tier Cache, `clearCache()`, and error/reload box lifecycle in `src/images/loader.ts` and style `.gitlab-img-error-box` + `.gitlab-img-reload-btn` in `styles.css`**

- [ ] **Step 4: Run tests to verify `loader.test.ts`, `reading-view.test.ts`, and `live-preview.test.ts` pass**

Run: `npx vitest run tests/loader.test.ts tests/reading-view.test.ts tests/live-preview.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/images/loader.ts styles.css tests/loader.test.ts
git commit -m "feat: add two-tier image cache and inline Reload button for failed images"
```

---

### Task 5: Settings Migration, Provider UI, Neutral Notices & `manifest.json`

**Files:**
- Modify: `manifest.json`
- Modify: `src/main.ts`
- Modify: `src/settings.ts`
- Modify: `tests/settings.test.ts`
- Modify: `tests/main.test.ts`
- Modify: `tests/__mocks__/obsidian.ts` (if `DropdownComponent` or `setIcon` mock helper needs extension)

**Interfaces:**
- Consumes: `GitHubClient` from `./github/client`, `GitLabClient` from `./gitlab/client`, `RemoteGitClient` from `./types`
- Produces: `GitLabOnDemandSyncPlugin.createClient()` returning `GitHubClient | GitLabClient` based on `this.settings.provider`; legacy `data.json` migration in `loadPluginData()`; provider dropdown & dynamic labels in `GitLabSyncSettingTab`; neutral `manifest.json` (`id: "gitlab-ondemand-sync"`, `name: "Git On-Demand Sync"`).

- [ ] **Step 1: Write failing tests in `tests/settings.test.ts` and `tests/main.test.ts`**

Cover:
1. Legacy `data.json` migration: `{ settings: { gitlabUrl: 'https://gitlab.corp.com', projectId: 'team/notes', token: 'glpat-1' } }` without `provider` loads as `provider: 'gitlab'` and `apiUrl: 'https://gitlab.corp.com'`.
2. Fresh `data.json` defaults to `provider: 'github'` and `apiUrl: 'https://api.github.com'`.
3. `GitLabSyncSettingTab` renders `Git Provider` dropdown (`github` / `gitlab`), switches default `apiUrl` when toggling between default URLs without clobbering custom URLs, updates repo/token descriptions, and includes `Persistent Image Cache` toggle, `Max Image Cache (MB)` input, and `Clear Image Cache` button.
4. `main.test.ts` instantiates `GitHubClient` (calling `/repos/...`) when `provider: 'github'` and `GitLabClient` (calling `/api/v4/projects/...`) when `provider: 'gitlab'`, and wires `OnDemandImageLoader` cache config.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings.test.ts tests/main.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `manifest.json`, `src/main.ts`, `src/settings.ts`, and `tests/__mocks__/obsidian.ts` if needed**

- [ ] **Step 4: Run full verification suite**

Run: `npx vitest run; npx tsc --noEmit; node esbuild.config.mjs production; node -c main.js`
Expected: All test files PASS, `tsc` 0 errors, `esbuild` exit 0, `node -c main.js` exit 0.

- [ ] **Step 5: Commit**

```bash
git add manifest.json src/main.ts src/settings.ts tests/settings.test.ts tests/main.test.ts tests/__mocks__/obsidian.ts
git commit -m "feat: add GitHub/GitLab provider selection, settings migration, and neutral branding"
```
