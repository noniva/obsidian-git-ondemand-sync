// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { notices, noticeInstances, requestUrlBox } = vi.hoisted(() => ({
  notices: [] as Array<{ message: string; timeout?: number }>,
  noticeInstances: [] as Array<{
    message: string;
    timeout?: number;
    hidden: boolean;
    messageEl: HTMLElement;
  }>,
  requestUrlBox: {
    fn: (async () => {
      throw new Error('requestUrl handler not configured');
    }) as (req: any) => Promise<any>,
  },
}));

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  class SpyNotice extends actual.Notice {
    constructor(message: string | DocumentFragment, timeout?: number) {
      super(message, timeout);
      const record = {
        message: this.message,
        timeout,
        hidden: false,
        messageEl: this.messageEl,
      };
      notices.push(record);
      noticeInstances.push(record);
    }

    override setMessage(message: string | DocumentFragment): this {
      super.setMessage(message);
      const last = noticeInstances[noticeInstances.length - 1];
      if (last && last.messageEl === this.messageEl) {
        last.message = this.message;
      }
      return this;
    }

    override hide(): void {
      super.hide();
      const idx = noticeInstances.findIndex((n) => n.messageEl === this.messageEl);
      if (idx >= 0) {
        noticeInstances[idx].hidden = true;
      }
    }
  }
  return {
    ...actual,
    Notice: SpyNotice,
    requestUrl: (req: any) => requestUrlBox.fn(req),
  };
});

import { Platform, TFile, type App, type MarkdownPostProcessor, type PluginManifest } from 'obsidian';
import { refreshRemoteImagesEffect } from '../src/images/live-preview';
import { OnDemandImageLoader } from '../src/images/loader';
import GitLabOnDemandSyncPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/types';
import { normalizeVaultPath } from '../src/utils/paths';
import { FakeGitLabServer } from './helpers/fake-gitlab';

const EMOJI_RE = /\p{Extended_Pictographic}/u;

function createVaultAppHarness(options?: {
  configDir?: string;
  initialFiles?: Record<string, string>;
  extraDotFilesInGetFiles?: string[];
}) {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const configDir = options?.configDir ?? '.obsidian';

  const recordParents = (filePath: string) => {
    const parts = normalizeVaultPath(filePath).split('/');
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      dirs.add(cur);
    }
  };

  for (const [rawPath, content] of Object.entries(options?.initialFiles ?? {})) {
    const p = normalizeVaultPath(rawPath);
    files.set(p, content);
    recordParents(p);
  }

  const toTFile = (p: string): TFile => {
    const tf = new TFile();
    tf.path = p;
    const lastSlash = p.lastIndexOf('/');
    tf.name = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
    const dot = tf.name.lastIndexOf('.');
    tf.extension = dot > 0 ? tf.name.slice(dot + 1) : '';
    tf.basename = dot > 0 ? tf.name.slice(0, dot) : tf.name;
    return tf;
  };

  const layoutReadyCallbacks: Array<() => void> = [];
  const leafDispatches: Array<unknown> = [];
  const leafRerenders: Array<boolean | undefined> = [];
  const writeBinarySpy = vi.fn();
  const createBinarySpy = vi.fn();

  const adapter = {
    exists: vi.fn(async (p: string) => {
      const norm = normalizeVaultPath(p);
      return files.has(norm) || dirs.has(norm);
    }),
    list: vi.fn(async (dir: string) => {
      const normDir = normalizeVaultPath(dir);
      const prefix = normDir ? `${normDir}/` : '';
      const childFiles: string[] = [];
      const childFolders = new Set<string>();

      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          childFiles.push(filePath);
        } else {
          childFolders.add(`${prefix}${rest.slice(0, slash)}`);
        }
      }
      return {
        files: childFiles.sort(),
        folders: Array.from(childFolders).sort(),
      };
    }),
    read: vi.fn(async (p: string) => {
      const norm = normalizeVaultPath(p);
      if (!files.has(norm)) {
        throw new Error(`Missing file: ${norm}`);
      }
      return files.get(norm)!;
    }),
    write: vi.fn(async (p: string, content: string) => {
      const norm = normalizeVaultPath(p);
      recordParents(norm);
      files.set(norm, content);
    }),
    writeBinary: writeBinarySpy,
    remove: vi.fn(async (p: string) => {
      files.delete(normalizeVaultPath(p));
    }),
    mkdir: vi.fn(async (p: string) => {
      dirs.add(normalizeVaultPath(p));
    }),
  };

  const app = {
    vault: {
      configDir,
      adapter,
      createBinary: createBinarySpy,
      getFiles: vi.fn(() => {
        const result: TFile[] = [];
        for (const filePath of files.keys()) {
          if (!filePath.startsWith('.')) {
            result.push(toTFile(filePath));
          }
        }
        for (const extra of options?.extraDotFilesInGetFiles ?? []) {
          const norm = normalizeVaultPath(extra);
          if (files.has(norm)) {
            result.push(toTFile(norm));
          }
        }
        return result;
      }),
      getAbstractFileByPath: vi.fn((p: string) => {
        const norm = normalizeVaultPath(p);
        return files.has(norm) ? toTFile(norm) : null;
      }),
      readBinary: vi.fn(),
      delete: vi.fn(),
      on: vi.fn(() => ({})),
    },
    workspace: {
      on: vi.fn(() => ({})),
      onLayoutReady: vi.fn((cb: () => void) => {
        layoutReadyCallbacks.push(cb);
      }),
      getLeavesOfType: vi.fn(() => [
        {
          view: {
            editor: { cm: { dispatch: (tr: unknown) => leafDispatches.push(tr) } },
            previewMode: { rerender: (full?: boolean) => leafRerenders.push(full) },
          },
        },
      ]),
      getActiveViewOfType: vi.fn(() => null),
    },
  } as unknown as App;

  const triggerLayoutReady = () => {
    while (layoutReadyCallbacks.length > 0) {
      layoutReadyCallbacks.shift()!();
    }
  };

  return {
    app,
    files,
    writeBinarySpy,
    createBinarySpy,
    leafDispatches,
    leafRerenders,
    triggerLayoutReady,
  };
}

const TEST_MANIFEST = { id: 'gitlab-ondemand-sync', name: 'GitLab On-Demand Sync', version: '0.1.0' } as PluginManifest;

describe('GitLabOnDemandSyncPlugin', () => {
  beforeEach(() => {
    notices.length = 0;
    noticeInstances.length = 0;
    Platform.isMobile = false;
    Platform.isDesktop = true;
    requestUrlBox.fn = async () => {
      throw new Error('Unexpected requestUrl call');
    };
  });

  afterEach(() => {
    Platform.isMobile = false;
    Platform.isDesktop = true;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gates isEnabled() by Platform.isMobile or enableOnDesktop and checks Notice preconditions', async () => {
    const { app } = createVaultAppHarness();
    const plugin = new GitLabOnDemandSyncPlugin(app, TEST_MANIFEST);
    await plugin.onload();

    expect(plugin.isEnabled()).toBe(false);
    await plugin.syncWithNotice();
    expect(notices[0].message).toContain('disabled on desktop');

    plugin.settings.enableOnDesktop = true;
    expect(plugin.isEnabled()).toBe(true);
    await plugin.syncWithNotice();
    expect(notices[1].message).toContain('Project ID and Personal Access Token');

    plugin.settings.enableOnDesktop = false;
    Platform.isMobile = true;
    expect(plugin.isEnabled()).toBe(true);

    const saveSpy = vi.spyOn(plugin, 'saveData');
    await plugin.saveAndRefreshSettings();
    expect(saveSpy).toHaveBeenCalledWith({
      settings: plugin.settings,
      syncState: plugin.syncState,
    });
  });

  it('recovers partial/legacy loadPluginData and sanitizes or preserves conflict markers', async () => {
    const { app } = createVaultAppHarness();

    // Case 1: null/empty persisted data -> full defaults
    const pluginEmpty = new GitLabOnDemandSyncPlugin(app, TEST_MANIFEST);
    vi.spyOn(pluginEmpty, 'loadData').mockResolvedValueOnce(null);
    await pluginEmpty.onload();
    expect(pluginEmpty.settings).toEqual(DEFAULT_SETTINGS);
    expect(pluginEmpty.syncState).toEqual({
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    });

    // Case 2: partial settings + malformed legacy conflict fields
    const pluginPartial = new GitLabOnDemandSyncPlugin(app, TEST_MANIFEST);
    vi.spyOn(pluginPartial, 'loadData').mockResolvedValueOnce({
      settings: { projectId: 'group/vault', token: 'glpat-1' },
      syncState: {
        lastSyncedCommitSha: 'sha-1',
        files: { 'a.md': { blobSha: 'b1', contentHash: 'h1' } },
        remoteImagePaths: ['attachments/pic.png'],
        conflictPushedHashes: ['not-an-object'],
        conflictDeletedPaths: 'not-an-array',
      },
    });
    await pluginPartial.onload();
    expect(pluginPartial.settings.provider).toBe('gitlab');
    expect(pluginPartial.settings.apiUrl).toBe('https://gitlab.com');
    expect(pluginPartial.settings.gitlabUrl).toBeUndefined();
    expect(pluginPartial.settings.textAllowlist).toEqual(DEFAULT_SETTINGS.textAllowlist);
    expect(pluginPartial.settings.projectId).toBe('group/vault');
    expect(pluginPartial.syncState.conflictPushedHashes).toBeUndefined();
    expect(pluginPartial.syncState.conflictDeletedPaths).toBeUndefined();

    // Case 3: valid conflict markers are preserved and cloned
    const persistedHashes = { 'note.md': 'hash-1' };
    const persistedDeletes = ['old.md'];
    const pluginConflict = new GitLabOnDemandSyncPlugin(app, TEST_MANIFEST);
    vi.spyOn(pluginConflict, 'loadData').mockResolvedValueOnce({
      settings: { textAllowlist: ['.md'] },
      syncState: {
        lastSyncedCommitSha: 'sha-2',
        activeConflictBranch: 'mobile-conflict/20261119-060000',
        files: {},
        remoteImagePaths: [],
        conflictPushedHashes: persistedHashes,
        conflictDeletedPaths: persistedDeletes,
      },
    });
    await pluginConflict.onload();
    expect(pluginConflict.syncState.activeConflictBranch).toBe('mobile-conflict/20261119-060000');
    expect(pluginConflict.syncState.conflictPushedHashes).toEqual({ 'note.md': 'hash-1' });
    expect(pluginConflict.syncState.conflictPushedHashes).not.toBe(persistedHashes);
    expect(pluginConflict.syncState.conflictDeletedPaths).toEqual(['old.md']);
    expect(pluginConflict.syncState.conflictDeletedPaths).not.toBe(persistedDeletes);
  });

  it('wires VaultTextAdapter with custom configDir, excludes dot-folders, never calls writeBinary, and refreshes editors', async () => {
    const server = new FakeGitLabServer({ expectedToken: 'glpat-test' });
    server.seedBranch('main', {
      'notes/hello.md': '# Hello',
      '.obsidian-custom/snippets/mobile.css': 'body { color: red; }',
      '.obsidian-custom/.git/HEAD': 'ref: refs/heads/main',
      '.obsidian/legacy.css': 'body {}',
      '.git/config': '[core]',
      '.vscode/settings.json': '{}',
      'attachments/diagram.png': new Uint8Array([137, 80, 78, 71]),
    });
    requestUrlBox.fn = server.requestFn;

    const harness = createVaultAppHarness({
      configDir: '.obsidian-custom',
      extraDotFilesInGetFiles: ['.github/ISSUE_TEMPLATE/bug.md'],
    });
    const plugin = new GitLabOnDemandSyncPlugin(harness.app, TEST_MANIFEST);
    vi.spyOn(plugin, 'loadData').mockResolvedValueOnce({
      settings: {
        gitlabUrl: 'https://gitlab.example.com',
        projectId: 'user/vault',
        branch: 'main',
        token: 'glpat-test',
        textAllowlist: ['.md', '.css'],
        syncObsidianDir: true,
        enableOnDesktop: true,
      },
    });
    await plugin.onload();
    await plugin.syncWithNotice();

    // Only allowlisted text in vault & custom configDir pulled; dot-folders & other .obsidian ignored
    expect(harness.files.get('notes/hello.md')).toBe('# Hello');
    expect(harness.files.get('.obsidian-custom/snippets/mobile.css')).toBe('body { color: red; }');
    expect(harness.files.has('.obsidian-custom/.git/HEAD')).toBe(false);
    expect(harness.files.has('.obsidian/legacy.css')).toBe(false);
    expect(harness.files.has('.git/config')).toBe(false);
    expect(harness.files.has('.vscode/settings.json')).toBe(false);
    expect(harness.files.has('attachments/diagram.png')).toBe(false);

    // Zero binary writes to disk; remote image indexed in state instead
    expect(harness.writeBinarySpy).not.toHaveBeenCalled();
    expect(harness.createBinarySpy).not.toHaveBeenCalled();
    expect(plugin.syncState.remoteImagePaths).toEqual(['attachments/diagram.png']);

    // Open editors refreshed
    expect(harness.leafDispatches).toHaveLength(1);
    const dispatchArg = harness.leafDispatches[0] as { effects: { is: (e: unknown) => boolean } };
    expect(dispatchArg.effects.is(refreshRemoteImagesEffect)).toBe(true);
    expect(harness.leafRerenders).toEqual([true]);

    // Now test syncObsidianDir=false and dot-file filtering on local push (including allowlisted extensions inside dot-dirs)
    plugin.settings.syncObsidianDir = false;
    harness.files.set('.obsidian-custom/snippets/local-only.css', 'body { margin: 0; }');
    harness.files.set('.github/ISSUE_TEMPLATE/bug.md', '# bug');
    harness.files.set('.obsidian-custom/.git/HEAD.md', 'ref');
    harness.files.set('notes/hello.md', '# Updated');

    await plugin.syncWithNotice();
    const headFiles = server.getBranchFiles('main');
    expect(new TextDecoder().decode(headFiles['notes/hello.md'])).toBe('# Updated');
    expect(headFiles['.obsidian-custom/snippets/local-only.css']).toBeUndefined();
    expect(headFiles['.github/ISSUE_TEMPLATE/bug.md']).toBeUndefined();
    expect(headFiles['.obsidian-custom/.git/HEAD.md']).toBeUndefined();

    // Delete file locally -> removed on next pull when deleted on remote
    server.commitOnBranch('main', 'delete note', [{ action: 'delete', file_path: 'notes/hello.md' }]);
    await plugin.syncWithNotice();
    expect(harness.files.has('notes/hello.md')).toBe(false);
  });

  it('guards re-entrant syncWithNotice, emits conflict/error Notices, and uses zero raw emojis', async () => {
    const server = new FakeGitLabServer({ expectedToken: 'glpat-test' });
    const baseSha = server.seedBranch('main', { 'note.md': 'v0' });

    let releaseBranchFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBranchFetch = resolve;
    });

    let blockFirstCall = true;
    requestUrlBox.fn = async (req) => {
      if (blockFirstCall) {
        blockFirstCall = false;
        await gate;
      }
      return server.requestFn(req);
    };

    const harness = createVaultAppHarness();
    const plugin = new GitLabOnDemandSyncPlugin(harness.app, TEST_MANIFEST);
    vi.spyOn(plugin, 'loadData').mockResolvedValueOnce({
      settings: {
        gitlabUrl: 'https://gitlab.example.com',
        projectId: 'user/vault',
        branch: 'main',
        token: 'glpat-test',
        enableOnDesktop: true,
      },
    });
    await plugin.onload();

    const firstSync = plugin.syncWithNotice();
    await plugin.syncWithNotice();
    const progressNotice = noticeInstances[0];
    expect(progressNotice.timeout).toBe(0);
    expect(notices[1].message).toBe('Git sync is already in progress.');

    releaseBranchFetch();
    await firstSync;
    expect(progressNotice.hidden).toBe(true);
    expect(progressNotice.messageEl.querySelector('.gitlab-sync-progress-bar')).not.toBeNull();
    expect(notices[2].message).toBe(
      'Git sync complete: 1 pulled, 0 pushed, 0 deleted (0 remote images indexed).',
    );
    expect(plugin.lastSyncError).toBeNull();

    // Trigger failure notice with underlying cause and ensure persistent timeout: 0 + console.error
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    requestUrlBox.fn = async () => {
      throw new Error('ENOTFOUND gitlab.example.com');
    };
    await plugin.syncWithNotice();
    const failNotice = notices[notices.length - 1];
    expect(failNotice.timeout).toBe(0);
    expect(failNotice.message).toContain('Git sync failed:');
    expect(failNotice.message).toContain('ENOTFOUND gitlab.example.com');
    expect(failNotice.message).toContain('click to dismiss');
    expect(plugin.lastSyncError).toContain('ENOTFOUND gitlab.example.com');
    expect(errSpy).toHaveBeenCalled();

    requestUrlBox.fn = server.requestFn;
    await plugin.syncWithNotice();
    expect(notices[notices.length - 1].message).toContain('Git sync complete:');
    expect(plugin.lastSyncError).toBeNull();

    // Trigger conflict sync: modify both local and remote
    harness.files.set('note.md', 'local edit');
    server.commitOnBranch('main', 'remote edit', [
      { action: 'update', file_path: 'note.md', content: 'remote edit', encoding: 'text' },
    ]);
    await plugin.syncWithNotice();
    const conflictNotice = notices[notices.length - 1];
    expect(conflictNotice.message).toContain('Git sync conflict!');
    expect(conflictNotice.message).toContain('mobile-conflict/');
    expect(plugin.syncState.lastSyncedCommitSha).toBe(baseSha);

    for (const notice of notices) {
      expect(notice.message).not.toMatch(EMOJI_RE);
    }
  });

  it('emits startup conflict reminder Notice and auto-syncs onLayoutReady only when enabled', async () => {
    const server = new FakeGitLabServer({ expectedToken: 'glpat-test' });
    const mainHeadSha = server.seedBranch('main', { 'welcome.md': 'hi' });
    requestUrlBox.fn = server.requestFn;

    // Disabled on desktop -> no reminder, no auto-sync
    const disabledHarness = createVaultAppHarness();
    const disabledPlugin = new GitLabOnDemandSyncPlugin(disabledHarness.app, TEST_MANIFEST);
    vi.spyOn(disabledPlugin, 'loadData').mockResolvedValueOnce({
      settings: {
        gitlabUrl: 'https://gitlab.example.com',
        projectId: 'user/vault',
        token: 'glpat-test',
        autoSyncOnOpen: true,
        enableOnDesktop: false,
      },
      syncState: {
        activeConflictBranch: 'mobile-conflict/20261119-010203',
      },
    });
    await disabledPlugin.onload();
    disabledHarness.triggerLayoutReady();
    expect(notices).toHaveLength(0);
    expect(disabledHarness.files.size).toBe(0);

    // Enabled -> emits conflict reminder Notice and runs auto-sync onLayoutReady
    const enabledHarness = createVaultAppHarness();
    const enabledPlugin = new GitLabOnDemandSyncPlugin(enabledHarness.app, TEST_MANIFEST);
    server.seedBranch('mobile-conflict/20261119-010203', { 'welcome.md': 'hi' });
    vi.spyOn(enabledPlugin, 'loadData').mockResolvedValueOnce({
      settings: {
        gitlabUrl: 'https://gitlab.example.com',
        projectId: 'user/vault',
        token: 'glpat-test',
        autoSyncOnOpen: true,
        enableOnDesktop: true,
      },
      syncState: {
        lastSyncedCommitSha: mainHeadSha,
        activeConflictBranch: 'mobile-conflict/20261119-010203',
        files: {},
        remoteImagePaths: [],
      },
    });
    await enabledPlugin.onload();
    enabledHarness.triggerLayoutReady();

    expect(notices[0].message).toContain('mobile-conflict/20261119-010203');
    expect(notices[0].message).toContain('Clear Conflict State');
    await vi.waitFor(() => expect(enabledHarness.files.get('welcome.md')).toBe('hi'));
  });

  it('calls loader.revokeAll() and revokes live blob URLs on onunload()', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const revokeSpy = vi.spyOn(OnDemandImageLoader.prototype, 'revokeAll');
    let seq = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:plugin-${++seq}`);
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const server = new FakeGitLabServer({ expectedToken: 'glpat-test' });
    const mainHeadSha = server.seedBranch('main', { 'attachments/pic.png': new Uint8Array([1, 2, 3]) });
    requestUrlBox.fn = server.requestFn;

    const harness = createVaultAppHarness();
    const plugin = new GitLabOnDemandSyncPlugin(harness.app, TEST_MANIFEST);
    let postProcessor: MarkdownPostProcessor | null = null;
    vi.spyOn(plugin, 'registerMarkdownPostProcessor').mockImplementation((cb) => {
      postProcessor = cb;
      return cb;
    });
    vi.spyOn(plugin, 'loadData').mockResolvedValueOnce({
      settings: {
        gitlabUrl: 'https://gitlab.example.com',
        projectId: 'user/vault',
        token: 'glpat-test',
        enableOnDesktop: true,
      },
      syncState: {
        lastSyncedCommitSha: mainHeadSha,
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: ['attachments/pic.png'],
      },
    });
    await plugin.onload();
    expect(postProcessor).not.toBeNull();

    const container = document.createElement('div');
    container.innerHTML = `<span class="internal-embed is-unresolved" src="pic.png"></span>`;
    await postProcessor!(container, {
      docId: 'd1',
      sourcePath: 'note.md',
      frontmatter: null,
      addChild: vi.fn(),
      getSectionInfo: vi.fn(() => null),
    });

    const img = container.querySelector('img')!;
    await vi.waitFor(() => expect(img.src).toBe('blob:plugin-1'));

    plugin.onunload();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:plugin-1');
  });

  it('migrates legacy gitlabUrl settings, clamps maxImageCacheMb, and delegates clearImageCache()', async () => {
    const clearSpy = vi.spyOn(OnDemandImageLoader.prototype, 'clearCache').mockResolvedValue(undefined);
    const harness = createVaultAppHarness();
    const plugin = new GitLabOnDemandSyncPlugin(harness.app, TEST_MANIFEST);
    vi.spyOn(plugin, 'loadData').mockResolvedValueOnce({
      settings: {
        gitlabUrl: 'https://gitlab.example.com',
        projectId: 'team/notes',
        token: 'glpat-legacy',
        maxImageCacheMb: 0,
      },
    });

    await plugin.onload();
    expect(plugin.settings.provider).toBe('gitlab');
    expect(plugin.settings.apiUrl).toBe('https://gitlab.example.com');
    expect(plugin.settings.gitlabUrl).toBeUndefined();
    expect(plugin.settings.maxImageCacheMb).toBe(1);

    await plugin.clearImageCache();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('instantiates GitHubClient (/repos/...) vs GitLabClient (/api/v4/projects/...) based on provider', async () => {
    const requestedUrls: string[] = [];
    requestUrlBox.fn = async (req: { url: string }) => {
      requestedUrls.push(req.url);
      return {
        status: 404,
        text: 'Not found',
        arrayBuffer: new ArrayBuffer(0),
        json: { message: 'Not Found' },
        headers: {},
      };
    };

    const harness = createVaultAppHarness();
    const plugin = new GitLabOnDemandSyncPlugin(harness.app, TEST_MANIFEST);
    vi.spyOn(plugin, 'loadData').mockResolvedValueOnce({
      settings: {
        provider: 'github',
        apiUrl: 'https://api.github.com',
        projectId: 'octocat/vault',
        token: 'ghp-test',
        enableOnDesktop: true,
      },
    });
    await plugin.onload();
    await plugin.syncWithNotice();
    expect(requestedUrls[0]).toContain('https://api.github.com/repos/octocat/vault/');

    requestedUrls.length = 0;
    plugin.settings.provider = 'gitlab';
    plugin.settings.apiUrl = 'https://gitlab.example.com';
    await plugin.saveAndRefreshSettings();
    await plugin.syncWithNotice();
    expect(requestedUrls[0]).toContain('https://gitlab.example.com/api/v4/projects/octocat%2Fvault/');
  });
});
