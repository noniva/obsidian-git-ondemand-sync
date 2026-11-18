# Design Doc: Obsidian GitLab On-Demand Image & Text Sync Plugin

**Date:** 2026-11-19
**Status:** Ready for Approval

---

## 1. Intent & Why

The user stores their Obsidian vault in a **private GitLab repository** and currently uses **Obsidian Git**. On desktop, everything works well with local files. On **mobile**, however, the large number of images in the vault consumes excessive device storage—both from the working tree files and from `.git` packfiles/objects.

The goal is an Obsidian plugin that lets the user read notes, view images, edit/write notes, and occasionally paste/upload new images on mobile **without storing images or `.git` history on mobile storage**, while keeping the desktop workflow completely normal.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Zero persistent image storage on mobile:** Images are never written to the mobile vault directory or `.git` packfiles. They are fetched on-demand over HTTPS from GitLab when a note is viewed and held only in memory (`blob:` URLs) while needed.
- **Lightweight text-only sync on mobile:** Sync text/note files (`.md`, `.canvas`, and non-image text/config files as configured) between mobile and a private GitLab repository using GitLab's REST API, without a local `.git` folder.
- **Support pasting/adding new images on mobile:** When the user pastes or attaches an image on mobile, upload it to the GitLab repository and reference it in the note without leaving the image file saved on mobile storage.
- **Desktop-assisted conflict resolution:** Keep desktop on normal Git / Obsidian Git with local images. When a mobile push encounters a conflict with newer desktop commits, push mobile changes to a dedicated conflict branch rooted at mobile's base commit so the desktop can perform a real 3-way Git merge.

### Non-Goals
- Replacing Obsidian Git or native `git` on desktop.
- Offline image viewing on mobile.
- Supporting non-GitLab hosts (GitHub, Gitea, bare SSH) in v1.
- Full `.git` history browsing, branching UI, or 3-way merge UI on mobile.
- Rendering remote-only images inside third-party plugins that read directly from local disk (e.g., Excalidraw, Canvas local-file internals) when those files do not exist on mobile.

### Anti-Goals
- **Never** run `git clone` or `isomorphic-git` packfile downloads on mobile (that recreates the exact storage bloat problem).
- **Never** silently overwrite desktop edits or silently discard mobile edits on conflict.
- **Never** write fetched remote images to the mobile filesystem as a "disk cache".

---

## 3. Constraints

- **Platform:** Obsidian Mobile (iOS/Android WebView, no native `git` binary, `requestUrl` available via Obsidian API) and Obsidian Desktop (TypeScript + esbuild plugin).
- **Git Host:** Private GitLab repository (supports `gitlab.com` and self-hosted GitLab instances via configurable base URL) authenticated with a GitLab Personal Access Token (`api` scope).
- **Desktop Compatibility:** Desktop continues storing `.md` and image files locally in a normal Git working tree managed by Obsidian Git / `git`.
- **Network Dependency:** Viewing images on mobile requires network connectivity. Image pasting on mobile requires network connectivity to upload immediately (or clear error feedback if offline).

---

## 4. Approaches Considered

1. **Approach 1 (Chosen): Mobile-only GitLab REST API Text Sync + On-Demand Image Loader + Conflict Branch for Desktop Merge**
   - *How:* Desktop stays untouched on Obsidian Git. Mobile uses this plugin to sync text files via GitLab REST API (Tree, Raw File, Commits APIs), loads images on-demand into memory (`blob:` URLs), uploads pasted images via API, and pushes conflicts to a `mobile-conflict/<timestamp>` branch branched from mobile's last synced commit (`start_sha`).
   - *Trade-offs:* Zero image/git-object storage on mobile and zero disruption to desktop; requires internet to view/upload images on mobile and relies on desktop for 3-way merge when conflicts occur.

2. **Approach 2: Split Repo / Orphan Branch for Images + Obsidian Git for Notes**
   - *How:* Keep `.md` in the main repo (synced by Obsidian Git on mobile and desktop) and move all images to a separate repo/branch.
   - *Trade-offs:* Keeps `Obsidian Git` merge on mobile, but breaks the user's requirement to keep desktop storage and workflow normal inside one standard repo.

3. **Approach 3: Unified Custom GitLab API Sync on Both Desktop and Mobile**
   - *How:* Replace Obsidian Git everywhere with a custom API sync plugin.
   - *Trade-offs:* Reinvents Git on desktop unnecessarily where native `git` is faster, supports offline history, and handles merges natively.

**Why Approach 1:** It directly satisfies keeping desktop completely normal while eliminating both image files and `.git` packfiles from mobile, and solves Approach 1's main weakness (no local 3-way merge on mobile) by delegating conflict merges to desktop via GitLab conflict branches.

---

## 5. Architecture & Detailed Design

### 5.1 Operating Mode (Mobile vs. Desktop)
- **My call (overridable):** The plugin detects `Platform.isMobile` (with an optional setting override for testing on desktop). By default, sync & on-demand image interception activate **only on mobile** so desktop continues using Obsidian Git without interference.
- Note files synced on mobile live in the normal Obsidian vault folder so the user can read and edit `.md` files offline between syncs.

### 5.2 GitLab API Client & Authentication
- Settings store:
  - GitLab Base URL (default `https://gitlab.com`, configurable for self-hosted)
  - Project ID or URL-encoded path (e.g., `username/vault`)
  - Target Branch (default `main`)
  - Personal Access Token (`PRIVATE-TOKEN` header, `api` scope)
  - Text sync allowlist (default: `.md`, `.canvas`, `.txt`; configurable in settings). **User decision:** Sync **text-only** files via allowlist; non-text binary files (images, PDFs, audio, video, etc.) are excluded from mobile disk sync.
  - `.obsidian/` sync toggle (My call: default off on mobile so mobile doesn't pull desktop-only plugin binaries/configs, configurable).
  - Attachment upload folder (My call: respects Obsidian's configured attachment folder or a configurable path such as `attachments/`).
  - Auto-sync behavior (My call: manual sync command/ribbon button + optional pull-on-app-open, configurable in settings).
- Uses Obsidian's `requestUrl` to avoid CORS issues in Mobile WebView.

### 5.3 Text-Only Sync Engine (Mobile)
- **Local State (`data.json`):** Stores `lastSyncedCommitSha`, optional `activeConflictBranch` (if a conflict branch is awaiting desktop merge), a map of `path -> { blobSha, localContentHash }` for synced text files, and a cached list of remote image paths (for path resolution when rendering embeds).
- **Initial Sync (New Vault):** **User decision:** Mobile setup starts from a **new/empty vault**. If `lastSyncedCommitSha` is unset and existing `.md`/text files are detected in the vault, the plugin warns and aborts initial sync rather than overwriting local files. On an empty vault, initial sync downloads all allowlisted text files from `targetBranch` and records `lastSyncedCommitSha`.
- **Pull / Sync Flow:**
  1. Fetch latest branch head commit SHA (`GET /projects/:id/repository/branches/:branch`).
  2. Fetch recursive repository tree (`GET /projects/:id/repository/tree?recursive=true&per_page=100`, paginated) at head commit.
  3. Partition tree entries into **image files** (by image extension, for on-demand rendering index), **syncable text files** (matching the UTF-8 text allowlist), and **other ignored binaries** (PDFs, audio, video, etc. — skipped).
  4. Update the remote image path index (used to resolve short wikilinks like `![[photo.png]]` to full repo paths like `attachments/photo.png` without storing the image).
  5. Diff remote text tree against local state + current vault text files:
     - Remote added/updated & local unchanged -> download raw UTF-8 text (`GET /projects/:id/repository/files/:path/raw`) and write to mobile vault.
     - Remote deleted & local unchanged -> remove from mobile vault.
     - Local added/modified/deleted -> queue for push.
     - Both remote and local modified -> mark as conflict.
- **Push & Conflict Branch Flow (Desktop Merge):**
  - **No conflict (and no open `activeConflictBranch`):** Commit all local text additions/updates/deletions to `targetBranch` via `POST /projects/:id/repository/commits`. Update `lastSyncedCommitSha` and file hashes.
  - **Conflict detected** (any locally modified/deleted file has a different `blobSha` on remote than in `lastSyncedCommitSha`):
    1. **My call:** Bundle all pending local changes from that sync into one atomic commit on a new branch `mobile-conflict/YYYYMMDD-HHmmss` via `POST /projects/:id/repository/commits` using `start_sha: lastSyncedCommitSha`.
    2. **User decision (keep mobile edits):** Keep mobile's local conflicting files on disk so the user can continue reading and editing them on mobile while waiting for desktop merge.
    3. Record `activeConflictBranch` in `data.json` and show a prominent `Notice` + status indicator instructing the user to run `git fetch` and `git merge origin/mobile-conflict/...` on desktop.
    4. **While `activeConflictBranch` is open:** Non-conflicting remote changes on `targetBranch` can still be pulled, and any further mobile edits push to `activeConflictBranch` until desktop merges it into `targetBranch` (once merged, the user can clear/re-sync cleanly with `targetBranch`).

### 5.4 On-Demand Image Loader (Zero Disk Storage)
- **Supported Embeds:**
  - Obsidian wikilink embeds: `![[image.png]]`, `![[folder/image.png|300]]`, `![[image.png|alt]]`
  - Standard Markdown image links referencing vault paths: `![alt](path/to/image.png)` (external `https://` URLs are left untouched).
- **Rendering Integration:**
  - **Reading View:** `registerMarkdownPostProcessor` finds unresolved/missing local image embeds (`span.internal-embed` or `img` elements whose target is an image path not present on local disk), resolves the repo path using the synced remote tree index, and attaches a lazy-load placeholder.
  - **Live Preview:** CodeMirror 6 `ViewPlugin` / `StateField` decorations detect image embed syntax (`![[...]]` / `![](...)`) when the file is not on local disk and render an inline image widget (respecting optional width like `|300`).
- **Lazy Loading & Memory Lifecycle:**
  - Use `IntersectionObserver` so images are fetched **only when scrolled near/into the viewport**, with a bounded concurrent fetch queue (e.g., max 3–4 concurrent requests).
  - Fetch raw bytes via `requestUrl` with `PRIVATE-TOKEN`, convert `ArrayBuffer` to `Blob`, create `URL.createObjectURL(blob)`, and set `<img src="blob:...">`.
  - **No disk write:** Never call `vault.adapter.writeBinary` for viewed images.
  - **Memory cleanup:** Track active `blob:` URLs per note/view (or small bounded in-memory LRU cache cleared on view close / plugin unload) and call `URL.revokeObjectURL` when closed/evicted so mobile RAM stays bounded.

### 5.5 Mobile Image Paste / Upload
- **Interception:** Listen to editor `paste` and `drop` events (and/or attachment creation) on mobile when the clipboard/payload contains an image (`image/*`).
- **Flow:**
  1. Prevent Obsidian from writing the image file permanently to the mobile vault (or if Obsidian's native camera/file picker creates a temporary file, intercept/upload and immediately delete the temporary local file).
  2. Read the image bytes in memory, generate a target repo path (e.g., `<attachmentFolder>/Pasted image YYYYMMDDHHmmss.png`).
  3. Upload directly to the target GitLab branch via `POST /projects/:id/repository/commits` (`encoding: "base64"`, action `create`).
  4. Update the local remote-image-path index and insert `![[...]]` into the active note.
  5. Display the uploaded image immediately using the in-memory `blob:` URL without keeping it on disk.
  6. **Offline guard:** If the upload fails (e.g., offline), show a clear `Notice` explaining that image upload requires an internet connection and do not leave orphaned broken links or hidden disk files.

---

## 6. What's Left to the Builder

- Obsidian plugin project scaffolding (`package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json` with `isDesktopOnly: false`).
- Exact CodeMirror 6 widget & `MarkdownPostProcessor` DOM matching across Obsidian mobile themes and Obsidian versions.
- Pagination details, retry/backoff, and URL encoding edge cases for GitLab file paths (nested folders, spaces, Unicode filenames).
- Optional convenience features (e.g., autocomplete suggester for remote images on `![[`) if easy to add cleanly without bloating scope.
- Unit tests (e.g., sync diffing logic, conflict detection, path resolution, GitLab API payload construction) and manual verification checklist on Obsidian Mobile + Desktop.
