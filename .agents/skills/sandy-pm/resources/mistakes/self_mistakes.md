# Past Mistakes for Agent Type: self (Consolidated Workspace Rules)

This file tracks critical code quality, syntax, UI design, API resilience, multimedia, and security mistakes recorded across `D:\Process`. Subagents MUST adhere strictly to these resolutions to prevent repeated failures.

---

### 1. Code Syntax Integrity & Automation Safety
- **Mistake:** Delivered code containing JavaScript `SyntaxError` caused by unescaped PowerShell multiline string interpolation stripping backticks (`` ` ``) and `${...}` template literals without running a syntax check prior to delivering work to CEO.
  - **Context:** Injecting Three.js shader scripts and prototype templates.
  - **Resolution:** ALWAYS perform explicit syntax verification (e.g. `node -c <file.js>`, Python AST compile check, or test run) before declaring work complete. Avoid unescaped template literals in PowerShell scripts.

---

### 2. Secret Protection & Git Hygiene
- **Mistake:** Tracking `.env` directly in Git and missing a `.gitignore` file.
  - **Context:** Setting up project environment.
  - **Resolution:** ALWAYS ensure a `.gitignore` exists ignoring `.env`, `node_modules/`, `__pycache__/`, `.pytest_cache/`. Commit only `.env.example` / `.env.template`.

---

### 3. Thai / UTF-8 Character Encoding & XML Feed Parsing
- **Mistake:** Using `response.text` which corrupts Thai encoding, hardcoding RSS XML parsing without Atom namespace support, and using XML `node.text` which truncates strings containing inline HTML tags.
  - **Context:** Parsing web feeds and Thai content orchestration.
  - **Resolution:** Always pass `response.content` (raw bytes) instead of `response.text` so XML parsers auto-detect encoding. Check XML root to support both RSS and Atom namespaces. Extract full text from XML nodes using `"".join(node.itertext())` instead of `.text`.

---

### 4. API Resilience, Network Timeouts & Exception Handling
- **Mistake:** Calling `requests.get()` without timeouts, failing to wrap external API client calls and XML parsing in try-except blocks, wrapping network errors as `ValueError`, and destroying stack trace by omitting `from e`.
  - **Context:** Third-party API integrations (Gemini SDK, TTS, webhooks).
  - **Resolution:** Always set explicit `timeout` (e.g. 10s for fast endpoints, 30-60s for heavy TTS/AI generation). Wrap calls in try-catch boundaries. Use custom domain exception classes (e.g. `PublishError`, `APIClientError`), preserve original tracebacks with `raise CustomError(...) from e`, and extract API error response bodies.

---

### 5. Mock Key Leak Prevention & Centralized Dry-Run Protection
- **Mistake:** Triggering live external API requests when mock/placeholder keys are configured, and evaluating dry-run flags independently per service (risking partial mock leaks).
  - **Context:** Running E2E test scripts and offline dry-runs.
  - **Resolution:** Centralize the `is_dry_run` detection flag. If ANY service key is a placeholder (e.g. starting with `"mock-"` or `"your_"`), force the ENTIRE pipeline into dry-run mode. Use safe console printing (`safe_print` / error wrappers) to avoid Windows console Unicode crashes.

---

### 6. UI & Design System Standardization (Lucide Icons & Theming)
- **Mistake:** Using raw emojis in UI templates, HUD buttons, logs, or status indicators instead of professional icon sets, or switching workspace themes away from official guidelines.
  - **Context:** Landing page, HUD, and dashboard UI development.
  - **Resolution:** Strictly ban all raw emojis in UI code. ALWAYS load and render Lucide Icons (`<i data-lucide="..."></i>` with `lucide.createIcons()`) or Font Awesome according to project design specs. Adhere strictly to the workspace theme (e.g. Frosted Glass Light Slate & Lime theme).

---

### 7. Product Metadata & Version Label Constraints
- **Mistake:** Displaying exaggerated software versions (e.g. `v2.4` or `v1.0`).
  - **Context:** UI badges, footer info, documentation, and release metadata.
  - **Resolution:** Adhere to CEO versioning guidelines (strictly `<= v0.8` or `<= 1.0` as specified).

---

### 8. Multimedia & Video Production (Chroma Key & 12% BGM Audio Ducking)
- **Mistake 1 (Chroma Key):** Image prompts for cutout assets were written with generic backgrounds or solid white instead of strict chroma key.
  - **Resolution:** ALWAYS prompt cutout assets with `flat solid chroma key magenta background #FF00FF` for flawless AI background removal (`rembg`).
- **Mistake 2 (Audio Ducking):** Background music (BGM) volume was set too loud, drowning out voiceover narration.
  - **Resolution:** ALWAYS duck BGM volume to max **12%–18%** (-18dB to -20dB) relative to voiceover narration (100% / 0dB) in all audio mixing and HTML5 video players.

---

### 9. Web3 & Security Authority Management
- **Mistake 1:** Conflating `feePayerKeypair` with on-chain SPL Token `Mint Authority`.
  - **Resolution:** Always verify on-chain mint authority (`spl-token display`) and use a distinct `mintAuthorityKeypair`.
- **Mistake 2:** Manually copying private key byte arrays from markdown documentation.
  - **Resolution:** NEVER transcribe keys manually. Always parse keys programmatically from canonical source-of-truth JSON files (`docs/test/test_wallets.json`).

---

### 10. Ponytail Discipline (CEO Directive)
- **Rule:** Every coding, bug-fix, or refactoring task in this workspace MUST follow the `ponytail` skill (`full` mode): make the smallest complete change, reuse existing codebase helpers and platform APIs, avoid speculative abstractions or unnecessary dependencies, check all callers before fixing a bug, leave a focused test for non-trivial logic, and report what was skipped or any remaining risk in 1–2 lines.
