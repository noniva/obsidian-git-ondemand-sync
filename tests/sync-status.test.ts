import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncStatusTracker } from '../src/sync/status';
import { DEFAULT_SETTINGS, type PluginSettings, type SyncState } from '../src/types';
import { sha256Hex } from '../src/utils/paths';

function createTrackerHarness(options?: {
  initialFiles?: Record<string, string>;
  syncedHashes?: Record<string, string>;
  lastSyncedCommitSha?: string | null;
  branchHead?: string;
  enabled?: boolean;
  syncing?: boolean;
}) {
  const files = new Map<string, string>(Object.entries(options?.initialFiles ?? {}));
  const state: SyncState = {
    lastSyncedCommitSha:
      options?.lastSyncedCommitSha === undefined ? 'commit-1' : options.lastSyncedCommitSha,
    activeConflictBranch: null,
    files: Object.fromEntries(
      Object.entries(options?.syncedHashes ?? {}).map(([path, contentHash]) => [
        path,
        { blobSha: `blob-${path}`, contentHash },
      ]),
    ),
    remoteImagePaths: [],
  };
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    token: 'tok',
    projectId: 'owner/repo',
    branch: 'main',
    textAllowlist: ['.md', '.txt'],
    syncObsidianDir: false,
  };

  let nowMs = 100_000;
  let syncing = options?.syncing ?? false;
  let enabled = options?.enabled ?? true;
  const getBranchHead = vi.fn().mockResolvedValue(options?.branchHead ?? 'commit-1');
  const onChange = vi.fn();

  const tracker = new SyncStatusTracker({
    vault: {
      listTextFiles: async () => Array.from(files.keys()),
      readText: async (path: string) => {
        const val = files.get(path);
        if (val === undefined) throw new Error(`Missing file: ${path}`);
        return val;
      },
      exists: (path: string) => files.has(path),
    },
    getBranchHead,
    getState: () => state,
    getSettings: () => settings,
    getConfigDir: () => '.obsidian',
    isEnabled: () => enabled,
    isSyncing: () => syncing,
    onChange,
    now: () => nowMs,
  });

  return {
    files,
    state,
    settings,
    tracker,
    getBranchHead,
    onChange,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    setSyncing: (val: boolean) => {
      syncing = val;
    },
    setEnabled: (val: boolean) => {
      enabled = val;
    },
  };
}

describe('SyncStatusTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scans new, modified, and locally deleted allowlisted files while skipping ignored paths', async () => {
    const cleanHash = await sha256Hex('clean');
    const oldModifiedHash = await sha256Hex('old');
    const deletedHash = await sha256Hex('gone');

    const h = createTrackerHarness({
      initialFiles: {
        'notes/clean.md': 'clean',
        'notes/modified.md': 'new-content',
        'notes/new.md': 'hello',
        '.git/config': 'ignored',
        'images/pic.png': 'binary-ignored',
      },
      syncedHashes: {
        'notes/clean.md': cleanHash,
        'notes/modified.md': oldModifiedHash,
        'notes/deleted.md': deletedHash,
      },
    });

    await h.tracker.scanDirtyPaths();
    expect(h.tracker.getSummary()).toEqual({
      unpushedCount: 3, // modified.md, new.md, deleted.md
      hasRemoteUpdates: false,
    });
  });

  it('debounces path refreshes, clears dirty status when reverted, and handles renames', async () => {
    const cleanHash = await sha256Hex('alpha');
    const h = createTrackerHarness({
      initialFiles: {
        'a.md': 'alpha',
      },
      syncedHashes: {
        'a.md': cleanHash,
      },
    });

    await h.tracker.scanDirtyPaths();
    expect(h.tracker.getSummary().unpushedCount).toBe(0);

    // Edit a.md -> debounced refresh marks it dirty
    h.files.set('a.md', 'beta');
    h.tracker.schedulePathRefresh('a.md');
    expect(h.tracker.getSummary().unpushedCount).toBe(0);
    await vi.advanceTimersByTimeAsync(450);
    await vi.waitFor(() => expect(h.tracker.getSummary().unpushedCount).toBe(1));

    // Revert a.md back to original content -> dirty count returns to 0
    h.files.set('a.md', 'alpha');
    h.tracker.schedulePathRefresh('a.md');
    await vi.advanceTimersByTimeAsync(450);
    await vi.waitFor(() => expect(h.tracker.getSummary().unpushedCount).toBe(0));

    // Rename a.md -> b.md -> both old (deleted) and new (created) are dirty
    h.files.delete('a.md');
    h.files.set('b.md', 'alpha');
    h.tracker.handleRename('a.md', 'b.md');
    await vi.advanceTimersByTimeAsync(450);
    await vi.waitFor(() => expect(h.tracker.getSummary().unpushedCount).toBe(2));
  });

  it('checks remote branch head with 60s cooldown and suppresses network errors silently', async () => {
    const h = createTrackerHarness({
      lastSyncedCommitSha: 'sha-1',
      branchHead: 'sha-2',
    });

    await h.tracker.checkRemoteUpdates();
    expect(h.getBranchHead).toHaveBeenCalledTimes(1);
    expect(h.tracker.getSummary().hasRemoteUpdates).toBe(true);

    // Within 60s cooldown -> skipped
    h.setNow(130_000);
    await h.tracker.checkRemoteUpdates();
    expect(h.getBranchHead).toHaveBeenCalledTimes(1);

    // After 60s cooldown + offline error -> swallows error and keeps previous state
    h.setNow(170_000);
    h.getBranchHead.mockRejectedValueOnce(new Error('Network offline'));
    await expect(h.tracker.checkRemoteUpdates()).resolves.toBeUndefined();
    expect(h.getBranchHead).toHaveBeenCalledTimes(2);
    expect(h.tracker.getSummary().hasRemoteUpdates).toBe(true);

    // Force check after sync -> clears hasRemoteUpdates when matching
    h.getBranchHead.mockResolvedValueOnce('sha-1');
    await h.tracker.checkRemoteUpdates(true);
    expect(h.tracker.getSummary().hasRemoteUpdates).toBe(false);

    h.tracker.dispose();
  });
});
