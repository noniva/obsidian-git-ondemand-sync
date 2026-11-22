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

  it('does not call getRawText on remote-del-local-edit conflict and preserves local edit on target branch', async () => {
    const files: Record<string, string> = { 'deleted-remotely.md': 'local edit' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'deleted-remotely.md': { blobSha: 'r0', contentHash: 'h0' } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'r2', name: 'deleted-remotely.md', type: 'blob', path: 'deleted-remotely.md', mode: '100644' }]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c2'),
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
    expect(res.conflictBranch).toBeNull();
    expect(state.activeConflictBranch).toBeNull();
    expect(client.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'main',
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

  it('clearConflictBranch adopts 3-way merged target files while preserving post-push mobile edits and eliminating conflict loops', async () => {
    const mobilePushed = 'line1\nmobile line2';
    const mergedOnDesktop = 'line1\ndesktop line1.5\nmobile line2';
    const newerMobileEdit = 'draft written after conflict push';
    const files: Record<string, string> = {
      'merged.md': mobilePushed,
      'edited-later.md': newerMobileEdit,
    };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261119-040000',
      files: {
        'merged.md': { blobSha: 'r0', contentHash: 'h0' },
        'edited-later.md': { blobSha: 're0', contentHash: 'he0' },
      },
      remoteImagePaths: [],
      conflictPushedHashes: {
        'merged.md': await sha256Hex(mobilePushed),
        'edited-later.md': await sha256Hex('older conflict push'),
      },
      conflictDeletedPaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c_merged'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: 'r_merged', name: 'merged.md', type: 'blob', path: 'merged.md', mode: '100644' },
        { id: 're_merged', name: 'edited-later.md', type: 'blob', path: 'edited-later.md', mode: '100644' },
        { id: 'r_brandnew', name: 'brandnew.md', type: 'blob', path: 'brandnew.md', mode: '100644' },
      ]),
      getRawText: vi.fn(async (p: string) => {
        if (p === 'merged.md') return mergedOnDesktop;
        if (p === 'edited-later.md') return 'older remote text';
        if (p === 'brandnew.md') return 'new remote';
        return '';
      }),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    await engine.clearConflictBranch();

    expect(files['merged.md']).toBe(mergedOnDesktop);
    expect(files['brandnew.md']).toBe('new remote');
    expect(files['edited-later.md']).toBe(newerMobileEdit);
    expect(state.activeConflictBranch).toBeNull();
    expect(state.conflictPushedHashes).toBeUndefined();
    expect(state.lastSyncedCommitSha).toBe('c_merged');
    expect(state.files['merged.md']).toEqual({ blobSha: 'r_merged', contentHash: await sha256Hex(mergedOnDesktop) });
    expect(state.files['edited-later.md']).toEqual({
      blobSha: 're_merged',
      contentHash: await sha256Hex('older remote text'),
    });
  });

  it('gives actionable 404 error if conflict branch was deleted on GitLab, aborts incremental pull before disk write, and guards target TOCTOU head movement', async () => {
    // 1. 404 on deleted activeConflictBranch
    const raw404Error = new Error('GitLab API GET failed (404): 404 Branch Not Found');
    const state404: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/deleted',
      files: {},
      remoteImagePaths: [],
    };
    const client404 = {
      getBranchHead: vi
        .fn()
        .mockResolvedValueOnce('c1')
        .mockRejectedValueOnce(raw404Error),
      getTreeRecursive: vi.fn().mockResolvedValue([]),
      getRawText: vi.fn(),
      createCommit: vi.fn(),
    } as any;
    const vaultEmpty = { listTextFiles: async () => [], readText: async () => '', writeText: vi.fn(), deleteFile: vi.fn() };
    const engine404 = new SyncEngine({ settings: DEFAULT_SETTINGS, state: state404, client: client404, vault: vaultEmpty, saveState: vi.fn() });
    try {
      await engine404.sync();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Clear Conflict State/i);
      expect((err as Error & { cause?: unknown }).cause).toBe(raw404Error);
    }

    // 2. Incremental pull failure must not write partial files to disk
    const incFiles: Record<string, string> = {};
    const incWrite = vi.fn(async (p: string, c: string) => { incFiles[p] = c; });
    const incClient = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: '1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' },
        { id: '2', name: 'b.md', type: 'blob', path: 'b.md', mode: '100644' },
      ]),
      getRawText: vi.fn().mockResolvedValueOnce('# A').mockRejectedValueOnce(new Error('Timeout')),
      createCommit: vi.fn(),
    } as any;
    const incVault = { listTextFiles: async () => Object.keys(incFiles), readText: async (p: string) => incFiles[p], writeText: incWrite, deleteFile: vi.fn() };
    const incState: SyncState = { lastSyncedCommitSha: 'c0', activeConflictBranch: null, files: {}, remoteImagePaths: [] };
    await expect(new SyncEngine({ settings: DEFAULT_SETTINGS, state: incState, client: incClient, vault: incVault, saveState: vi.fn() }).sync()).rejects.toThrow('Timeout');
    expect(incWrite).not.toHaveBeenCalled();

    // 3. TOCTOU head check before target createCommit
    const pushFiles: Record<string, string> = { 'new.md': 'local' };
    const pushClient = {
      getBranchHead: vi.fn().mockResolvedValueOnce('c0').mockResolvedValueOnce('c_desktop_moved'),
      getTreeRecursive: vi.fn().mockResolvedValue([]),
      getRawText: vi.fn(),
      createCommit: vi.fn(),
    } as any;
    const pushVault = { listTextFiles: async () => Object.keys(pushFiles), readText: async (p: string) => pushFiles[p], writeText: vi.fn(), deleteFile: vi.fn() };
    const pushState: SyncState = { lastSyncedCommitSha: 'c0', activeConflictBranch: null, files: {}, remoteImagePaths: [] };
    await expect(new SyncEngine({ settings: DEFAULT_SETTINGS, state: pushState, client: pushClient, vault: pushVault, saveState: vi.fn() }).sync()).rejects.toThrow(/target branch moved/i);
    expect(pushClient.createCommit).not.toHaveBeenCalled();
  });

  it('tracks conflictPushedHashes/conflictDeletedPaths, deletes remote-dropped files in clearConflictBranch, persists mid-apply pull state, and honors configDir', async () => {
    // 1. Conflict push populates conflictPushedHashes and conflictDeletedPaths, and passes configDir
    const pushedContent = 'mobile conflict note';
    const files: Record<string, string> = {
      'a.md': pushedContent,
      '.custom-cfg/app.md': 'cfg',
      '.obsidian/ignored.md': 'skip',
    };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {
        'a.md': { blobSha: 'ra0', contentHash: 'ha0' },
        'drop-me.md': { blobSha: 'rd0', contentHash: 'hd0' },
      },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: 'ra1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' },
        { id: 'rd0', name: 'drop-me.md', type: 'blob', path: 'drop-me.md', mode: '100644' },
      ]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c_conf'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };
    const settings = { ...DEFAULT_SETTINGS, syncObsidianDir: true };
    const engine = new SyncEngine({ settings, state, client, vault, saveState: vi.fn(), configDir: '.custom-cfg' });
    await engine.sync();

    expect(state.conflictPushedHashes).toEqual({
      'a.md': await sha256Hex(pushedContent),
      '.custom-cfg/app.md': await sha256Hex('cfg'),
    });
    expect(state.conflictDeletedPaths).toEqual(['drop-me.md']);

    // 2. clearConflictBranch removes remote-deleted untouched files while keeping post-push edits
    files['edited-orphan.md'] = 'keep local edit';
    state.conflictPushedHashes!['edited-orphan.md'] = await sha256Hex('before edit');
    client.getBranchHead.mockResolvedValue('c_merged');
    client.getTreeRecursive.mockResolvedValue([]);
    await engine.clearConflictBranch();

    expect(files['a.md']).toBeUndefined();
    expect(files['edited-orphan.md']).toBe('keep local edit');
    expect(state.files['a.md']).toBeUndefined();
    expect(state.files['edited-orphan.md']).toBeUndefined();
    expect(state.conflictDeletedPaths).toBeUndefined();

    // 3. Mid-apply disk error persists already-written files via saveState in finally
    const incFiles: Record<string, string> = {};
    const incSave = vi.fn();
    const incState: SyncState = { lastSyncedCommitSha: 'c0', activeConflictBranch: null, files: {}, remoteImagePaths: [] };
    const incClient = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: '1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' },
        { id: '2', name: 'b.md', type: 'blob', path: 'b.md', mode: '100644' },
      ]),
      getRawText: vi.fn().mockResolvedValueOnce('# A').mockResolvedValueOnce('# B'),
      createCommit: vi.fn(),
    } as any;
    const incVault = {
      listTextFiles: async () => Object.keys(incFiles),
      readText: async (p: string) => incFiles[p],
      writeText: vi.fn()
        .mockImplementationOnce(async (p: string, c: string) => { incFiles[p] = c; })
        .mockRejectedValueOnce(new Error('Disk full')),
      deleteFile: vi.fn(),
    };
    await expect(
      new SyncEngine({ settings: DEFAULT_SETTINGS, state: incState, client: incClient, vault: incVault, saveState: incSave }).sync(),
    ).rejects.toThrow('Disk full');
    expect(incState.files['a.md']?.blobSha).toBe('1');
    expect(incState.files['b.md']).toBeUndefined();
    expect(incSave).toHaveBeenCalledTimes(1);
  });

  it('clearConflictBranch saves partial adoption and preserves activeConflictBranch when writeText fails mid-apply, and applyPulls cleans stale conflict markers', async () => {
    // 1. clearConflictBranch mid-apply writeText failure on file #2
    const files: Record<string, string> = { 'a.md': 'pushed a', 'b.md': 'pushed b' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261119-050000',
      files: {
        'a.md': { blobSha: 'ra0', contentHash: 'ha0' },
        'b.md': { blobSha: 'rb0', contentHash: 'hb0' },
      },
      remoteImagePaths: [],
      conflictPushedHashes: {
        'a.md': await sha256Hex('pushed a'),
        'b.md': await sha256Hex('pushed b'),
      },
      conflictDeletedPaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c_merged'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: 'ra1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' },
        { id: 'rb1', name: 'b.md', type: 'blob', path: 'b.md', mode: '100644' },
      ]),
      getRawText: vi.fn(async (p: string) => (p === 'a.md' ? 'merged a' : 'merged b')),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: vi.fn()
        .mockImplementationOnce(async (p: string, c: string) => { files[p] = c; })
        .mockRejectedValueOnce(new Error('Disk full')),
      deleteFile: vi.fn(),
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState });

    await expect(engine.clearConflictBranch()).rejects.toThrow('Disk full');
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(state.activeConflictBranch).toBe('mobile-conflict/20261119-050000');
    expect(state.lastSyncedCommitSha).toBe('c0');
    expect(files['a.md']).toBe('merged a');
    expect(files['b.md']).toBe('pushed b');
    expect(state.files['a.md']).toEqual({ blobSha: 'ra1', contentHash: await sha256Hex('merged a') });
    expect(state.conflictPushedHashes).toEqual({ 'b.md': await sha256Hex('pushed b') });

    // 2. applyPulls cleans stale conflictPushedHashes and conflictDeletedPaths on pulled overwrite/delete
    const pullFiles: Record<string, string> = { 'p.md': 'base p', 'd.md': 'base d' };
    const pullState: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261119-050000',
      files: {
        'p.md': { blobSha: 'rp0', contentHash: await sha256Hex('base p') },
        'd.md': { blobSha: 'rd0', contentHash: await sha256Hex('base d') },
      },
      remoteImagePaths: [],
      conflictPushedHashes: { 'p.md': 'stale-p-hash', 'keep.md': 'keep-hash' },
      conflictDeletedPaths: ['p.md', 'd.md', 'keep-del.md'],
    };
    const pullClient = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn()
        .mockResolvedValueOnce([{ id: 'rp1', name: 'p.md', type: 'blob', path: 'p.md', mode: '100644' }])
        .mockResolvedValueOnce([]),
      getRawText: vi.fn().mockResolvedValue('remote updated p'),
      createCommit: vi.fn(),
    } as any;
    const pullVault = {
      listTextFiles: async () => Object.keys(pullFiles),
      readText: async (p: string) => pullFiles[p],
      writeText: async (p: string, c: string) => { pullFiles[p] = c; },
      deleteFile: async (p: string) => { delete pullFiles[p]; },
    };
    await new SyncEngine({ settings: DEFAULT_SETTINGS, state: pullState, client: pullClient, vault: pullVault, saveState: vi.fn() }).sync();

    expect(pullFiles['p.md']).toBe('remote updated p');
    expect(pullFiles['d.md']).toBeUndefined();
    expect(pullState.conflictPushedHashes).toEqual({ 'keep.md': 'keep-hash' });
    expect(pullState.conflictDeletedPaths).toEqual(['keep-del.md']);
  });

  it('emits sync progress stages and bounds concurrent note downloads', async () => {
    const files: Record<string, string> = {};
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };

    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    const treeEntries = Array.from({ length: 5 }, (_, idx) => ({
      id: `b${idx}`,
      name: `n${idx}.md`,
      type: 'blob' as const,
      path: `n${idx}.md`,
      mode: '100644',
    }));

    const client = {
      getBranchHead: vi.fn().mockResolvedValue('head1'),
      getTreeRecursive: vi.fn(
        async (_ref: string, onPage?: (info: { page: number; totalPages?: number; entries: number }) => void) => {
          onPage?.({ page: 1, totalPages: 2, entries: 5 });
          return treeEntries;
        },
      ),
      getRawText: vi.fn(async (p: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
          if (inFlight <= 2) {
            setTimeout(() => {
              inFlight--;
              resolve();
            }, 5);
          } else {
            inFlight--;
            resolve();
          }
        });
        return `# ${p}`;
      }),
      createCommit: vi.fn(),
    } as any;

    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const events: Array<{ stage: string; current?: number; total?: number; message: string }> = [];
    const engine = new SyncEngine({
      settings: DEFAULT_SETTINGS,
      state,
      client,
      vault,
      saveState: vi.fn(),
      downloadConcurrency: 2,
      onProgress: (p) => events.push({ ...p }),
    });

    await engine.sync();

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(Object.keys(files)).toHaveLength(5);
    expect(events.some((e) => e.stage === 'checking')).toBe(true);
    expect(events.some((e) => e.stage === 'tree' && e.current === 1 && e.total === 2)).toBe(true);
    expect(events.some((e) => e.stage === 'pulling' && e.current === 5 && e.total === 5)).toBe(true);
    expect(events.some((e) => e.stage === 'writing' && e.current === 5 && e.total === 5)).toBe(true);
  });

  it('chunks initial pull via getRawTextsBatch and falls back to getRawText only for omitted paths', async () => {
    const files: Record<string, string> = {};
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const treeEntries = ['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md'].map((p, idx) => ({
      id: `b${idx}`,
      name: p,
      type: 'blob' as const,
      path: p,
      mode: '100644',
    }));

    const client = {
      getBranchHead: vi.fn().mockResolvedValue('head1'),
      getTreeRecursive: vi.fn().mockResolvedValue(treeEntries),
      getRawTextsBatch: vi.fn(async (paths: string[]) => {
        const out = new Map<string, string>();
        for (const p of paths) {
          if (p !== 'n3.md') {
            out.set(p, `batch:${p}`);
          }
        }
        return out;
      }),
      getRawText: vi.fn(async (p: string) => `rest:${p}`),
      createCommit: vi.fn(),
    };
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const progressEvents: Array<{ stage: string; current?: number; total?: number }> = [];
    const engine = new SyncEngine({
      settings: DEFAULT_SETTINGS,
      state,
      client,
      vault,
      saveState: vi.fn(),
      batchDownloadSize: 2,
      onProgress: (p) => progressEvents.push({ stage: p.stage, current: p.current, total: p.total }),
    });

    const res = await engine.sync();

    expect(res.pulled).toBe(5);
    expect(client.getRawTextsBatch).toHaveBeenCalledTimes(3);
    expect(client.getRawTextsBatch.mock.calls.map((c) => c[0])).toEqual([
      ['n0.md', 'n1.md'],
      ['n2.md', 'n3.md'],
      ['n4.md'],
    ]);
    expect(client.getRawText).toHaveBeenCalledTimes(1);
    expect(client.getRawText).toHaveBeenCalledWith('n3.md', 'head1');
    expect(files['n0.md']).toBe('batch:n0.md');
    expect(files['n3.md']).toBe('rest:n3.md');
    expect(files['n4.md']).toBe('batch:n4.md');
    expect(progressEvents.some((e) => e.stage === 'pulling' && e.current === 5 && e.total === 5)).toBe(true);
  });

  it('stops batching and falls back to REST getRawText when first batch returns empty Map', async () => {
    const files: Record<string, string> = {};
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const treeEntries = ['n0.md', 'n1.md', 'n2.md', 'n3.md'].map((p, idx) => ({
      id: `b${idx}`,
      name: p,
      type: 'blob' as const,
      path: p,
      mode: '100644',
    }));

    const client = {
      getBranchHead: vi.fn().mockResolvedValue('head1'),
      getTreeRecursive: vi.fn().mockResolvedValue(treeEntries),
      getRawTextsBatch: vi.fn().mockResolvedValue(new Map<string, string>()),
      getRawText: vi.fn(async (p: string) => `rest:${p}`),
      createCommit: vi.fn(),
    };
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const engine = new SyncEngine({
      settings: DEFAULT_SETTINGS,
      state,
      client,
      vault,
      saveState: vi.fn(),
      batchDownloadSize: 2,
    });

    const res = await engine.sync();

    expect(res.pulled).toBe(4);
    expect(client.getRawTextsBatch).toHaveBeenCalledTimes(1);
    expect(client.getRawText).toHaveBeenCalledTimes(4);
    expect(files['n0.md']).toBe('rest:n0.md');
    expect(files['n3.md']).toBe('rest:n3.md');
  });

  it('auto-merges colliding tracked edits by keeping both sides and pushing to target branch', async () => {
    const files: Record<string, string> = { 'a.md': 'header\nmobile line\nfooter' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'a.md': { blobSha: 'r0', contentHash: await sha256Hex('header\nbase\nfooter') } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'r1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }])
        .mockResolvedValueOnce([{ id: 'r2', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }]),
      getRawText: vi.fn(async (_path: string, ref: string) => {
        if (ref === 'c1') return 'header\ndesktop line\nfooter';
        if (ref === 'c0') return 'header\nbase\nfooter';
        return '';
      }),
      createCommit: vi.fn().mockResolvedValue('c2'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(res.conflictBranch).toBeNull();
    expect(files['a.md']).toBe('header\ndesktop line\nmobile line\nfooter');
    expect(client.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'main',
        actions: [
          expect.objectContaining({
            action: 'update',
            file_path: 'a.md',
            content: 'header\ndesktop line\nmobile line\nfooter',
          }),
        ],
      }),
    );
    expect(state.lastSyncedCommitSha).toBe('c2');
  });

  it('auto-merges untracked files created on both sides with empty base', async () => {
    const files: Record<string, string> = { 'both.md': 'mobile note' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'r1', name: 'both.md', type: 'blob', path: 'both.md', mode: '100644' }])
        .mockResolvedValueOnce([{ id: 'r2', name: 'both.md', type: 'blob', path: 'both.md', mode: '100644' }]),
      getRawText: vi.fn(async (_path: string, ref: string) => (ref === 'c1' ? 'desktop note' : '')),
      createCommit: vi.fn().mockResolvedValue('c2'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(res.conflictBranch).toBeNull();
    expect(files['both.md']).toBe('desktop note\nmobile note');
    expect(res.pushed).toBe(1);
  });

  it('preserves edited files over deletions on either side', async () => {
    const files: Record<string, string> = { 'local-edited.md': 'kept mobile edit' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {
        'local-edited.md': { blobSha: 'r0a', contentHash: 'h0a' },
        'remote-edited.md': { blobSha: 'r0b', contentHash: 'h0b' },
      },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'r1b', name: 'remote-edited.md', type: 'blob', path: 'remote-edited.md', mode: '100644' }])
        .mockResolvedValueOnce([
          { id: 'r1b', name: 'remote-edited.md', type: 'blob', path: 'remote-edited.md', mode: '100644' },
          { id: 'r2a', name: 'local-edited.md', type: 'blob', path: 'local-edited.md', mode: '100644' },
        ]),
      getRawText: vi.fn(async (path: string, ref: string) => {
        if (path === 'remote-edited.md' && ref === 'c1') return 'kept remote edit';
        return '';
      }),
      createCommit: vi.fn().mockResolvedValue('c2'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(res.conflictBranch).toBeNull();
    expect(res.pulled).toBe(1);
    expect(res.pushed).toBe(1);
    expect(files['remote-edited.md']).toBe('kept remote edit');
    expect(files['local-edited.md']).toBe('kept mobile edit');
  });

  it('falls back to mobile-conflict branch when base commit fetch throws 404', async () => {
    const files: Record<string, string> = { 'a.md': 'mobile edit' };
    const state: SyncState = {
      lastSyncedCommitSha: 'missing-c0',
      activeConflictBranch: null,
      files: { 'a.md': { blobSha: 'r0', contentHash: 'h0' } },
      remoteImagePaths: [],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn().mockResolvedValue([{ id: 'r1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }]),
      getRawText: vi.fn(async (_path: string, ref: string) => {
        if (ref === 'c1') return 'desktop edit';
        throw new Error('GitLab API error (404): Commit Not Found');
      }),
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
    expect(files['a.md']).toBe('mobile edit');
  });

  it('skips getTreeRecursive and compareCommits when headSha equals lastSyncedCommitSha', async () => {
    const files: Record<string, string> = { 'a.md': 'updated locally' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: { 'a.md': { blobSha: 'r0', contentHash: await sha256Hex('old') } },
      remoteImagePaths: ['attachments/pic.png'],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c0'),
      getTreeRecursive: vi.fn(),
      compareCommits: vi.fn().mockResolvedValue([{ path: 'a.md', status: 'modified', blobSha: 'r1' }]),
      getRawText: vi.fn(),
      createCommit: vi.fn().mockResolvedValue('c1'),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(res.pushed).toBe(1);
    expect(client.getTreeRecursive).not.toHaveBeenCalled();
    expect(client.compareCommits).toHaveBeenCalledTimes(1);
    expect(client.compareCommits).toHaveBeenCalledWith('c0', 'c1');
    expect(state.files['a.md'].blobSha).toBe('r1');
    expect(state.remoteImagePaths).toEqual(['attachments/pic.png']);
  });

  it('uses compareCommits incrementally without getTreeRecursive when remote moves and falls back on null', async () => {
    const files: Record<string, string> = { 'keep.md': 'same', 'old.md': 'old' };
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {
        'keep.md': { blobSha: 'b-keep', contentHash: await sha256Hex('same') },
        'old.md': { blobSha: 'b-old', contentHash: await sha256Hex('old') },
      },
      remoteImagePaths: ['img/old.png'],
    };
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('c1'),
      getTreeRecursive: vi.fn(),
      compareCommits: vi.fn().mockResolvedValue([
        { path: 'new.md', previousPath: 'old.md', status: 'renamed', blobSha: 'b-new' },
        { path: 'img/old.png', status: 'deleted' },
        { path: 'img/added.png', status: 'added', blobSha: 'b-img' },
      ]),
      getRawText: vi.fn().mockResolvedValue('renamed content'),
      createCommit: vi.fn(),
    } as any;
    const vault = {
      listTextFiles: async () => Object.keys(files),
      readText: async (p: string) => files[p],
      writeText: async (p: string, c: string) => { files[p] = c; },
      deleteFile: async (p: string) => { delete files[p]; },
    };

    const engine = new SyncEngine({ settings: DEFAULT_SETTINGS, state, client, vault, saveState: vi.fn() });
    const res = await engine.sync();

    expect(client.getTreeRecursive).not.toHaveBeenCalled();
    expect(res.pulled).toBe(1);
    expect(res.deletedLocal).toBe(1);
    expect(files['new.md']).toBe('renamed content');
    expect(files['old.md']).toBeUndefined();
    expect(state.remoteImagePaths).toEqual(['img/added.png']);

    // Fallback to getTreeRecursive when compareCommits returns null
    client.getBranchHead.mockResolvedValue('c2');
    client.compareCommits.mockResolvedValueOnce(null);
    client.getTreeRecursive.mockResolvedValueOnce([
      { id: 'b-keep', name: 'keep.md', type: 'blob', path: 'keep.md', mode: '100644' },
      { id: 'b-new', name: 'new.md', type: 'blob', path: 'new.md', mode: '100644' },
    ]);
    await engine.sync();
    expect(client.getTreeRecursive).toHaveBeenCalledTimes(1);
  });
});
