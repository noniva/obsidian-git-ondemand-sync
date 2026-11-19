// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { noticeMessages } = vi.hoisted(() => ({
  noticeMessages: [] as string[],
}));

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  class SpyNotice extends actual.Notice {
    constructor(message: string, timeout?: number) {
      super(message, timeout);
      noticeMessages.push(message);
    }
  }
  return {
    ...actual,
    Notice: SpyNotice,
  };
});

import type { App } from 'obsidian';
import { GitLabSyncSettingTab } from '../src/settings';
import type GitLabOnDemandSyncPlugin from '../src/main';
import { DEFAULT_SETTINGS, type PluginSettings, type SyncState } from '../src/types';

function createMockPlugin(
  settingsOverrides: Partial<PluginSettings> = {},
  syncStateOverrides: Partial<SyncState> = {},
) {
  const plugin = {
    settings: {
      ...DEFAULT_SETTINGS,
      textAllowlist: [...DEFAULT_SETTINGS.textAllowlist],
      ...settingsOverrides,
    },
    syncState: {
      lastSyncedCommitSha: null,
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
      ...syncStateOverrides,
    },
    lastSyncStatus: 'Not synced yet',
    lastSyncError: null as string | null,
    saveAndRefreshSettings: vi.fn().mockResolvedValue(undefined),
    clearConflictState: vi.fn().mockResolvedValue(undefined),
    syncWithNotice: vi.fn().mockResolvedValue(undefined),
  };
  return plugin as unknown as GitLabOnDemandSyncPlugin & {
    lastSyncStatus: string;
    lastSyncError: string | null;
    saveAndRefreshSettings: ReturnType<typeof vi.fn>;
    clearConflictState: ReturnType<typeof vi.fn>;
    syncWithNotice: ReturnType<typeof vi.fn>;
  };
}

function findSettingRow(container: HTMLElement, name: string): HTMLElement {
  const rows = Array.from(container.querySelectorAll<HTMLElement>('.setting-item'));
  const match = rows.find(
    (row) => row.querySelector('.setting-item-name')?.textContent?.trim() === name,
  );
  if (!match) {
    throw new Error(`Setting row not found: ${name}`);
  }
  return match;
}

function setTextValue(container: HTMLElement, settingName: string, value: string): HTMLInputElement {
  const row = findSettingRow(container, settingName);
  const input = row.querySelector<HTMLInputElement>('input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

function toggleCheckbox(container: HTMLElement, settingName: string): HTMLInputElement {
  const row = findSettingRow(container, settingName);
  const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  return checkbox;
}

describe('GitLabSyncSettingTab', () => {
  beforeEach(() => {
    noticeMessages.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders fields, hides token as password, and allows empty attachmentFolder', () => {
    const plugin = createMockPlugin({ attachmentFolder: 'attachments', token: 'glpat-secret' });
    const tab = new GitLabSyncSettingTab({} as App, plugin);
    tab.display();

    const tokenInput = findSettingRow(tab.containerEl, 'Personal Access Token').querySelector(
      'input',
    )!;
    expect(tokenInput.type).toBe('password');
    expect(tokenInput.value).toBe('glpat-secret');

    setTextValue(tab.containerEl, 'Attachment Folder', '   ');
    expect(plugin.settings.attachmentFolder).toBe('');

    setTextValue(tab.containerEl, 'GitLab Base URL', '   ');
    expect(plugin.settings.gitlabUrl).toBe(DEFAULT_SETTINGS.gitlabUrl);

    setTextValue(tab.containerEl, 'Branch', '');
    expect(plugin.settings.branch).toBe(DEFAULT_SETTINGS.branch);

    setTextValue(tab.containerEl, 'Text Allowlist', ' , ');
    expect(plugin.settings.textAllowlist).toEqual(DEFAULT_SETTINGS.textAllowlist);
  });

  it('debounces text edits by 300ms and flushes immediately on hide()', async () => {
    vi.useFakeTimers();
    const plugin = createMockPlugin();
    const tab = new GitLabSyncSettingTab({} as App, plugin);
    tab.display();

    setTextValue(tab.containerEl, 'Project ID / Path', 'group/a');
    await vi.advanceTimersByTimeAsync(200);
    expect(plugin.saveAndRefreshSettings).not.toHaveBeenCalled();

    setTextValue(tab.containerEl, 'Project ID / Path', 'group/final');
    await vi.advanceTimersByTimeAsync(299);
    expect(plugin.saveAndRefreshSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(plugin.saveAndRefreshSettings).toHaveBeenCalledTimes(1);
    expect(plugin.settings.projectId).toBe('group/final');

    // Pending edit flushed immediately on hide() without duplicate save later
    setTextValue(tab.containerEl, 'Branch', 'develop');
    tab.hide();
    expect(plugin.saveAndRefreshSettings).toHaveBeenCalledTimes(2);
    expect(plugin.settings.branch).toBe('develop');

    await vi.advanceTimersByTimeAsync(500);
    expect(plugin.saveAndRefreshSettings).toHaveBeenCalledTimes(2);

    // Calling hide() with no pending timer does not trigger extra save
    tab.hide();
    expect(plugin.saveAndRefreshSettings).toHaveBeenCalledTimes(2);
  });

  it('saves immediately when toggles change', async () => {
    const plugin = createMockPlugin();
    const tab = new GitLabSyncSettingTab({} as App, plugin);
    tab.display();

    toggleCheckbox(tab.containerEl, 'Sync .obsidian/ directory');
    toggleCheckbox(tab.containerEl, 'Auto-sync on Open');
    toggleCheckbox(tab.containerEl, 'Enable on Desktop (Testing)');

    await vi.waitFor(() => expect(plugin.saveAndRefreshSettings).toHaveBeenCalledTimes(3));
    expect(plugin.settings.syncObsidianDir).toBe(true);
    expect(plugin.settings.autoSyncOnOpen).toBe(true);
    expect(plugin.settings.enableOnDesktop).toBe(true);
  });

  it('manages Clear Conflict State button disabled/enabled states and keeps button enabled on error', async () => {
    const plugin = createMockPlugin({}, { activeConflictBranch: null });
    const tab = new GitLabSyncSettingTab({} as App, plugin);
    tab.display();

    const getClearBtn = () =>
      findSettingRow(tab.containerEl, 'Clear Conflict State').querySelector('button')!;

    expect(getClearBtn().disabled).toBe(true);
    expect(
      findSettingRow(tab.containerEl, 'Clear Conflict State').querySelector(
        '.setting-item-description',
      )?.textContent,
    ).toContain('No active conflict branch');

    // Error path: clearConflictState rejects -> Notice shown, branch not cleared, button stays enabled
    plugin.syncState.activeConflictBranch = 'mobile-conflict/20261119-060000';
    plugin.clearConflictState.mockRejectedValueOnce(new Error('API unreachable'));
    tab.display();

    expect(getClearBtn().disabled).toBe(false);
    expect(
      findSettingRow(tab.containerEl, 'Clear Conflict State').querySelector(
        '.setting-item-description',
      )?.textContent,
    ).toContain('mobile-conflict/20261119-060000');

    getClearBtn().click();
    await vi.waitFor(() => expect(noticeMessages).toHaveLength(1));
    expect(noticeMessages[0]).toContain('Failed to clear conflict state: API unreachable');
    expect(plugin.syncState.activeConflictBranch).toBe('mobile-conflict/20261119-060000');
    expect(getClearBtn().disabled).toBe(false);

    // Success path: clearConflictState clears branch -> Notice shown, re-rendered button becomes disabled
    plugin.clearConflictState.mockImplementationOnce(async () => {
      plugin.syncState.activeConflictBranch = null;
    });
    getClearBtn().click();
    await vi.waitFor(() => expect(noticeMessages).toHaveLength(2));
    expect(noticeMessages[1]).toBe('GitLab conflict state cleared.');
    expect(getClearBtn().disabled).toBe(true);
  });

  it('displays Last Sync Status, marks error state, and triggers Sync Now button', async () => {
    const plugin = createMockPlugin();
    plugin.lastSyncError = 'GitLab API GET failed (401): Unauthorized';
    plugin.lastSyncStatus = `Failed: ${plugin.lastSyncError}`;

    const tab = new GitLabSyncSettingTab({} as App, plugin);
    tab.display();

    const statusRow = findSettingRow(tab.containerEl, 'Last Sync Status');
    const descEl = statusRow.querySelector('.setting-item-description')!;
    expect(descEl.textContent).toContain('401');
    expect(descEl.classList.contains('gitlab-sync-status-error')).toBe(true);

    const syncBtn = statusRow.querySelector('button')!;
    expect(syncBtn.textContent).toBe('Sync Now');
    plugin.syncWithNotice.mockImplementationOnce(async () => {
      plugin.lastSyncError = null;
      plugin.lastSyncStatus = '1 pulled, 0 pushed, 0 deleted (2 remote images indexed)';
    });
    syncBtn.click();

    await vi.waitFor(() => expect(plugin.syncWithNotice).toHaveBeenCalledTimes(1));
    const refreshedDesc = findSettingRow(tab.containerEl, 'Last Sync Status').querySelector(
      '.setting-item-description',
    )!;
    expect(refreshedDesc.textContent).toContain('1 pulled');
    expect(refreshedDesc.classList.contains('gitlab-sync-status-error')).toBe(false);
  });
});
