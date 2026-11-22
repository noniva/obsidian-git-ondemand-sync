import { describe, it, expect, vi } from 'vitest';
import { GitHubClient } from '../../src/github/client';
import { GitLabClient, type RequestUrlFn } from '../../src/gitlab/client';
import { OnDemandImageLoader, type BlobUrlApi } from '../../src/images/loader';
import { uploadPastedImage } from '../../src/images/paste-upload';
import { SyncEngine, type VaultTextAdapter } from '../../src/sync/engine';
import { DEFAULT_SETTINGS, type PluginSettings, type SyncState } from '../../src/types';
import { FakeGitHubServer } from '../helpers/fake-github';
import { FakeGitLabServer } from '../helpers/fake-gitlab';

function createMemoryVault(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };

  // VaultTextAdapter omits writeBinary by design; full Plugin.app.vault.adapter wiring is tested in Task 6.
  const vault: VaultTextAdapter & {
    writeText: ReturnType<typeof vi.fn>;
    writeBinary: ReturnType<typeof vi.fn>;
  } = {
    listTextFiles: async () => Object.keys(files).sort(),
    readText: async (path: string) => {
      if (!(path in files)) {
        throw new Error(`File not found in vault: ${path}`);
      }
      return files[path];
    },
    writeText: vi.fn(async (path: string, content: string) => {
      files[path] = content;
    }),
    writeBinary: vi.fn(),
    deleteFile: async (path: string) => {
      delete files[path];
    },
  };

  return { vault, files };
}

function createMemoryBlobApi(): {
  blobApi: BlobUrlApi;
  blobsByUrl: Map<string, Blob>;
  revokedUrls: string[];
} {
  let seq = 0;
  const blobsByUrl = new Map<string, Blob>();
  const revokedUrls: string[] = [];

  const blobApi: BlobUrlApi = {
    createObjectURL: (blob: Blob) => {
      const url = `blob:fake-${++seq}`;
      blobsByUrl.set(url, blob);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
      blobsByUrl.delete(url);
    },
  };

  return { blobApi, blobsByUrl, revokedUrls };
}

function createMockImg(): HTMLImageElement {
  const classes = new Set<string>();
  return {
    src: '',
    dataset: {} as Record<string, string>,
    classList: {
      add: (...names: string[]) => {
        for (const n of names) classes.add(n);
      },
      remove: (...names: string[]) => {
        for (const n of names) classes.delete(n);
      },
      contains: (name: string) => classes.has(name),
    },
  } as unknown as HTMLImageElement;
}

function createTestSettings(): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    gitlabUrl: 'https://gitlab.example.com',
    projectId: 'user/obsidian-vault',
    branch: 'main',
    token: 'glpat-mobile-test',
  };
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('End-to-End Sync Lifecycle (FakeGitLabServer)', () => {
  it('handles full conflict -> paste upload -> 3-way merge with deletion & post-push edit -> branch delete -> clearConflictBranch -> clean re-sync', async () => {
    const server = new FakeGitLabServer({
      pageSize: 2,
      expectedToken: 'glpat-mobile-test',
    });
    const logoBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const baseCommitSha = server.seedBranch('main', {
      'notes/doc.md': 'line 1\nbase line 2\n',
      'notes/บันทึก (1).md': 'Unicode base note\n',
      'attachments/logo.png': logoBytes,
    });

    const settings = createTestSettings();
    const client = new GitLabClient(
      { baseUrl: settings.gitlabUrl, projectId: settings.projectId, token: settings.token },
      server.requestFn,
    );
    const { vault, files } = createMemoryVault();
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({
      settings,
      state,
      client,
      vault,
      saveState,
      now: () => new Date('2026-11-19T06:15:00Z'),
    });

    // 1. Initial empty-vault sync pulls text files (across paginated tree) and indexes image without disk writes
    const initRes = await engine.sync();
    expect(initRes).toEqual({
      pulled: 2,
      deletedLocal: 0,
      pushed: 0,
      conflictBranch: null,
      headCommitSha: baseCommitSha,
    });
    expect(files).toEqual({
      'notes/doc.md': 'line 1\nbase line 2\n',
      'notes/บันทึก (1).md': 'Unicode base note\n',
    });
    expect(state.remoteImagePaths).toEqual(['attachments/logo.png']);
    expect(state.lastSyncedCommitSha).toBe(baseCommitSha);
    expect(vault.writeBinary).not.toHaveBeenCalled();
    expect(vault.writeText).not.toHaveBeenCalledWith(
      expect.stringMatching(/\.(png|jpg|webp|heic)$/i),
      expect.anything(),
    );

    // 2. Desktop edits notes/doc.md on main; Mobile diverges on doc.md and creates 3 local notes
    server.commitOnBranch('main', 'Desktop edit', [
      {
        action: 'update',
        file_path: 'notes/doc.md',
        content: 'line 1\ndesktop line\nbase line 2\n',
        encoding: 'text',
      },
    ]);
    files['notes/doc.md'] = 'line 1\nbase line 2\nmobile line\n';
    files['notes/mobile-note.md'] = 'kept mobile note';
    files['notes/drop-in-merge.md'] = 'mobile draft dropped by desktop merge';
    files['notes/edit-after-push.md'] = 'v1 pushed to conflict branch';

    // 3. Mobile sync falls back to mobile-conflict/... when base commit raw fetch is unavailable (404)
    const rawSpy = vi.spyOn(client, 'getRawText').mockImplementation(async (filePath, ref) => {
      if (ref === baseCommitSha) {
        throw new Error('GitLab API error (404): Not Found');
      }
      return GitLabClient.prototype.getRawText.call(client, filePath, ref);
    });
    const conflictRes = await engine.sync();
    rawSpy.mockRestore();
    expect(conflictRes.conflictBranch).toBe('mobile-conflict/20261119-061500');
    expect(conflictRes.pushed).toBe(4);
    expect(state.activeConflictBranch).toBe('mobile-conflict/20261119-061500');
    expect(state.lastSyncedCommitSha).toBe(baseCommitSha);
    expect(files['notes/doc.md']).toBe('line 1\nbase line 2\nmobile line\n');

    const conflictBranchFiles = server.getBranchFiles(state.activeConflictBranch!);
    expect(decodeText(conflictBranchFiles['notes/doc.md'])).toBe('line 1\nbase line 2\nmobile line\n');
    expect(decodeText(conflictBranchFiles['notes/mobile-note.md'])).toBe('kept mobile note');
    expect(decodeText(conflictBranchFiles['notes/drop-in-merge.md'])).toBe(
      'mobile draft dropped by desktop merge',
    );
    expect(decodeText(conflictBranchFiles['notes/edit-after-push.md'])).toBe(
      'v1 pushed to conflict branch',
    );
    expect(decodeText(server.getBranchFiles('main')['notes/doc.md'])).toBe(
      'line 1\ndesktop line\nbase line 2\n',
    );

    // 4. Mobile pastes an image onto activeConflictBranch, then edits locally post-push
    const pastedBytes = new Uint8Array([82, 73, 70, 70, 10, 20, 30, 40]);
    const pasteRes = await uploadPastedImage({
      bytes: pastedBytes.buffer,
      mimeType: 'image/webp',
      attachmentFolder: 'attachments',
      branch: state.activeConflictBranch!,
      client,
      state,
      saveState,
      now: new Date('2026-11-19T06:16:00Z'),
    });
    expect(pasteRes.repoPath).toBe('attachments/Pasted image 20261119061600.webp');
    expect(state.remoteImagePaths).toContain(pasteRes.repoPath);
    expect(files[pasteRes.repoPath]).toBeUndefined();
    expect(server.getBranchFiles(state.activeConflictBranch!)[pasteRes.repoPath]).toEqual(
      pastedBytes,
    );

    files['notes/later.md'] = 'written after conflict push';
    files['notes/edit-after-push.md'] = 'v2 edited locally after conflict push';

    // 5. Desktop performs 3-way merge into main (3rd merged doc.md, keeps mobile-note + pasted image,
    //    and deletes both drop-in-merge.md & edit-after-push.md), then GitLab deletes conflict branch
    const mergedDoc = 'line 1\ndesktop line\nbase line 2\nmobile line\n';
    const mergeSha = server.mergeBranch(state.activeConflictBranch!, 'main', {
      resolvedFiles: {
        'notes/doc.md': mergedDoc,
        'notes/drop-in-merge.md': null,
        'notes/edit-after-push.md': null,
      },
    });
    server.deleteBranch(state.activeConflictBranch!);

    const mainAfterMerge = server.getBranchFiles('main');
    expect(decodeText(mainAfterMerge['notes/doc.md'])).toBe(mergedDoc);
    expect(decodeText(mainAfterMerge['notes/mobile-note.md'])).toBe('kept mobile note');
    expect(mainAfterMerge[pasteRes.repoPath]).toEqual(pastedBytes);
    expect(mainAfterMerge['notes/drop-in-merge.md']).toBeUndefined();
    expect(mainAfterMerge['notes/edit-after-push.md']).toBeUndefined();

    // 6. Sync while deleted activeConflictBranch is set throws actionable Clear Conflict State error
    await expect(engine.sync()).rejects.toThrow(/Clear Conflict State/i);
    expect(files['notes/later.md']).toBe('written after conflict push');
    expect(files['notes/drop-in-merge.md']).toBe('mobile draft dropped by desktop merge');
    expect(files['notes/edit-after-push.md']).toBe('v2 edited locally after conflict push');

    // 7. clearConflictBranch adopts merged doc.md, deletes untouched drop-in-merge.md,
    //    preserves post-push edits (later.md & edit-after-push.md), and clears conflict state
    await engine.clearConflictBranch();
    expect(files['notes/doc.md']).toBe(mergedDoc);
    expect(files['notes/mobile-note.md']).toBe('kept mobile note');
    expect(files['notes/drop-in-merge.md']).toBeUndefined();
    expect(files['notes/edit-after-push.md']).toBe('v2 edited locally after conflict push');
    expect(files['notes/later.md']).toBe('written after conflict push');
    expect(state.activeConflictBranch).toBeNull();
    expect(state.conflictPushedHashes).toBeUndefined();
    expect(state.conflictDeletedPaths).toBeUndefined();
    expect(state.lastSyncedCommitSha).toBe(mergeSha);
    expect(state.remoteImagePaths).toEqual(['attachments/logo.png', pasteRes.repoPath]);

    // 8. Subsequent sync pushes post-push edits cleanly with zero conflict loop, then converges to no-op
    const postClearRes = await engine.sync();
    expect(postClearRes.conflictBranch).toBeNull();
    expect(postClearRes.pulled).toBe(0);
    expect(postClearRes.deletedLocal).toBe(0);
    expect(postClearRes.pushed).toBe(2);
    expect(state.remoteImagePaths).toEqual([pasteRes.repoPath, 'attachments/logo.png']);

    const mainFinal = server.getBranchFiles('main');
    expect(decodeText(mainFinal['notes/later.md'])).toBe('written after conflict push');
    expect(decodeText(mainFinal['notes/edit-after-push.md'])).toBe(
      'v2 edited locally after conflict push',
    );
    expect(decodeText(mainFinal['notes/doc.md'])).toBe(mergedDoc);

    const noopRes = await engine.sync();
    expect(noopRes).toEqual({
      pulled: 0,
      deletedLocal: 0,
      pushed: 0,
      conflictBranch: null,
      headCommitSha: postClearRes.headCommitSha,
    });
    expect(vault.writeBinary).not.toHaveBeenCalled();
    expect(vault.writeText).not.toHaveBeenCalledWith(
      expect.stringMatching(/\.(png|jpg|webp|heic)$/i),
      expect.anything(),
    );
  });

  it('recovers cleanly from mid-incremental-pull raw failure and guards against concurrent Desktop pushes (TOCTOU + onBeforeCommit)', async () => {
    // Part A: Incremental pull partial-failure leaves vault & state consistent; retry succeeds cleanly
    const settings = createTestSettings();
    const server = new FakeGitLabServer({ pageSize: 2, expectedToken: settings.token });
    const c0 = server.seedBranch('main', {
      'notes/base.md': 'base v1',
    });
    let requestDelegate: RequestUrlFn = server.requestFn;
    const client = new GitLabClient(
      { baseUrl: settings.gitlabUrl, projectId: settings.projectId, token: settings.token },
      (req) => requestDelegate(req),
    );
    const { vault, files } = createMemoryVault();
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({
      settings,
      state,
      client,
      vault,
      saveState,
      now: () => new Date('2026-11-19T06:20:00Z'),
    });

    await engine.sync();
    expect(state.lastSyncedCommitSha).toBe(c0);

    const c1 = server.commitOnBranch('main', 'Desktop incremental batch', [
      { action: 'update', file_path: 'notes/base.md', content: 'base v2', encoding: 'text' },
      { action: 'create', file_path: 'notes/inc-a.md', content: 'inc A', encoding: 'text' },
      { action: 'create', file_path: 'notes/inc-b.md', content: 'inc B', encoding: 'text' },
    ]);

    saveState.mockClear();
    server.failNextRawFetch('notes/inc-b.md');
    await expect(engine.sync()).rejects.toThrow(/500/);
    expect(saveState).not.toHaveBeenCalled();
    expect(files).toEqual({ 'notes/base.md': 'base v1' });
    expect(state.files['notes/inc-a.md']).toBeUndefined();
    expect(state.lastSyncedCommitSha).toBe(c0);

    const retryRes = await engine.sync();
    // applyPulls persists pulled files before pushes, then sync() persists final head state.
    expect(saveState).toHaveBeenCalledTimes(2);
    expect(retryRes.pulled).toBe(3);
    expect(retryRes.conflictBranch).toBeNull();
    expect(files).toEqual({
      'notes/base.md': 'base v2',
      'notes/inc-a.md': 'inc A',
      'notes/inc-b.md': 'inc B',
    });
    expect(state.lastSyncedCommitSha).toBe(c1);

    // Part B: Concurrent Desktop commit right before TOCTOU getBranchHead check aborts cleanly without overwriting Desktop
    files['notes/base.md'] = 'mobile edit';
    let branchChecks = 0;
    saveState.mockClear();
    requestDelegate = async (req) => {
      if ((req.method ?? 'GET').toUpperCase() === 'GET' && req.url.includes('/repository/branches/main')) {
        branchChecks++;
        if (branchChecks === 2) {
          server.commitOnBranch('main', 'Desktop concurrent update', [
            {
              action: 'update',
              file_path: 'notes/base.md',
              content: 'desktop concurrent update',
              encoding: 'text',
            },
          ]);
        }
      }
      return server.requestFn(req);
    };

    try {
      await expect(engine.sync()).rejects.toThrow(/target branch moved/i);
    } finally {
      requestDelegate = server.requestFn;
    }
    expect(saveState).not.toHaveBeenCalled();
    expect(decodeText(server.getBranchFiles('main')['notes/base.md'])).toBe(
      'desktop concurrent update',
    );
    expect(state.lastSyncedCommitSha).toBe(c1);
    expect(files['notes/base.md']).toBe('mobile edit');

    const conflictAfterToctou = await engine.sync();
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(conflictAfterToctou.conflictBranch).toBeNull();
    expect(decodeText(server.getBranchFiles('main')['notes/base.md'])).toBe(
      'desktop concurrent update\nmobile edit',
    );
    expect(files['notes/base.md']).toBe('desktop concurrent update\nmobile edit');

    // Part C: onBeforeCommit injects a concurrent Desktop create right before Mobile's createCommit;
    // FakeGitLabServer rejects duplicate create (400), preserving Desktop, and next sync detects conflict cleanly
    const raceServer = new FakeGitLabServer();
    const r0 = raceServer.seedBranch('main', { 'notes/seed.md': 'seed' });
    const raceClient = new GitLabClient(
      { baseUrl: settings.gitlabUrl, projectId: settings.projectId, token: settings.token },
      raceServer.requestFn,
    );
    const raceVault = createMemoryVault();
    const raceState: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const raceSaveState = vi.fn();
    const raceEngine = new SyncEngine({
      settings,
      state: raceState,
      client: raceClient,
      vault: raceVault.vault,
      saveState: raceSaveState,
      now: () => new Date('2026-11-19T06:22:00Z'),
    });
    await raceEngine.sync();

    raceSaveState.mockClear();
    raceVault.files['notes/race.md'] = 'mobile raced create';
    raceServer.onBeforeCommit(() => {
      raceServer.onBeforeCommit(null);
      raceServer.commitOnBranch('main', 'Desktop concurrent create', [
        {
          action: 'create',
          file_path: 'notes/race.md',
          content: 'desktop raced create',
          encoding: 'text',
        },
      ]);
    });

    await expect(raceEngine.sync()).rejects.toThrow(/400.*already exists/i);
    expect(raceSaveState).not.toHaveBeenCalled();
    expect(decodeText(raceServer.getBranchFiles('main')['notes/race.md'])).toBe(
      'desktop raced create',
    );
    expect(raceState.lastSyncedCommitSha).toBe(r0);

    const raceConflict = await raceEngine.sync();
    expect(raceSaveState).toHaveBeenCalledTimes(1);
    expect(raceConflict.conflictBranch).toBeNull();
    expect(decodeText(raceServer.getBranchFiles('main')['notes/race.md'])).toBe(
      'desktop raced create\nmobile raced create',
    );
    expect(raceVault.files['notes/race.md']).toBe('desktop raced create\nmobile raced create');

    // Verify FakeGitLabServer enforces missing-file update/delete (400) and auth (401)
    await expect(
      raceClient.createCommit({
        branch: 'main',
        commitMessage: 'Invalid missing delete',
        actions: [{ action: 'delete', file_path: 'notes/does-not-exist.md' }],
      }),
    ).rejects.toThrow(/400/);

    const badTokenClient = new GitLabClient(
      { baseUrl: settings.gitlabUrl, projectId: settings.projectId, token: 'wrong-token' },
      server.requestFn,
    );
    await expect(badTokenClient.getBranchHead('main')).rejects.toThrow(/401/);
  });

  it('loads Desktop-added and Mobile-pasted images on demand into blob URLs without touching disk', async () => {
    const server = new FakeGitLabServer({ pageSize: 2 });
    const logoBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42, 43]);
    server.seedBranch('main', {
      'notes/gallery.md': '![[attachments/logo.png]]',
      'notes/one.md': 'one',
      'notes/two.md': 'two',
      'attachments/logo.png': logoBytes,
    });

    const settings = createTestSettings();
    const client = new GitLabClient(
      { baseUrl: settings.gitlabUrl, projectId: settings.projectId, token: settings.token },
      server.requestFn,
    );
    const { vault, files } = createMemoryVault();
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({ settings, state, client, vault, saveState });

    await engine.sync();
    expect(state.remoteImagePaths).toEqual(['attachments/logo.png']);
    expect(Object.keys(files).sort()).toEqual(['notes/gallery.md', 'notes/one.md', 'notes/two.md']);

    const { blobApi, blobsByUrl, revokedUrls } = createMemoryBlobApi();
    const loader = new OnDemandImageLoader(client, blobApi, 3);

    // 1. Load seeded Desktop image into memory Blob URL
    const logoImg = createMockImg();
    const logoCleanup = loader.loadIntoElement(logoImg, 'attachments/logo.png', 'main');
    await vi.waitFor(() => expect(logoImg.src).toBe('blob:fake-1'));
    const loadedLogoBlob = blobsByUrl.get('blob:fake-1')!;
    expect(loadedLogoBlob.type).toBe('image/png');
    expect(new Uint8Array(await loadedLogoBlob.arrayBuffer())).toEqual(logoBytes);

    // 2. Desktop adds a second image; Mobile syncs index and loads it on demand
    const jpgBytes = new Uint8Array([255, 216, 255, 224, 9, 8, 7]);
    server.commitOnBranch('main', 'Desktop adds photo', [
      {
        action: 'create',
        file_path: 'attachments/desktop-photo.jpg',
        content: Buffer.from(jpgBytes).toString('base64'),
        encoding: 'base64',
      },
    ]);
    await engine.sync();
    expect(state.remoteImagePaths).toEqual([
      'attachments/desktop-photo.jpg',
      'attachments/logo.png',
    ]);

    const jpgImg = createMockImg();
    loader.loadIntoElement(jpgImg, 'attachments/desktop-photo.jpg', 'main');
    await vi.waitFor(() => expect(jpgImg.src).toBe('blob:fake-2'));
    const loadedJpgBlob = blobsByUrl.get('blob:fake-2')!;
    expect(loadedJpgBlob.type).toBe('image/jpeg');
    expect(new Uint8Array(await loadedJpgBlob.arrayBuffer())).toEqual(jpgBytes);

    // 3. Mobile pastes an image, caches it in memory, then reloads from FakeGitLabServer via fallbackRef after revokeAll
    const pastedBytes = new Uint8Array([137, 80, 78, 71, 99, 88, 77]);
    const uploaded = await uploadPastedImage({
      bytes: pastedBytes.buffer,
      mimeType: 'image/png',
      attachmentFolder: 'attachments',
      branch: 'main',
      client,
      state,
      saveState,
      now: new Date('2026-11-19T06:30:00Z'),
    });

    const memUrl = loader.registerMemoryImage(
      uploaded.repoPath,
      new Blob([pastedBytes], { type: 'image/png' }),
    );
    expect(memUrl).toBe('blob:fake-3');

    const cachedImg = createMockImg();
    loader.loadIntoElement(cachedImg, uploaded.repoPath, 'main');
    expect(cachedImg.src).toBe('blob:fake-3');

    logoCleanup();
    loader.revokeAll();
    expect(revokedUrls).toContain('blob:fake-1');
    expect(revokedUrls).toContain('blob:fake-2');
    expect(revokedUrls).toContain('blob:fake-3');

    const fallbackImg = createMockImg();
    loader.loadIntoElement(fallbackImg, uploaded.repoPath, 'mobile-conflict/missing', 'main');
    await vi.waitFor(() => expect(fallbackImg.src).toBe('blob:fake-4'));
    const reloadedPastedBlob = blobsByUrl.get('blob:fake-4')!;
    expect(reloadedPastedBlob.type).toBe('image/png');
    expect(new Uint8Array(await reloadedPastedBlob.arrayBuffer())).toEqual(pastedBytes);

    expect(vault.writeBinary).not.toHaveBeenCalled();
    expect(vault.writeText).not.toHaveBeenCalledWith(
      expect.stringMatching(/\.(png|jpg|webp|heic)$/i),
      expect.anything(),
    );
    expect(Object.keys(files).sort()).toEqual(['notes/gallery.md', 'notes/one.md', 'notes/two.md']);
  });
});

describe('End-to-End Sync Lifecycle (FakeGitHubServer)', () => {
  it('handles initial pull, remote image indexing, conflict push (startSha), paste upload, and clearConflictBranch reconciliation', async () => {
    const server = new FakeGitHubServer({ expectedToken: 'ghp-mobile-test' });
    const logoBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const baseCommitSha = server.seedBranch('main', {
      'notes/doc.md': 'line 1\nbase line 2\n',
      'notes/บันทึก (1).md': 'Unicode base note\n',
      'attachments/logo.png': logoBytes,
    });

    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      provider: 'github',
      apiUrl: 'https://api.github.com',
      projectId: 'owner/obsidian-vault',
      branch: 'main',
      token: 'ghp-mobile-test',
    };
    const client = new GitHubClient(
      { baseUrl: settings.apiUrl, projectId: settings.projectId, token: settings.token },
      server.requestFn,
    );
    const { vault, files } = createMemoryVault();
    const state: SyncState = {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const saveState = vi.fn();
    const engine = new SyncEngine({
      settings,
      state,
      client,
      vault,
      saveState,
      now: () => new Date('2026-11-19T06:15:00Z'),
    });

    // 1. Initial empty-vault pull & remote image indexing without binary writes
    const initRes = await engine.sync();
    expect(initRes).toEqual({
      pulled: 2,
      deletedLocal: 0,
      pushed: 0,
      conflictBranch: null,
      headCommitSha: baseCommitSha,
    });
    expect(files).toEqual({
      'notes/doc.md': 'line 1\nbase line 2\n',
      'notes/บันทึก (1).md': 'Unicode base note\n',
    });
    expect(state.remoteImagePaths).toEqual(['attachments/logo.png']);
    expect(state.lastSyncedCommitSha).toBe(baseCommitSha);
    expect(vault.writeBinary).not.toHaveBeenCalled();

    // 2. Desktop edits main; Mobile diverges on doc.md and adds local notes
    server.commitOnBranch('main', 'Desktop edit', [
      {
        action: 'update',
        file_path: 'notes/doc.md',
        content: 'line 1\ndesktop line\nbase line 2\n',
        encoding: 'text',
      },
    ]);
    files['notes/doc.md'] = 'line 1\nbase line 2\nmobile line\n';
    files['notes/mobile-note.md'] = 'kept mobile note';
    files['notes/drop-in-merge.md'] = 'mobile draft dropped by desktop merge';

    // 3. Fallback conflict push creates mobile-conflict/<timestamp> from baseCommitSha when base raw fetch is 404
    const rawSpy = vi.spyOn(client, 'getRawText').mockImplementation(async (filePath, ref) => {
      if (ref === baseCommitSha) {
        throw new Error('GitHub API error (404): Not Found');
      }
      return GitHubClient.prototype.getRawText.call(client, filePath, ref);
    });
    const conflictRes = await engine.sync();
    rawSpy.mockRestore();
    expect(conflictRes.conflictBranch).toBe('mobile-conflict/20261119-061500');
    expect(conflictRes.pushed).toBe(3);
    expect(state.activeConflictBranch).toBe('mobile-conflict/20261119-061500');
    expect(state.lastSyncedCommitSha).toBe(baseCommitSha);

    const conflictBranchFiles = server.getBranchFiles(state.activeConflictBranch!);
    expect(decodeText(conflictBranchFiles['notes/doc.md'])).toBe('line 1\nbase line 2\nmobile line\n');
    expect(decodeText(conflictBranchFiles['notes/mobile-note.md'])).toBe('kept mobile note');

    // 4. Mobile pastes an image onto activeConflictBranch via GitHubClient
    const pastedBytes = new Uint8Array([82, 73, 70, 70, 10, 20, 30, 40]);
    const pasteRes = await uploadPastedImage({
      bytes: pastedBytes.buffer,
      mimeType: 'image/webp',
      attachmentFolder: 'attachments',
      branch: state.activeConflictBranch!,
      client,
      state,
      saveState,
      now: new Date('2026-11-19T06:16:00Z'),
    });
    expect(pasteRes.repoPath).toBe('attachments/Pasted image 20261119061600.webp');
    expect(state.remoteImagePaths).toContain(pasteRes.repoPath);
    expect(server.getBranchFiles(state.activeConflictBranch!)[pasteRes.repoPath]).toEqual(pastedBytes);

    // 5. Desktop merges into main, deletes conflict branch; Mobile reconciles via clearConflictBranch
    files['notes/later.md'] = 'written after conflict push';
    const mergedDoc = 'line 1\ndesktop line\nbase line 2\nmobile line\n';
    const mergeSha = server.mergeBranch(state.activeConflictBranch!, 'main', {
      resolvedFiles: {
        'notes/doc.md': mergedDoc,
        'notes/drop-in-merge.md': null,
      },
    });
    server.deleteBranch(state.activeConflictBranch!);

    await expect(engine.sync()).rejects.toThrow(/Clear Conflict State/i);

    await engine.clearConflictBranch();
    expect(files['notes/doc.md']).toBe(mergedDoc);
    expect(files['notes/mobile-note.md']).toBe('kept mobile note');
    expect(files['notes/drop-in-merge.md']).toBeUndefined();
    expect(files['notes/later.md']).toBe('written after conflict push');
    expect(state.activeConflictBranch).toBeNull();
    expect(state.lastSyncedCommitSha).toBe(mergeSha);
    expect(state.remoteImagePaths).toEqual(['attachments/logo.png', pasteRes.repoPath]);

    // 6. Post-clear sync pushes post-push edit cleanly and converges to no-op
    const postClearRes = await engine.sync();
    expect(postClearRes.conflictBranch).toBeNull();
    expect(postClearRes.pushed).toBe(1);

    const noopRes = await engine.sync();
    expect(noopRes).toEqual({
      pulled: 0,
      deletedLocal: 0,
      pushed: 0,
      conflictBranch: null,
      headCommitSha: postClearRes.headCommitSha,
    });
  });
});
