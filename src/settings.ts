import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type GitLabOnDemandSyncPlugin from './main';
import { DEFAULT_SETTINGS, type GitProvider } from './types';

const DEFAULT_API_URLS: Record<GitProvider, string> = {
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com',
};

/**
 * Settings tab for configuring Git provider connection, text-only sync rules,
 * image caching, mobile image upload behavior, and conflict state recovery.
 */
export class GitLabSyncSettingTab extends PluginSettingTab {
  private readonly plugin: GitLabOnDemandSyncPlugin;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, plugin: GitLabOnDemandSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private scheduleTextSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveAndRefreshSettings();
    }, 300);
  }

  override hide(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.plugin.saveAndRefreshSettings();
    }
    super.hide();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const statusSetting = new Setting(containerEl)
      .setName('Last Sync Status')
      .setDesc(
        this.plugin.lastSyncError
          ? `Error: ${this.plugin.lastSyncError}`
          : this.plugin.lastSyncStatus,
      )
      .addButton((button) =>
        button.setButtonText('Sync Now').onClick(async () => {
          await this.plugin.syncWithNotice();
          this.display();
        }),
      );
    if (this.plugin.lastSyncError) {
      statusSetting.descEl?.classList?.add('gitlab-sync-status-error');
    }

    const isGitHub = this.plugin.settings.provider === 'github';
    const defaultApiUrl = DEFAULT_API_URLS[this.plugin.settings.provider];

    new Setting(containerEl)
      .setName('Git Provider')
      .setDesc('Select the remote Git hosting provider for your vault repository.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            github: 'GitHub',
            gitlab: 'GitLab',
          })
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            const nextProvider: GitProvider = value === 'gitlab' ? 'gitlab' : 'github';
            const prevDefaultUrl = DEFAULT_API_URLS[this.plugin.settings.provider];
            const nextDefaultUrl = DEFAULT_API_URLS[nextProvider];
            this.plugin.settings.provider = nextProvider;
            const currentUrl = this.plugin.settings.apiUrl.trim();
            if (!currentUrl || currentUrl === prevDefaultUrl) {
              this.plugin.settings.apiUrl = nextDefaultUrl;
            }
            await this.plugin.saveAndRefreshSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc(
        isGitHub
          ? 'GitHub REST API base URL (e.g. https://api.github.com or your GitHub Enterprise /api/v3 URL).'
          : 'Base URL of your GitLab instance (e.g. https://gitlab.com).',
      )
      .addText((text) =>
        text
          .setPlaceholder(defaultApiUrl)
          .setValue(this.plugin.settings.apiUrl)
          .onChange((value) => {
            this.plugin.settings.apiUrl = value.trim() || defaultApiUrl;
            this.scheduleTextSave();
          }),
      );

    new Setting(containerEl)
      .setName(isGitHub ? 'Repository (owner/repo)' : 'Project ID / Path')
      .setDesc(
        isGitHub
          ? 'GitHub repository in owner/repo format (e.g. username/my-vault).'
          : 'Numeric project ID or URL-path (e.g. username/my-vault).',
      )
      .addText((text) =>
        text
          .setPlaceholder('username/my-vault')
          .setValue(this.plugin.settings.projectId)
          .onChange((value) => {
            this.plugin.settings.projectId = value.trim();
            this.scheduleTextSave();
          }),
      );

    new Setting(containerEl)
      .setName('Branch')
      .setDesc('Target Git branch to sync with.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.branch)
          .setValue(this.plugin.settings.branch)
          .onChange((value) => {
            this.plugin.settings.branch = value.trim() || DEFAULT_SETTINGS.branch;
            this.scheduleTextSave();
          }),
      );

    new Setting(containerEl)
      .setName('Personal Access Token')
      .setDesc(
        isGitHub
          ? 'GitHub token (Fine-grained PAT with Contents: Read & Write, or Classic PAT with repo scope).'
          : 'GitLab token with api or read_repository + write_repository scope.',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder(isGitHub ? 'github_pat_... or ghp_...' : 'glpat-...')
          .setValue(this.plugin.settings.token)
          .onChange((value) => {
            this.plugin.settings.token = value.trim();
            this.scheduleTextSave();
          });
      });

    new Setting(containerEl)
      .setName('Text Allowlist')
      .setDesc('Comma-separated file extensions to sync locally (e.g. .md, .canvas, .txt).')
      .addText((text) =>
        text
          .setPlaceholder('.md, .canvas, .txt')
          .setValue(this.plugin.settings.textAllowlist.join(', '))
          .onChange((value) => {
            const parsed = value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
            this.plugin.settings.textAllowlist =
              parsed.length > 0 ? parsed : [...DEFAULT_SETTINGS.textAllowlist];
            this.scheduleTextSave();
          }),
      );

    new Setting(containerEl)
      .setName('Sync .obsidian/ directory')
      .setDesc('Include allowlisted text files inside .obsidian/ during sync.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncObsidianDir).onChange(async (value) => {
          this.plugin.settings.syncObsidianDir = value;
          await this.plugin.saveAndRefreshSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Attachment Folder')
      .setDesc('Repository folder where pasted or dropped images are uploaded (leave empty for vault root).')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.attachmentFolder)
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange((value) => {
            this.plugin.settings.attachmentFolder = value.trim();
            this.scheduleTextSave();
          }),
      );

    new Setting(containerEl)
      .setName('Auto-sync on Open')
      .setDesc('Automatically run a sync when Obsidian finishes loading.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSyncOnOpen).onChange(async (value) => {
          this.plugin.settings.autoSyncOnOpen = value;
          await this.plugin.saveAndRefreshSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Enable on Desktop (Testing)')
      .setDesc('Enable mobile-only sync and on-demand image loading on desktop for testing.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableOnDesktop).onChange(async (value) => {
          this.plugin.settings.enableOnDesktop = value;
          await this.plugin.saveAndRefreshSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Persistent Image Cache')
      .setDesc('Cache fetched images in WebView storage across restarts (LRU-evicted up to Max Image Cache).')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enablePersistentImageCache)
          .onChange(async (value) => {
            this.plugin.settings.enablePersistentImageCache = value;
            await this.plugin.saveAndRefreshSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Max Image Cache (MB)')
      .setDesc('Maximum persistent image cache size in megabytes (minimum 1 MB).')
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxImageCacheMb))
          .setValue(String(this.plugin.settings.maxImageCacheMb))
          .onChange((value) => {
            const parsed = Number(value.trim());
            this.plugin.settings.maxImageCacheMb =
              value.trim() !== '' && Number.isFinite(parsed)
                ? Math.max(1, Math.floor(parsed))
                : DEFAULT_SETTINGS.maxImageCacheMb;
            this.scheduleTextSave();
          }),
      );

    new Setting(containerEl)
      .setName('Clear Image Cache')
      .setDesc('Remove all persistently cached remote images from local WebView storage.')
      .addButton((button) =>
        button.setButtonText('Clear Image Cache').onClick(async () => {
          await this.plugin.clearImageCache();
          new Notice('Image cache cleared.');
        }),
      );

    const conflictBranch = this.plugin.syncState.activeConflictBranch;
    new Setting(containerEl)
      .setName('Clear Conflict State')
      .setDesc(
        conflictBranch
          ? `Active conflict branch: ${conflictBranch}. Clear this after merging it on desktop.`
          : 'No active conflict branch. Use this after merging a mobile-conflict branch on desktop.',
      )
      .addButton((button) =>
        button
          .setButtonText('Clear Conflict State')
          .setDisabled(!conflictBranch)
          .onClick(async () => {
            try {
              await this.plugin.clearConflictState();
              new Notice('Git conflict state cleared.');
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`Failed to clear conflict state: ${message}`, 8000);
            }
            this.display();
          }),
      );
  }
}
