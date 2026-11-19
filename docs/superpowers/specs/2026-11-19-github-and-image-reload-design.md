# Design Doc: GitHub Support & Per-Image Reload Button

**Date:** 2026-11-19
**Branch:** `feat/gitlab-ondemand-sync`
**Status:** Draft (awaiting CEO approval)

---

## 1. Intent & Why

The plugin currently syncs text-only Obsidian notes and lazy-loads remote images in memory exclusively against GitLab. To publish the plugin to **Obsidian Community Plugins** so the broader Obsidian community (where most users host vaults on GitHub) can adopt it, we need:

1. **First-class GitHub support** alongside existing GitLab support, selectable in Settings, without breaking existing GitLab configurations (`data.json`) or installed plugin folders.
2. **A per-image Reload button** directly at the position of any failed remote image in both Live Preview and Reading View so users can manually retry individual images without reloading the note or re-syncing the whole vault.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- Support **GitHub.com** and **GitHub Enterprise Server** (custom API URL) via a new `GitHubClient` implementing the same remote contract as `GitLabClient`.
- Introduce a `RemoteGitClient` interface so `SyncEngine`, `OnDemandImageLoader`, and `paste-upload.ts` work identically across GitHub and GitLab.
- Add a **Git Provider** selector (`GitHub` / `GitLab`) in Settings, defaulting to `GitHub` for new installs while automatically migrating existing GitLab `data.json` configs to `provider: 'gitlab'`.
- Keep `manifest.json` `id` as `"gitlab-ondemand-sync"` (preserving existing installations) while updating `manifest.json` `name`/`description` and user-facing UI/Notice text to be provider-neutral (`Git On-Demand Sync`).
- Display an inline **Reload** button (Lucide icon + text, zero raw emojis) at the exact location of any remote image that fails to load, in both Live Preview and Reading View.
- Cache loaded remote images across note switches (in-memory LRU cache) and across app restarts (bounded Web Cache API storage with configurable MB limit and a Clear Image Cache action in Settings) without writing image files into the vault directory.

### Non-Goals
- No OAuth browser login flow (Personal Access Token remains the auth mechanism for serverless mobile/desktop compatibility).
- No change to the core sync model (allowlisted UTF-8 text files only on disk; images stay remote and load on demand into in-memory `blob:` URLs).
- No change to `manifest.json` `id` or existing Obsidian command IDs (`sync-with-gitlab`) so existing user hotkeys and installations remain intact.

### Anti-Goals
- Never write remote image files to local vault storage.
- Never break or overwrite existing GitLab users' `data.json` settings or sync state.
- Never mix `if (provider === 'github')` branches inside `GitLabClient`.
- Never use raw Unicode emojis in UI, notices, or documentation.

---

## 3. Constraints

- All HTTP calls must use Obsidian's `requestUrl` (no Node `http`/`fs` or browser `fetch`) for iOS/Android/Desktop compatibility.
- Zero new runtime npm dependencies.
- Must handle GitHub API rate limits (`429` and `403` when `x-ratelimit-remaining: 0` or `retry-after` is present) with bounded retry/backoff and live progress feedback.
- Must follow Ponytail (`full`) discipline and Sandy's 6 Native Quality Gates.

---

## 4. Approaches Considered

### Approach 1: Unified `RemoteGitClient` Interface (`GitHubClient` + `GitLabClient`) + Community-Ready UI (Selected)
- Define a shared `RemoteGitClient` interface covering the 6 operations used by sync, image loading, and paste upload (`getBranchHead`, `getTreeRecursive`, `getRawText`, optional `getRawTextsBatch`, `getRawBinary`, `createCommit`).
- Implement `GitHubClient` (`src/github/client.ts`) independently from `GitLabClient` (`src/gitlab/client.ts`).
- Add `provider` + `apiUrl` settings with automatic migration from legacy `gitlabUrl`, provider-aware Settings labels, and neutral UI/Notice wording.
- Add a shared per-image error/reload UI mechanism in `OnDemandImageLoader` / embed containers.
- **Tradeoff:** Adds a dedicated `GitHubClient` and GitHub Git Data API commit tests, in exchange for clean isolation between providers and zero duplication in `SyncEngine`.

### Approach 2: Branching `if/else` Inside `GitLabClient` & Keeping GitLab-Only Branding (Rejected)
- **Why rejected:** Coupling GitHub's Git Data API and GitLab's REST API inside one class creates fragile conditionals, and keeping GitLab-only UI/manifest naming confuses GitHub users in Obsidian Community Plugins.

---

## 5. Architecture & Key Decisions

### 5.1 Shared Remote Client Contract (`src/types.ts` / `src/remote/client.ts`)
- Define `RemoteTreeEntry`, `RemoteCommitAction`, `CreateCommitParams`, and `RemoteGitClient` (keeping `GitLabTreeEntry` and `GitLabCommitAction` as exported type aliases for backwards compatibility with existing imports/tests).
- Update `SyncEngine`, `OnDemandImageLoader` (`getRawBinary`), and `paste-upload.ts` (`createCommit`) to depend on `RemoteGitClient` rather than the concrete `GitLabClient` class.

### 5.2 `GitHubClient` (`src/github/client.ts`)
- **Base URL & Repo Normalization:**
  - Default `apiUrl` for GitHub is `https://api.github.com`. If a user enters `https://github.com`, normalize automatically to `https://api.github.com`. Custom URLs (e.g., GitHub Enterprise `https://git.example.com/api/v3`) are trimmed and used directly.
  - Normalize `projectId` (`owner/repo`) by trimming leading/trailing slashes and optional `.git` suffix. Validate that `owner/repo` has two non-empty path segments before making requests.
- **Auth & Headers:**
  - Send `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, and `X-GitHub-Api-Version: 2022-11-28`.
- **Operations:**
  - `getBranchHead(branch)`: `GET /repos/{owner}/{repo}/branches/{encodeURIComponent(branch)}` -> return `commit.sha`.
  - `getTreeRecursive(ref, onPage)`: `GET /repos/{owner}/{repo}/git/trees/{encodeURIComponent(ref)}?recursive=1` -> map `tree` entries to `RemoteTreeEntry[]` (`id: sha`, `name: basename(path)`, `type: 'blob' | 'tree'`, `path`, `mode`). If `truncated: true`, recursively walk subtree SHAs via `GET /repos/{owner}/{repo}/git/trees/{treeSha}` so large repos do not silently miss files. Invoke `onPage?.({ page: 1, totalPages: 1, entries: entries.length })`.
  - `getRawText(filePath, ref)` / `getRawBinary(filePath, ref)`: `GET /repos/{owner}/{repo}/contents/{encodePathSegments(filePath)}?ref={encodeURIComponent(ref)}` with `Accept: application/vnd.github.raw+json`.
  - `getRawTextsBatch(filePaths, ref)`: Chunk paths (e.g. 50 per query) and `POST` to GitHub GraphQL (`/graphql` on `api.github.com`, or `<origin>/api/graphql` on GitHub Enterprise) querying aliased `repository(owner, name) { f0: object(expression: $e0) { ... on Blob { isBinary isTruncated text } } }`. Include only non-binary, non-truncated string `text` entries in the returned `Map`; throw on `401`/`403` rate-limit/`429`, and return an empty `Map` on unsupported/malformed responses so `SyncEngine` falls back cleanly to REST `getRawText`.
  - `createCommit({ branch, commitMessage, actions, startSha })`:
    1. Resolve base commit & base tree SHA: if `startSha` is set (new `mobile-conflict/<timestamp>` branch), `baseCommitSha = startSha` and fetch `GET /repos/{owner}/{repo}/git/commits/{startSha}` for `baseTreeSha`; otherwise fetch `GET /repos/{owner}/{repo}/branches/{encodeURIComponent(branch)}` for `baseCommitSha` and `commit.commit.tree.sha`.
    2. Create blobs (`POST /repos/{owner}/{repo}/git/blobs`) with bounded concurrency (4) for `create` and `update` actions (`encoding: 'base64' | 'utf-8'`).
    3. Create tree (`POST /repos/{owner}/{repo}/git/trees`) with `base_tree: baseTreeSha` and entries (`sha` for create/update, `sha: null` for `delete`).
    4. Create commit (`POST /repos/{owner}/{repo}/git/commits`) with `{ message: commitMessage, tree: newTreeSha, parents: [baseCommitSha] }`.
    5. Update or create ref: if `startSha !== undefined`, `POST /repos/{owner}/{repo}/git/refs` (`ref: "refs/heads/${branch}"`, `sha: newCommitSha`); otherwise `PATCH /repos/{owner}/{repo}/git/refs/heads/${encodePathSegments(branch)}` (`{ sha: newCommitSha, force: false }`). Return `newCommitSha`.
- **Rate-Limit Handling:**
  - Retry `429` and GitHub rate-limit `403` (`x-ratelimit-remaining === '0'` or `retry-after` header) using `Retry-After` / `x-ratelimit-reset` (clamped `1,000–65,000 ms`, default max 3 retries) and report wait countdowns via `onRateLimitWait`.

### 5.3 Settings, Migration & Community Branding
- **Settings Model (`PluginSettings`):**
  - Add `provider: 'github' | 'gitlab'` (default `'github'` in `DEFAULT_SETTINGS`).
  - Add `apiUrl: string` (default `'https://api.github.com'`). Retain optional `gitlabUrl?: string` only for loading legacy `data.json`.
  - In `loadPluginData()`: if persisted settings omit `provider` and have non-empty `gitlabUrl` or `projectId`, migrate `provider = 'gitlab'` and `apiUrl = rawSettings.gitlabUrl || 'https://gitlab.com'`.
- **Settings UI (`src/settings.ts`):**
  - Add **Git Provider** dropdown (`GitHub` / `GitLab`). Changing provider automatically switches `apiUrl` between default URLs if `apiUrl` is empty or matches the other provider's default.
  - Update URL, Repository/Project, and Token labels/descriptions dynamically based on `settings.provider` (e.g. `owner/repo` and Fine-grained PAT `Contents: Read and Write` hint for GitHub; `username/repo` or numeric ID and `api` scope hint for GitLab).
- **Manifest & User-Facing Text:**
  - `manifest.json`: keep `id: "gitlab-ondemand-sync"`, update `name` to `"Git On-Demand Sync"`, and update `description` to mention both GitHub and GitLab.
  - Update `main.ts`, `settings.ts`, and `paste-upload.ts` notices/status bar text to use neutral/provider-aware wording (e.g. `Git Sync` / `GitHub` / `GitLab`).

### 5.4 Per-Image Reload Button (`OnDemandImageLoader` + Embed Views + `styles.css`)
- **Behavior:**
  - When `OnDemandImageLoader` fails to fetch an image (in either Reading View or Live Preview), instead of leaving only an unclickable broken `<img>`, display an inline retry control inside the embed container (using Obsidian `setIcon(iconEl, 'rotate-cw')` with a text fallback + `Reload` button, `type="button"`, zero raw emojis).
  - Hide the broken `<img>` while the error box is shown so no broken-image icon overlays the button; expose `dataset.gitlabError` and `title` for diagnostics.
  - Clicking **Reload** removes the error box, restores `gitlab-img-loading` state on `imgEl`, and immediately invokes `loadIntoElement(imgEl, repoPath, ref, fallbackRef)` (bypassing `IntersectionObserver`), updating the tracked cleanup callback so closing the note/unloading still revokes any newly created `blob:` URL cleanly.
  - For standalone `<img>` elements in Reading View that have no `.gitlab-ondemand-embed` wrapper, insert the retry button immediately after `imgEl` (and remove it on retry or cleanup) so both wikilink/markdown embeds and raw `<img>` tags support Reload cleanly.

### 5.5 Two-Tier Image Cache (`OnDemandImageLoader` + Settings)
- **Tier 1 (In-Memory LRU Cache):**
  - Store every successfully fetched remote image `blob:` URL in `memoryImages` (default cap `50` entries, keyed by normalized `repoPath` + `ref`, while `registerMemoryImage` matches any `ref`).
  - Cache hits display immediately in 0ms without hitting the network; closing a note or destroying a widget does not revoke cached `blob:` URLs until LRU eviction, `clearCache()`, or plugin `onunload()`.
- **Tier 2 (Bounded Persistent Cache via Web `Cache` API):**
  - When `enablePersistentImageCache` is `true` (default `true`, `maxImageCacheMb` default `50`), store fetched image bytes in `caches.open('gitlab-ondemand-sync-images-v1')` keyed by synthetic URL `https://git-ondemand-sync.local/img?ref=<ref>&path=<repoPath>` with `X-Cached-At` and `X-Byte-Length` headers.
  - On a Tier 1 miss, check Tier 2 before making a network request; if hit, promote to Tier 1 (`blob:` URL) and update `X-Cached-At` timestamp.
  - After writing to Tier 2, evict oldest entries (`X-Cached-At` ascending) whenever total cached bytes exceed `maxImageCacheMb * 1024 * 1024`.
  - Gracefully no-op when `globalThis.caches` is unavailable. Keeps the Obsidian vault folder 100% free of image files.
- **Settings Controls:**
  - Add **Persistent Image Cache** toggle (`enablePersistentImageCache`, default `true`), **Max Image Cache (MB)** input (`maxImageCacheMb`, default `50`), and **Clear Image Cache** button (clears both Tier 1 and Tier 2 caches).

---

## 6. Left to the Builder

- Exact decomposition of shared HTTP timeout / rate-limit delay helpers between `GitLabClient` and `GitHubClient`.
- Exact CSS token styling for `.gitlab-img-error-box` and `.gitlab-img-reload-btn` using Obsidian CSS variables.
- Writing unit tests for `GitHubClient`, `SyncEngine` with fake GitHub server/responses, settings migration, and per-image Reload button interactions.
