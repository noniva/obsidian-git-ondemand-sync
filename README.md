# Git On-Demand Sync

Sync text-only Obsidian notes (`.md`, `.canvas`, `.txt`) with a private **GitHub** or **GitLab** repository via REST/GraphQL APIs, while loading and uploading images on demand in memory with **zero persistent image files on mobile disk**.

## Features

- **Text-Only Vault Sync:** Pulls and pushes allowlisted text files (`.md`, `.canvas`, `.txt`) without cloning `.git` packfiles or downloading repository images to mobile storage.
- **GitHub & GitLab Support:** Works with `github.com`, GitHub Enterprise Server, `gitlab.com`, and self-hosted GitLab instances.
- **On-Demand Image Viewing:** Lazily fetches remote images into in-memory `blob:` URLs via `IntersectionObserver` in both **Live Preview** and **Reading View**.
- **Two-Tier Image Cache:** Caches viewed images in an in-memory LRU cache (`150` entries) and an optional bounded Web Cache API store (default `50 MB`) with a **Clear Image Cache** control in Settings.
- **Inline Image Reload:** Displays an inline **Reload** button on loading/failed image placeholders so individual images can be retried without re-syncing the vault.
- **Direct Paste & Camera Upload + WebP Compression:** Intercepts pasted, dropped, or mobile-captured images, optionally resizes and converts large images to WebP via HTML5 Canvas, uploads directly to the repository, and cleans up temporary local files.
- **Unused Image Cleanup:** Scans notes, `.canvas` files, and frontmatter for unreferenced remote images and opens a confirmation modal with thumbnail previews before committing deletions.
- **Safe Conflict Handling:** Isolates divergent mobile edits onto a `mobile-conflict/<timestamp>` branch so you can perform a real 3-way Git merge on desktop, then clear the conflict state in Settings.

## Setup

### 1. Create a Personal Access Token
- **GitHub (Recommended: Fine-grained PAT):** Grant **Contents: Read and write** on your vault repository (or Classic PAT with `repo` scope).
- **GitLab:** Grant `api` (or `read_repository` + `write_repository`) scope.

### 2. Configure the Plugin
Open **Settings -> Git On-Demand Sync**:
- **Git Provider:** Select `GitHub` or `GitLab`.
- **API Base URL:** `https://api.github.com` (GitHub) or `https://gitlab.com` (GitLab), or your Enterprise/self-hosted URL.
- **Repository / Project ID:** `owner/repo` (GitHub) or `namespace/repo` / numeric project ID (GitLab).
- **Branch:** Target branch (e.g. `main`).
- **Personal Access Token:** Paste your token.
- **Attachment Folder:** Target folder for uploaded images (e.g. `attachments` or `Asset`).
- **Enable on Desktop (Testing):** Leave `OFF` if your desktop vault already uses native `git`; turn `ON` only to test on desktop.

### 3. Initial Sync
Start from an **empty vault** on mobile (the plugin aborts initial sync if local text files already exist to prevent accidental overwrites) and click **Sync with Git** in the ribbon or Command Palette.

## Commands

- **Sync with Git:** Run pull-then-push text synchronization.
- **Clean up unused remote images:** Scan for unreferenced remote images and open the confirmation modal.

## Development

```bash
npm install
npm test
npm run build
```
