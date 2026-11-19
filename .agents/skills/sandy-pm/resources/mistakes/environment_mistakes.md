# Environment Configuration Mistakes & Required Fixes

This file tracks environment, runtime, port, and infrastructure issues across projects in `D:\Process`. Before any test run or deployment, verify that these common environment failure patterns are prevented.

---

### 1. Python Environment & Execution Path
- **Mistake:** Running `pytest` or Python modules directly instead of `python -m <module>`.
  - **Context:** Test suite execution fails due to `ModuleNotFoundError: No module named 'src'` or runs under an unintended global Python environment.
  - **Resolution:** ALWAYS invoke pytest and scripts via `python -m pytest` or `python -m <script>` so the current working directory is cleanly appended to `sys.path`.

---

### 2. Windows Hyper-V / WSL Port Reservation Conflicts (EACCES)
- **Mistake:** Starting web servers on port 3000 threw `listen EACCES: permission denied 0.0.0.0:3000`.
  - **Context:** Windows Hyper-V / WSL dynamic port exclusion ranges frequently block port 3000.
  - **Resolution:** Default to `PORT=3001` or fallback port, bind explicitly to `127.0.0.1`, and allow port override via `.env`.

---

### 3. Server Process Collisions & Webpack Cache Corruption
- **Mistake:** Starting a new dev server (e.g. Next.js / Fastify) while an old instance is still running in the background.
  - **Context:** Causes `EADDRINUSE`, webpack cache lock conflicts (ENOENT), or stale bundle serving.
  - **Resolution:** ALWAYS use `manage_task` with action `list` and `kill` (or `Stop-Process -Id <PID> -Force`) to terminate lingering server tasks before starting a new build/server. Run `rm -rf .next && npm run dev` when cache corruption occurs.

---

### 4. Hot-Reloading & `.env` File Watcher Assumptions
- **Mistake:** Assuming dev server hot-reloaders (like `ts-node-dev --respawn` or nodemon) detect changes in `.env` files.
  - **Context:** Dev servers only watch `.ts`/`.js` code files. Updating `.env` left the server running with stale credentials.
  - **Resolution:** ALWAYS explicitly restart the server process whenever `.env` variables or config files are modified.

---

### 5. Automatic Database & Schema Self-Healing
- **Mistake:** Setup scripts failing or UI showing fallback errors because local SQLite database file/tables were not created during clean setup.
  - **Context:** First-time setup before relayer or backend server has executed migrations.
  - **Resolution:** Setup and migration scripts must automatically create database directories, initialize the database file, and run schema table creations if they do not exist.

---

### 6. Unused Background Services & Task Hygiene (CEO Directive)
- **Mistake:** Leaving background services (such as visual companion servers, idle mock servers, background timers, or completed dev/build processes) running after their phase is completed.
  - **Context:** Causes unnecessary CPU/memory consumption, port occupation, and zombie tasks lingering across turns.
  - **Resolution:** ALWAYS check running tasks (`manage_task` with action `list`) and terminate any unused, idle, or completed background services immediately (`manage_task` with action `kill`) before transitioning to new tasks or finishing work.
