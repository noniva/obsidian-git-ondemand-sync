import { Notice, Platform, Plugin } from 'obsidian';
import { GitLabClient } from './gitlab/client';
import { createLivePreviewImageExtension } from './images/live-preview';
import { OnDemandImageLoader } from './images/loader';
import { registerMobileImageUpload } from './images/paste-upload';
import { type ImageRenderContext, registerReadingViewImageProcessor } from './images/reading-view';
import { GitLabSyncSettingTab } from './settings';
import { SyncEngine, type VaultTextAdapter } from './sync/engine';
import { DEFAULT_SETTINGS, type PluginSettings, type SyncState } from './types';
import { isIgnoredPath, isTextSyncPath, normalizeVaultPath } from './utils/paths';

interface PersistedPluginData {
  settings?: Partial<PluginSettings>;
  syncState?: Partial<SyncState>;
}

const DEFAULT_SYNC_STATE: SyncState = {
  lastSyncedCommitSha: null,
  activeConflictBranch: null,
  files: {},
  remoteImagePaths: [],
};

function createDefaultSyncState(): SyncState {
  return {
    lastSyncedCommitSha: null,
    activeConflictBranch: null,
    files: {},
    remoteImagePaths: [],
  };
}

/**
 * Obsidian plugin that syncs text-only vault files with a private GitLab repository
 * and loads/uploads images on demand in memory with zero mobile disk writes.
 */
export default class GitLabOnDemandSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  syncState: SyncState = createDefaultSyncState();

  private client!: GitLabClient;
  private loader!: OnDemandImageLoader;
  private isSyncing = false;

  override async onload(): Promise<void> {
    await this.loadPluginData();

    this.client = this.createClient();
    // Delegate through `this.client` so settings changes take effect without recreating the loader.
    this.loader = new OnDemandImageLoader({
      getRawBinary: (filePath, ref) => this.client.getRawBinary(filePath, ref),
    });

    this.addSettingTab(new GitLabSyncSettingTab(this.app, this));

    this.addRibbonIcon('refresh-cw', 'Sync with GitLab', () => {
      void this.syncWithNotice();
    });

    this.addCommand({
      id: 'sync-with-gitlab',
      name: 'Sync with GitLab',
      callback: () => {
        void this.syncWithNotice();
      },
    });

    registerReadingViewImageProcessor(this, () => this.getImageRenderContext());
    this.registerEditorExtension(
      createLivePreviewImageExtension(() => this.getImageRenderContext()),
    );

    registerMobileImageUpload(this, () => ({
      settings: this.settings,
      state: this.syncState,
      client: this.client,
      loader: this.loader,
      saveState: () => this.savePluginData(),
      isEnabled: () => this.isEnabled(),
    }));

    this.app.workspace.onLayoutReady(() => {
      if (
        this.isEnabled() &&
        this.settings.autoSyncOnOpen &&
        this.settings.token.trim() &&
        this.settings.projectId.trim()
      ) {
        void this.syncWithNotice();
      }
    });
  }

  override onunload(): void {
    this.loader?.revokeAll();
  }

  isEnabled(): boolean {
    return Platform.isMobile || this.settings.enableOnDesktop;
  }

  async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      syncState: this.syncState,
    });
  }

  async saveAndRefreshSettings(): Promise<void> {
    this.client = this.createClient();
    await this.savePluginData();
  }

  private createClient(): GitLabClient {
    return new GitLabClient({
      baseUrl: this.settings.gitlabUrl,
      projectId: this.settings.projectId,
      token: this.settings.token,
    });
  }

  private async loadPluginData(): Promise<void> {
    const raw = (await this.loadData()) as PersistedPluginData | null | undefined;
    const rawSettings = raw && typeof raw === 'object' ? raw.settings : undefined;
    const rawSyncState = raw && typeof raw === 'object' ? raw.syncState : undefined;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(rawSettings ?? {}),
      textAllowlist: Array.isArray(rawSettings?.textAllowlist)
        ? [...rawSettings.textAllowlist]
        : [...DEFAULT_SETTINGS.textAllowlist],
    };

    this.syncState = {
      ...DEFAULT_SYNC_STATE,
      ...(rawSyncState ?? {}),
      files:
        rawSyncState?.files && typeof rawSyncState.files === 'object'
          ? { ...rawSyncState.files }
          : {},
      remoteImagePaths: Array.isArray(rawSyncState?.remoteImagePaths)
        ? [...rawSyncState.remoteImagePaths]
        : [],
    };
  }

  private getImageRenderContext(): ImageRenderContext {
    return {
      settings: this.settings,
      state: this.syncState,
      loader: this.loader,
      isLocalFilePresent: (path: string) =>
        this.app.vault.getAbstractFileByPath(normalizeVaultPath(path)) !== null,
      isEnabled: () => this.isEnabled(),
    };
  }

  private async collectObsidianTextFiles(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    const configDir = this.app.vault.configDir || '.obsidian';
    if (!(await adapter.exists(configDir))) {
      return [];
    }

    const collected: string[] = [];
    const stack: string[] = [configDir];

    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) {
        continue;
      }
      const listed = await adapter.list(dir);
      for (const filePath of listed.files) {
        collected.push(normalizeVaultPath(filePath));
      }
      for (const folderPath of listed.folders) {
        stack.push(normalizeVaultPath(folderPath));
      }
    }

    return collected;
  }

  private async ensureParentDirs(filePath: string): Promise<void> {
    const normalized = normalizeVaultPath(filePath);
    const parts = normalized.split('/');
    if (parts.length <= 1) {
      return;
    }

    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  private createVaultAdapter(): VaultTextAdapter {
    return {
      listTextFiles: async () => {
        const paths = new Set<string>();
        for (const file of this.app.vault.getFiles()) {
          paths.add(normalizeVaultPath(file.path));
        }

        if (this.settings.syncObsidianDir) {
          for (const filePath of await this.collectObsidianTextFiles()) {
            paths.add(filePath);
          }
        }

        const result: string[] = [];
        for (const filePath of paths) {
          if (
            !isIgnoredPath(filePath, this.settings.syncObsidianDir) &&
            isTextSyncPath(filePath, this.settings.textAllowlist)
          ) {
            result.push(filePath);
          }
        }
        return result.sort();
      },
      readText: (path: string) => this.app.vault.adapter.read(normalizeVaultPath(path)),
      writeText: async (path: string, content: string) => {
        const normalized = normalizeVaultPath(path);
        await this.ensureParentDirs(normalized);
        await this.app.vault.adapter.write(normalized, content);
      },
      deleteFile: async (path: string) => {
        const normalized = normalizeVaultPath(path);
        if (await this.app.vault.adapter.exists(normalized)) {
          await this.app.vault.adapter.remove(normalized);
        }
      },
    };
  }

  async syncWithNotice(): Promise<void> {
    if (!this.isEnabled()) {
      new Notice(
        'GitLab On-Demand Sync is disabled on desktop. Enable "Enable on Desktop (Testing)" in settings.',
      );
      return;
    }

    if (!this.settings.projectId.trim() || !this.settings.token.trim()) {
      new Notice('Please configure GitLab Project ID and Personal Access Token in settings.');
      return;
    }

    if (this.isSyncing) {
      new Notice('GitLab sync is already in progress.');
      return;
    }

    this.isSyncing = true;
    try {
      const engine = new SyncEngine({
        settings: this.settings,
        state: this.syncState,
        client: this.client,
        vault: this.createVaultAdapter(),
        saveState: () => this.savePluginData(),
      });

      const res = await engine.sync();
      if (res.conflictBranch) {
        new Notice(
          `GitLab sync conflict! Local changes were pushed to branch "${res.conflictBranch}". On desktop, run: git fetch && git merge origin/${res.conflictBranch}`,
          15000,
        );
      } else {
        new Notice(
          `GitLab sync complete: ${res.pulled} pulled, ${res.pushed} pushed, ${res.deletedLocal} deleted.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`GitLab sync failed: ${message}`, 8000);
    } finally {
      this.isSyncing = false;
    }
  }
}
