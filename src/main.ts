import type { EditorView } from '@codemirror/view';
import { Notice, Platform, Plugin } from 'obsidian';
import { GitLabClient } from './gitlab/client';
import {
  createLivePreviewImageExtension,
  refreshRemoteImagesEffect,
} from './images/live-preview';
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
      configDir: this.getConfigDir(),
      onUploaded: () => this.refreshOpenEditors(),
    }));

    this.app.workspace.onLayoutReady(() => {
      if (!this.isEnabled()) {
        return;
      }
      if (this.syncState.activeConflictBranch) {
        new Notice(
          `GitLab sync has active conflict branch "${this.syncState.activeConflictBranch}" awaiting desktop merge and "Clear Conflict State" in settings.`,
          10000,
        );
      }
      if (
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

  private getConfigDir(): string {
    return normalizeVaultPath(this.app.vault.configDir || '.obsidian') || '.obsidian';
  }

  refreshOpenEditors(): void {
    const leaves = this.app.workspace.getLeavesOfType?.('markdown') ?? [];
    for (const leaf of leaves) {
      const view = leaf.view as {
        editor?: { cm?: EditorView };
        previewMode?: { rerender?: (full?: boolean) => void };
      } | null | undefined;
      if (!view) {
        continue;
      }
      view.editor?.cm?.dispatch?.({
        effects: refreshRemoteImagesEffect.of(undefined),
      });
      view.previewMode?.rerender?.(true);
    }
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

    const syncState: SyncState = {
      ...createDefaultSyncState(),
      ...(rawSyncState ?? {}),
      files:
        rawSyncState?.files && typeof rawSyncState.files === 'object'
          ? { ...rawSyncState.files }
          : {},
      remoteImagePaths: Array.isArray(rawSyncState?.remoteImagePaths)
        ? [...rawSyncState.remoteImagePaths]
        : [],
    };
    if (
      rawSyncState?.conflictPushedHashes &&
      typeof rawSyncState.conflictPushedHashes === 'object' &&
      !Array.isArray(rawSyncState.conflictPushedHashes)
    ) {
      syncState.conflictPushedHashes = { ...rawSyncState.conflictPushedHashes };
    } else {
      delete syncState.conflictPushedHashes;
    }
    if (Array.isArray(rawSyncState?.conflictDeletedPaths)) {
      syncState.conflictDeletedPaths = [...rawSyncState.conflictDeletedPaths];
    } else {
      delete syncState.conflictDeletedPaths;
    }
    this.syncState = syncState;
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
    const configDir = this.getConfigDir();
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
        const configDir = this.getConfigDir();
        for (const filePath of paths) {
          if (
            !isIgnoredPath(filePath, this.settings.syncObsidianDir, configDir) &&
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

  private createSyncEngine(): SyncEngine {
    return new SyncEngine({
      settings: this.settings,
      state: this.syncState,
      client: this.client,
      vault: this.createVaultAdapter(),
      saveState: () => this.savePluginData(),
      configDir: this.getConfigDir(),
    });
  }

  /**
   * Clears the active conflict branch marker and reconciles converged files against the target branch.
   */
  async clearConflictState(): Promise<void> {
    const engine = this.createSyncEngine();
    await engine.clearConflictBranch();
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
      const engine = this.createSyncEngine();

      const res = await engine.sync();
      this.refreshOpenEditors();
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
