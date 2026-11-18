import { describe, it, expect, vi } from 'vitest';
import { SyncEngine } from '../src/sync/engine';
import { DEFAULT_SETTINGS, type SyncState } from '../src/types';

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
});
