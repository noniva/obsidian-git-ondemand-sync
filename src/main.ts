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
import { SyncEngine, type SyncProgress, type VaultTextAdapter } from './sync/engine';
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
  lastSyncStatus = 'Not synced yet';
  lastSyncError: string | null = null;

  private client!: GitLabClient;
  private loader!: OnDemandImageLoader;
  private statusBarEl: HTMLElement | null = null;
  private activeProgressUpdate: ((progress: SyncProgress) => void) | null = null;
  private isSyncing = false;

  override async onload(): Promise<void> {
    await this.loadPluginData();

    this.client = this.createClient();
    // Delegate through `this.client` so settings changes take effect without recreating the loader.
    this.loader = new OnDemandImageLoader({
      getRawBinary: (filePath, ref) => this.client.getRawBinary(filePath, ref),
    });

    this.addSettingTab(new GitLabSyncSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem?.() ?? null;
    this.updateStatusBar('GitLab: Idle');

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
      baseUrl: this.settings.gitlabUrl ?? this.settings.apiUrl,
      projectId: this.settings.projectId,
      token: this.settings.token,
      onRateLimitWait: ({ waitMs, attempt, maxAttempts }) => {
        const seconds = Math.max(1, Math.ceil(waitMs / 1000));
        const message = `Rate limited by GitLab, retrying in ${seconds}s (${attempt}/${maxAttempts})...`;
        this.activeProgressUpdate?.({ stage: 'pulling', message });
        this.updateStatusBar(`GitLab: Rate limit (${seconds}s)`);
      },
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

  private updateStatusBar(text: string): void {
    if (this.statusBarEl) {
      this.statusBarEl.textContent = text;
    }
  }

  private formatErrorMessage(error: unknown): string {
    const base = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
    if (cause instanceof Error && cause.message && !base.includes(cause.message)) {
      return `${base} (${cause.message})`;
    }
    return base;
  }

  private createSyncProgressNotice(): {
    notice: Notice;
    update: (progress: SyncProgress) => void;
  } {
    if (typeof document === 'undefined') {
      const notice = new Notice('GitLab Sync: Starting...', 0);
      return {
        notice,
        update: (progress) => {
          notice.setMessage?.(`GitLab Sync: ${progress.message}`);
          this.updateStatusBar(`GitLab: ${progress.message}`);
        },
      };
    }

    const wrap = document.createElement('div');
    wrap.className = 'gitlab-sync-progress-wrap';

    const textEl = document.createElement('div');
    textEl.className = 'gitlab-sync-progress-text';
    textEl.textContent = 'GitLab Sync: Starting...';

    const barEl = document.createElement('progress');
    barEl.className = 'gitlab-sync-progress-bar';

    wrap.append(textEl, barEl);
    const frag = document.createDocumentFragment();
    frag.appendChild(wrap);
    const notice = new Notice(frag, 0);

    return {
      notice,
      update: (progress) => {
        textEl.textContent = `GitLab Sync: ${progress.message}`;
        if (
          typeof progress.current === 'number' &&
          typeof progress.total === 'number' &&
          progress.total > 0
        ) {
          barEl.max = progress.total;
          barEl.value = Math.min(progress.current, progress.total);
        } else {
          barEl.removeAttribute('value');
          barEl.removeAttribute('max');
        }
        this.updateStatusBar(`GitLab: ${progress.message}`);
      },
    };
  }

  private createSyncEngine(onProgress?: (progress: SyncProgress) => void): SyncEngine {
    return new SyncEngine({
      settings: this.settings,
      state: this.syncState,
      client: this.client,
      vault: this.createVaultAdapter(),
      saveState: () => this.savePluginData(),
      configDir: this.getConfigDir(),
      onProgress,
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
    this.updateStatusBar('GitLab: Syncing...');
    const progressUi = this.createSyncProgressNotice();
    this.activeProgressUpdate = (progress) => progressUi.update(progress);

    try {
      const engine = this.createSyncEngine((progress) => progressUi.update(progress));
      const res = await engine.sync();
      progressUi.notice.hide?.();

      this.refreshOpenEditors();
      this.lastSyncError = null;

      if (res.conflictBranch) {
        this.lastSyncStatus = `Conflict pushed to ${res.conflictBranch}`;
        this.updateStatusBar('GitLab: Conflict');
        new Notice(
          `GitLab sync conflict! Local changes were pushed to branch "${res.conflictBranch}". On desktop, run: git fetch && git merge origin/${res.conflictBranch}`,
          15000,
        );
      } else {
        const summary = `${res.pulled} pulled, ${res.pushed} pushed, ${res.deletedLocal} deleted (${this.syncState.remoteImagePaths.length} remote images indexed)`;
        this.lastSyncStatus = summary;
        this.updateStatusBar('GitLab: Synced');
        new Notice(`GitLab sync complete: ${summary}.`);
      }
    } catch (error) {
      progressUi.notice.hide?.();
      console.error('[GitLab On-Demand Sync] Sync failed:', error);
      const message = this.formatErrorMessage(error);
      this.lastSyncError = message;
      this.lastSyncStatus = `Failed: ${message}`;
      this.updateStatusBar('GitLab: Sync failed');
      new Notice(`GitLab sync failed: ${message} (click to dismiss)`, 0);
    } finally {
      this.activeProgressUpdate = null;
      this.isSyncing = false;
    }
  }
}
