import { describe, it, expect, vi } from 'vitest';
import { SyncEngine } from '../src/sync/engine';
import { DEFAULT_SETTINGS, type SyncState } from '../src/types';
import { sha256Hex } from '../src/utils/paths';

describe('SyncEngine', () => {
  it('syncs text files only, indexes remote images, and skips binary PDFs', async () => {
    const files: Record<string, string> = {};
    const state: SyncState = { lastSyncedCommitSha: null, activeConflictBranch: null, files: {}, remoteImagePaths: [] };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('head1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: 'b1', name: 'note.md', type: 'blob', path: 'note.md', mode: '100644' },
        { id: 'b2', name: 'pic.png', type: 'blob', path: 'attachments/pic.png', mode: '100644' },
        { id: 'b3', name: 'doc.pdf', type: 'blob', path: 'docs/doc.pdf', mode: '100644' },
      ]),
      getRawText: vi.fn().mockResolvedValue('# Hello'),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });
    const res = await engine.sync();

    expect(files['note.md']).toBe('# Hello');
    expect(files['attachments/pic.png']).toBeUndefined();
    expect(files['docs/doc.pdf']).toBeUndefined();
    expect(state.remoteImagePaths).toEqual(['attachments/pic.png']);
    expect(state.lastSyncedCommitSha).toBe('head1');
    expect(res.pulled).toBe(1);
    expect(saveState).toHaveBeenCalled();
  });

  it('pushes conflicts to mobile-conflict branch and keeps local edits on disk', async () => {
    const files: Record<string, string> = { 'a.md': 'mobile edit' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'a.md': { blobSha: 'r0', contentHash: 'h0' } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([{ id: 'r1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c_conflict'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(res.conflictBranch).toMatch(/^mobile-conflict\//);
    expect(client.createCommit).toHaveBeenCalledWith(expect.objectContaining({ startSha: 'c0' }));
    expect(files['a.md']).toBe('mobile edit');
    expect(state.activeConflictBranch).toBe(res.conflictBranch);
    expect(state.lastSyncedCommitSha).toBe('c0');
  });

  it('pushes clean local changes to target branch and updates baseline state', async () => {
    const files: Record<string, string> = { 'new.md': 'new content' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'old.md': { blobSha: 'r_old', contentHash: 'h_old' } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c0'),
      getTreeRecursive: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'r_old', name: 'old.md', type: 'blob', path: 'old.md', mode: '100644' }])
        .mockResolvedValueOnce([{ id: 'r_new', name: 'new.md', type: 'blob', path: 'new.md', mode: '100644' }]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c1'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });
    const res = await engine.sync();

    expect(res.pushed).toBe(2);
    expect(res.conflictBranch).toBeNull();
    expect(res.headCommitSha).toBe('c1');
    expect(state.lastSyncedCommitSha).toBe('c1');
    expect(state.files['old.md']).toBeUndefined();
    expect(state.files['new.md']?.blobSha).toBe('r_new');
    expect(client.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'main',
        actions: [
          { action: 'create', file_path: 'new.md', content: 'new content', encoding: 'text' },
          { action: 'delete', file_path: 'old.md' },
        ],
      }),
    );
    expect(saveState).toHaveBeenCalled();
  });

  it('commits subsequent edits to activeConflictBranch without startSha and clears on clearConflictBranch', async () => {
    const files: Record<string, string> = { 'a.md': 'mobile edit 2' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261118-213000',
      files: { 'a.md': { blobSha: 'r0', contentHash: 'h0' } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([{ id: 'r1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c_conflict_2'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });
    const res = await engine.sync();

    expect(res.conflictBranch).toBe('mobile-conflict/20261118-213000');
    expect(client.createCommit).toHaveBeenCalledTimes(1);
    const callArg = client.createCommit.mock.calls[0][0];
    expect(callArg.branch).toBe('mobile-conflict/20261118-213000');
    expect(callArg.startSha).toBeUndefined();

    await engine.clearConflictBranch();
    expect(state.activeConflictBranch).toBeNull();
    expect(saveState).toHaveBeenCalledTimes(2);
  });

  it('aborts initial sync early when lastSyncedCommitSha is null and local text files exist', async () => {
    const files: Record<string, string> = { 'existing.md': 'local note' };
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn(),
      getTreeRecursive: vi.fn(),
      getRawText: vi.fn(),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });

    await expect(engine.sync()).rejects.toThrow(/empty vault/i);
    expect(client.getBranchHead).not.toHaveBeenCalled();
    expect(client.getTreeRecursive).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('reconciles activeConflictBranch tree to avoid duplicate creates or deletes', async () => {
    // Scenario:
    // - created.md: untracked locally, already pushed to activeConflictBranch earlier -> should emit 'update'
    // - deleted.md: tracked in baseline, deleted locally, already deleted on activeConflictBranch -> should be omitted
    // - updated.md: tracked in baseline, modified locally, missing on activeConflictBranch -> should emit 'create'
    const files: Record<string, string> = {
      'created.md': 'v2',
      'updated.md': 'edited',
    };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261118-213000',
      files: {
        'deleted.md': { blobSha: 'r_del', contentHash: 'h_del' },
        'updated.md': { blobSha: 'r_upd', contentHash: 'h_upd' },
      },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi
        .fn()
        .mockResolvedValueOnce('c1')
        .mockResolvedValueOnce('c_conflict_head'),
      getTreeRecursive: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'r_del', name: 'deleted.md', type: 'blob', path: 'deleted.md', mode: '100644' },
          { id: 'r_upd', name: 'updated.md', type: 'blob', path: 'updated.md', mode: '100644' },
        ])
        .mockResolvedValueOnce([
          { id: 'rc_1', name: 'created.md', type: 'blob', path: 'created.md', mode: '100644' },
        ]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c_conflict_2'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(res.pushed).toBe(2);
    expect(client.createCommit).toHaveBeenCalledWith({
      branch: 'mobile-conflict/20261118-213000',
      commitMessage: 'Sync mobile conflict changes',
      actions: [
        { action: 'update', file_path: 'created.md', content: 'v2', encoding: 'text' },
        { action: 'create', file_path: 'updated.md', content: 'edited', encoding: 'text' },
      ],
    });
  });

  it('persists pulled state via saveState even if createCommit subsequently throws', async () => {
    const files: Record<string, string> = { 'local.md': 'new local' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: 'r_remote', name: 'remote.md', type: 'blob', path: 'remote.md', mode: '100644' },
      ]),
      getRawText: vi.fn().mockResolvedValue('remote body'),
      createCommit: vi.fn().mockRejectedValue(new Error('GitLab 500')),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });

    await expect(engine.sync()).rejects.toThrow('GitLab 500');
    expect(files['remote.md']).toBe('remote body');
    expect(state.files['remote.md']?.blobSha).toBe('r_remote');
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('resolves converged conflicts without creating a conflict branch and updates baseline in clearConflictBranch', async () => {
    const mergedText = 'merged content';
    const mergedHash = await sha256Hex(mergedText);
    const files: Record<string, string> = { 'a.md': mergedText };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'a.md': { blobSha: 'r0', contentHash: 'h0' } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: 'r1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' },
      ]),
      getRawText: vi.fn().mockResolvedValue(mergedText),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });
    const res = await engine.sync();

    expect(res.conflictBranch).toBeNull();
    expect(res.pushed).toBe(0);
    expect(client.createCommit).not.toHaveBeenCalled();
    expect(state.files['a.md']).toEqual({ blobSha: 'r1', contentHash: mergedHash });
    expect(state.lastSyncedCommitSha).toBe('c1');

    // Now test clearConflictBranch adopting converged state from target branch
    state.activeConflictBranch = 'mobile-conflict/20261118-213000';
    state.files['a.md'] = { blobSha: 'r0', contentHash: 'h0' };
    state.lastSyncedCommitSha = 'c0';
    client.getBranchHead.mockResolvedValue('c2');
    client.getTreeRecursive.mockResolvedValue([
      { id: 'r2', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' },
    ]);

    await engine.clearConflictBranch();
    expect(state.activeConflictBranch).toBeNull();
    expect(state.lastSyncedCommitSha).toBe('c2');
    expect(state.files['a.md']).toEqual({ blobSha: 'r2', contentHash: mergedHash });
  });

  it('keeps vault empty and state untouched when initial sync fails mid-download', async () => {
    const files: Record<string, string> = {};
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('head1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: 'b1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' },
        { id: 'b2', name: 'b.md', type: 'blob', path: 'b.md', mode: '100644' },
      ]),
      getRawText: vi
        .fn()
        .mockResolvedValueOnce('# A')
        .mockRejectedValueOnce(new Error('Network drop')),
      createCommit: vi.fn(),
    } as any;
    const writeText = vi.fn(async (p: string, c: string) => { files[p] = c; });
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText,
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });

    await expect(engine.sync()).rejects.toThrow('Network drop');
    expect(writeText).not.toHaveBeenCalled();
    expect(Object.keys(files)).toHaveLength(0);
    expect(state.files).toEqual({});
    expect(state.lastSyncedCommitSha).toBeNull();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('merges conflict-branch images, skips identical updates, and deletes conflict-branch-only orphans', async () => {
    const files: Record<string, string> = {
      'same.md': 'already on conflict branch',
    };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261118-213000',
      files: {},
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi
        .fn()
        .mockResolvedValueOnce('c1')
        .mockResolvedValueOnce('c_conflict_head'),
      getTreeRecursive: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'img_main', name: 'main.png', type: 'blob', path: 'attachments/main.png', mode: '100644' },
        ])
        .mockResolvedValueOnce([
          { id: 'img_conf', name: 'conf.png', type: 'blob', path: 'attachments/conf.png', mode: '100644' },
          { id: 'rc_same', name: 'same.md', type: 'blob', path: 'same.md', mode: '100644' },
          { id: 'rc_orphan', name: 'orphan.md', type: 'blob', path: 'orphan.md', mode: '100644' },
        ]),
      getRawText: vi.fn().mockResolvedValue('already on conflict branch'),
      createCommit: vi.fn().mockResolvedValue('c_conflict_3'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(state.remoteImagePaths).toEqual(['attachments/conf.png', 'attachments/main.png']);
    expect(res.pushed).toBe(1);
    expect(client.createCommit).toHaveBeenCalledWith({
      branch: 'mobile-conflict/20261118-213000',
      commitMessage: 'Sync mobile conflict changes',
      actions: [{ action: 'delete', file_path: 'orphan.md' }],
    });
  });

  it('preserves images pasted concurrently during an active sync', async () => {
    const files: Record<string, string> = {};
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('head1'),
      getTreeRecursive: vi.fn().mockImplementation(async () => {
        // Simulate concurrent paste-upload adding a new image while sync is awaiting tree
        state.remoteImagePaths.push('attachments/pasted-during-sync.png');
        return [
          { id: 'b1', name: 'note.md', type: 'blob', path: 'note.md', mode: '100644' },
          { id: 'b2', name: 'old.png', type: 'blob', path: 'attachments/old.png', mode: '100644' },
        ];
      }),
      getRawText: vi.fn().mockResolvedValue('# Note'),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    await engine.sync();

    expect(state.remoteImagePaths).toEqual([
      'attachments/old.png',
      'attachments/pasted-during-sync.png',
    ]);
  });

  it('does not call getRawText on remote-del-local-edit conflict and pushes to mobile-conflict branch', async () => {
    const files: Record<string, string> = { 'deleted-remotely.md': 'local edit' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'deleted-remotely.md': { blobSha: 'r0', contentHash: 'h0' } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c_conflict'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(client.getRawText).not.toHaveBeenCalled();
    expect(res.conflictBranch).toMatch(/^mobile-conflict\//);
    expect(state.activeConflictBranch).toBe(res.conflictBranch);
    expect(client.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: res.conflictBranch,
        startSha: 'c0',
        actions: [
          {
            action: 'update',
            file_path: 'deleted-remotely.md',
            content: 'local edit',
            encoding: 'text',
          },
        ],
      }),
    );
  });

  it('preserves activeConflictBranch when clearConflictBranch fails on getBranchHead', async () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261118-213000',
      files: {},
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockRejectedValue(new Error('Network error')),
      getTreeRecursive: vi.fn(),
      getRawText: vi.fn(),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => [],
      readText: async () => '',
      writeText: async () => {},
      deleteFile: async () => {},
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });

    await expect(engine.clearConflictBranch()).rejects.toThrow('Network error');
    expect(state.activeConflictBranch).toBe('mobile-conflict/20261118-213000');
    expect(saveState).not.toHaveBeenCalled();
  });
});
