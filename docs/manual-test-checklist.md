# Manual Pre-Flight Verification Checklist

Concise end-to-end verification guide for **GitLab On-Demand Sync** across real Obsidian Desktop, Obsidian Mobile, and a private GitLab repository.

## 1. Build & Plugin Deployment

- [ ] Run automated checks first:
  ```bash
  npm test
  npm run build
  node -c main.js
  ```
- [ ] Prepare a private GitLab test repository containing markdown notes (`.md`), optional `.canvas`/`.txt` files, and several images under `attachments/` (plus nested folders and filenames with spaces or parentheses).
- [ ] Create a GitLab Personal Access Token with `api` (or `read_repository` + `write_repository`) scope.
- [ ] Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/gitlab-ondemand-sync/` on your test Desktop vault and Mobile vault.
- [ ] Open **Settings -> Community plugins**, enable **GitLab On-Demand Sync**, and configure:
  - **GitLab Base URL** (e.g. `https://gitlab.com`)
  - **Project ID / Path** (numeric ID or `username/vault-repo`)
  - **Branch** (e.g. `main`)
  - **Personal Access Token**
  - **Attachment Folder** (e.g. `attachments`, or leave empty for vault root)
  - **Enable on Desktop (Testing)** (`ON` only while testing on Desktop; leave `OFF` for normal Desktop `git` workflow)

## 2. Initial Empty-Vault Pull & Fail-Safe Guard

- [ ] **Non-empty vault guard:** In a vault that already has a local `.md` file and no prior sync state, run **Sync with GitLab** (ribbon icon or Command Palette) and confirm it aborts with `Initial sync requires an empty vault; existing local text files detected.` without overwriting local files.
- [ ] **Empty-vault pull:** In a fresh empty vault, run **Sync with GitLab**.
  - Confirm Notice reports `GitLab sync complete: <N> pulled, 0 pushed, 0 deleted.`
  - Confirm allowlisted text files (`.md`, `.canvas`, `.txt`) are written to local vault storage.
  - Confirm repository images and dot-folders (`.git/`, `.vscode/`) are **not** written to local vault storage.

## 3. On-Demand Image Viewing & Storage Size Verification

- [ ] Open a synced note containing `![[image.png]]`, `![[image.png|caption|300]]`, and `![alt|240](sub/photo(1).png)`.
- [ ] Check **Live Preview**:
  - Images render inline when cursor is outside the embed syntax.
  - Moving cursor onto an embed expands raw markdown syntax; moving cursor away restores the rendered image.
  - Switching to **Source Mode** displays raw markdown only.
  - Embeds inside inline backticks or fenced code blocks stay as raw code text.
- [ ] Check **Reading View**:
  - Images render with expected alt text and width constraints (`max-width: 100%`).
  - Open a long note with 10+ remote images and watch network activity while scrolling: off-screen images only fetch as they enter the viewport.
- [ ] **Zero disk storage verification:** After browsing multiple image-heavy notes on Mobile (and Desktop test vault), inspect the vault directory size in your OS file manager / iOS Files / Android Files:
  - Confirm no image files exist inside the vault folder (total vault size reflects text notes + plugin files only).
- [ ] Close the note or disable/reload the plugin and verify images re-open cleanly without errors or runaway memory growth.

## 4. Offline Paste Fail-Safe

- [ ] Put the device offline (Airplane Mode or disable Wi-Fi).
- [ ] Paste or drag-and-drop an image into an open note in Live Preview.
- [ ] Confirm:
  - A Notice displays `Failed to upload image to GitLab: ...`.
  - The temporary `<!-- uploading-gitlab-image-... -->` placeholder is removed and no broken `![[...]]` link remains.
  - No local image file is created in the vault directory.

## 5. Mobile Camera / Photo Picker Upload

- [ ] Reconnect Mobile to the network and open a note in Live Preview.
- [ ] Use Obsidian Mobile's toolbar **Insert attachment / Camera / Photo library** action to add a photo.
- [ ] Confirm:
  - The plugin uploads the photo directly to GitLab (`<Attachment Folder>/Pasted image <YYYYMMDDHHmmss>.<ext>`).
  - The temporary local image created by Obsidian is deleted immediately from Mobile vault storage.
  - The note embed updates to `![[<Attachment Folder>/Pasted image <YYYYMMDDHHmmss>.<ext>]]` and displays immediately from the in-memory `blob:` cache.
  - Run **Sync with GitLab** to push the updated note text, then pull on Desktop to verify both the note and committed image appear in git.

## 6. Desktop 3-Way Merge & Conflict Recovery

- [ ] Create a controlled conflict:
  1. On Desktop, modify `conflict-test.md`, commit, and `git push` to `main`.
  2. On Mobile (before syncing), edit `conflict-test.md` differently, then run **Sync with GitLab**.
- [ ] Confirm Mobile displays `GitLab sync conflict! Local changes were pushed to branch "mobile-conflict/<timestamp>"...`.
- [ ] Close and reopen Obsidian Mobile (with conflict active) and confirm the startup reminder Notice mentions the active `mobile-conflict/...` branch and **Clear Conflict State**.
- [ ] On Desktop, resolve and merge the branch:
  ```bash
  git fetch origin
  git merge origin/mobile-conflict/<timestamp>
  # Resolve conflict markers in conflict-test.md if prompted, then:
  git add conflict-test.md
  git commit
  git push origin main
  ```
  (Optionally delete the merged `mobile-conflict/<timestamp>` branch on GitLab to test deleted-branch recovery.)
- [ ] On Mobile, open **Settings -> GitLab On-Demand Sync** and click **Clear Conflict State**:
  - Confirm Notice displays `GitLab conflict state cleared.` and the button becomes disabled.
  - Run **Sync with GitLab** and confirm Mobile reconciles with merged `main` cleanly (`GitLab sync complete: ...`).
