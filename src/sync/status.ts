import type { PluginSettings, SyncState } from '../types';
import { isIgnoredPath, isTextSyncPath, normalizeVaultPath, sha256Hex } from '../utils/paths';

export interface SyncStatusSummary {
  unpushedCount: number;
  hasRemoteUpdates: boolean;
}

export interface SyncStatusVault {
  listTextFiles(): Promise<string[]>;
  readText(path: string): Promise<string>;
  exists(path: string): boolean;
}

export interface SyncStatusTrackerOptions {
  vault: SyncStatusVault;
  getBranchHead: (branch: string) => Promise<string>;
  getState: () => SyncState;
  getSettings: () => PluginSettings;
  getConfigDir: () => string;
  isEnabled: () => boolean;
  isSyncing: () => boolean;
  onChange: (summary: SyncStatusSummary) => void;
  now?: () => number;
  debounceMs?: number;
  remoteCooldownMs?: number;
}

/**
 * Tracks unpushed local text changes offline and checks remote branch head on open/resume.
 */
export class SyncStatusTracker {
  private readonly opts: SyncStatusTrackerOptions;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly remoteCooldownMs: number;

  private readonly dirtyPaths = new Set<string>();
  private readonly pendingPaths = new Set<string>();
  private refreshTimer: number | null = null;
  private hasRemoteUpdates = false;
  private lastRemoteCheckAt = -Infinity;
  private remoteCheckInFlight = false;

  constructor(opts: SyncStatusTrackerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.debounceMs = opts.debounceMs ?? 400;
    this.remoteCooldownMs = opts.remoteCooldownMs ?? 60_000;
  }

  getSummary(): SyncStatusSummary {
    return {
      unpushedCount: this.dirtyPaths.size,
      hasRemoteUpdates: this.hasRemoteUpdates,
    };
  }

  private isTrackedPath(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    if (!normalized) {
      return false;
    }
    const settings = this.opts.getSettings();
    return (
      !isIgnoredPath(normalized, settings.syncObsidianDir, this.opts.getConfigDir()) &&
      isTextSyncPath(normalized, settings.textAllowlist)
    );
  }

  private notify(): void {
    this.opts.onChange(this.getSummary());
  }

  /**
   * Scans all allowlisted local text files and tracked state entries to compute initial dirty paths.
   */
  async scanDirtyPaths(): Promise<void> {
    const state = this.opts.getState();
    const nextDirty = new Set<string>();
    const rawPaths = await this.opts.vault.listTextFiles();
    const localSet = new Set<string>();

    for (const rawPath of rawPaths) {
      const path = normalizeVaultPath(rawPath);
      if (!this.isTrackedPath(path)) {
        continue;
      }
      localSet.add(path);
      try {
        const content = await this.opts.vault.readText(path);
        const hash = await sha256Hex(content);
        const tracked = state.files[path];
        if (!tracked || tracked.contentHash !== hash) {
          nextDirty.add(path);
        }
      } catch {
        // Ignore transient read errors during background scan.
      }
    }

    for (const trackedPath of Object.keys(state.files)) {
      if (this.isTrackedPath(trackedPath) && !localSet.has(trackedPath)) {
        nextDirty.add(trackedPath);
      }
    }

    this.dirtyPaths.clear();
    for (const p of nextDirty) {
      this.dirtyPaths.add(p);
    }
    this.notify();
  }

  /**
   * Schedules a debounced dirty-state re-evaluation for a single vault path.
   */
  schedulePathRefresh(rawPath: string): void {
    const path = normalizeVaultPath(rawPath);
    if (!path) {
      return;
    }
    const state = this.opts.getState();
    if (!this.isTrackedPath(path) && !state.files[path] && !this.dirtyPaths.has(path)) {
      return;
    }

    this.pendingPaths.add(path);
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.flushPendingPaths();
    }, this.debounceMs);
  }

  /**
   * Handles a vault file rename by scheduling refreshes for both old and new paths.
   */
  handleRename(oldPath: string, newPath: string): void {
    this.schedulePathRefresh(oldPath);
    this.schedulePathRefresh(newPath);
  }

  private async flushPendingPaths(): Promise<void> {
    const batch = Array.from(this.pendingPaths);
    this.pendingPaths.clear();
    if (batch.length === 0) {
      return;
    }

    const state = this.opts.getState();
    let changed = false;

    for (const path of batch) {
      const wasDirty = this.dirtyPaths.has(path);
      const tracked = state.files[path];
      let isDirty = false;

      if (this.isTrackedPath(path)) {
        if (this.opts.vault.exists(path)) {
          try {
            const content = await this.opts.vault.readText(path);
            const hash = await sha256Hex(content);
            isDirty = !tracked || tracked.contentHash !== hash;
          } catch {
            isDirty = wasDirty;
          }
        } else {
          isDirty = Boolean(tracked);
        }
      }

      if (isDirty && !wasDirty) {
        this.dirtyPaths.add(path);
        changed = true;
      } else if (!isDirty && wasDirty) {
        this.dirtyPaths.delete(path);
        changed = true;
      }
    }

    if (changed) {
      this.notify();
    }
  }

  /**
   * Checks remote branch head with a single API call, guarded by cooldown and silent on errors.
   */
  async checkRemoteUpdates(force = false): Promise<void> {
    if (!this.opts.isEnabled() || this.opts.isSyncing() || this.remoteCheckInFlight) {
      return;
    }
    const settings = this.opts.getSettings();
    const state = this.opts.getState();
    if (!settings.token.trim() || !settings.projectId.trim() || !state.lastSyncedCommitSha) {
      return;
    }

    const nowMs = this.now();
    if (!force && nowMs - this.lastRemoteCheckAt < this.remoteCooldownMs) {
      return;
    }

    this.remoteCheckInFlight = true;
    this.lastRemoteCheckAt = nowMs;
    try {
      const headSha = await this.opts.getBranchHead(settings.branch || 'main');
      const nextHasRemote = headSha !== state.lastSyncedCommitSha;
      if (nextHasRemote !== this.hasRemoteUpdates) {
        this.hasRemoteUpdates = nextHasRemote;
        this.notify();
      }
    } catch {
      // Never surface background network/offline errors as user-facing notices.
    } finally {
      this.remoteCheckInFlight = false;
    }
  }

  /**
   * Clears remote-update flag and re-scans local dirty paths right after a sync or conflict reset.
   */
  async resetAfterSync(): Promise<void> {
    this.hasRemoteUpdates = false;
    this.lastRemoteCheckAt = this.now();
    await this.scanDirtyPaths();
  }

  dispose(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pendingPaths.clear();
  }
}
