// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import {
  extractImageTargetsFromText,
  findUnusedRemoteImages,
  planUnusedImageCleanup,
  executeUnusedImageCleanup,
  UnusedImagesModal,
} from '../src/images/cleanup';
import { DEFAULT_SETTINGS, type PluginSettings, type SyncState } from '../src/types';

function makeSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    projectId: '12345',
    token: 'glpat-test-token',
    branch: 'main',
    ...overrides,
  };
}

function makeState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    lastSyncedCommitSha: 'sha-head-1',
    activeConflictBranch: null,
    files: {},
    remoteImagePaths: ['attachments/used.png', 'attachments/unused.png'],
    ...overrides,
  };
}

describe('extractImageTargetsFromText', () => {
  it('extracts wikilinks, markdown links with balanced parens/angle brackets, HTML img, canvas JSON, and YAML frontmatter while filtering external URIs', () => {
    const content = [
      '---',
      'banner: covers/hero.jpg',
      'cover: "covers/sub.webp"',
      'image: https://example.com/external.png',
      '---',
      '![[attachments/photo.png|300]]',
      '[[attachments/linked.svg#section]]',
      '![alt](attachments/pic%20(1).png "title")',
      '[doc](<attachments/spaced name.jpg>)',
      '<img src="attachments/html-img.gif" alt="gif" />',
      '![remote](https://cdn.example.com/a.png)',
      '![inline](data:image/png;base64,AAAA)',
      '{"id":"1","type":"file","file":"attachments/canvas-diagram.avif"}',
    ].join('\n');

    const targets = extractImageTargetsFromText(content);

    expect(targets).toEqual(
      expect.arrayContaining([
        'covers/hero.jpg',
        'covers/sub.webp',
        'attachments/photo.png',
        'attachments/linked.svg',
        'attachments/pic%20(1).png',
        'attachments/spaced name.jpg',
        'attachments/html-img.gif',
        'attachments/canvas-diagram.avif',
      ]),
    );
    expect(targets).not.toContain('https://example.com/external.png');
    expect(targets).not.toContain('https://cdn.example.com/a.png');
    expect(targets).not.toContain('data:image/png;base64,AAAA');
  });

  it('deduplicates repeated targets', () => {
    const content = '![[a.png]]\n![[a.png|200]]\n![alt](a.png)';
    expect(extractImageTargetsFromText(content)).toEqual(['a.png']);
  });

  it('extracts quoted paths with spaces from canvas JSON and YAML frontmatter', () => {
    const content = [
      '---',
      "cover: 'Asset/my img.png'",
      '---',
      '{"id":"1","type":"file","file":"Asset/Pasted image 2026.png"}',
    ].join('\n');

    const targets = extractImageTargetsFromText(content);
    expect(targets).toEqual(
      expect.arrayContaining(['Asset/my img.png', 'Asset/Pasted image 2026.png']),
    );
  });
});

describe('findUnusedRemoteImages', () => {
  it('resolves references across notes and canvas files (including URL-encoded paths) and returns sorted unused paths', async () => {
    const files: Record<string, string> = {
      'notes/index.md': [
        '![[used-wiki.png|400]]',
        '![md](attachments/used%20encoded.jpg)',
        '<img src="../covers/html-used.webp" />',
      ].join('\n'),
      'notes/board.canvas': '{"nodes":[{"type":"file","file":"attachments/canvas-used.png"}]}',
      'notes/front.md': '---\nbanner: covers/frontmatter-used.png\n---\n',
    };

    const vault = {
      listTextFiles: vi.fn().mockResolvedValue(Object.keys(files)),
      readText: vi.fn(async (path: string) => files[path] ?? ''),
    };

    const remoteImagePaths = [
      'attachments/zeta-unused.png',
      'attachments/used-wiki.png',
      'attachments/used encoded.jpg',
      'covers/html-used.webp',
      'attachments/canvas-used.png',
      'covers/frontmatter-used.png',
      'attachments/alpha-unused.jpg',
    ];

    const unused = await findUnusedRemoteImages(vault, remoteImagePaths);
    expect(unused).toEqual([
      'attachments/alpha-unused.jpg',
      'attachments/zeta-unused.png',
    ]);
  });
});

describe('planUnusedImageCleanup', () => {
  it('throws when projectId or token is missing', async () => {
    const client = {
      getBranchHead: vi.fn(),
      getTreeRecursive: vi.fn(),
    };
    const vault = {
      listTextFiles: vi.fn(),
      readText: vi.fn(),
    };

    await expect(
      planUnusedImageCleanup({
        settings: makeSettings({ projectId: '  ' }),
        state: makeState(),
        client,
        vault,
      }),
    ).rejects.toThrow();

    await expect(
      planUnusedImageCleanup({
        settings: makeSettings({ token: '' }),
        state: makeState(),
        client,
        vault,
      }),
    ).rejects.toThrow();
  });

  it('throws when vault has never been synced', async () => {
    await expect(
      planUnusedImageCleanup({
        settings: makeSettings(),
        state: makeState({ lastSyncedCommitSha: null }),
        client: { getBranchHead: vi.fn(), getTreeRecursive: vi.fn() },
        vault: { listTextFiles: vi.fn(), readText: vi.fn() },
      }),
    ).rejects.toThrow('Please run Sync before cleaning up unused images.');
  });

  it('throws when an active conflict branch exists', async () => {
    await expect(
      planUnusedImageCleanup({
        settings: makeSettings(),
        state: makeState({ activeConflictBranch: 'conflict-123' }),
        client: { getBranchHead: vi.fn(), getTreeRecursive: vi.fn() },
        vault: { listTextFiles: vi.fn(), readText: vi.fn() },
      }),
    ).rejects.toThrow('Resolve and clear the active conflict branch before cleaning up unused images.');
  });

  it('throws when remote HEAD does not match lastSyncedCommitSha', async () => {
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('sha-head-2'),
      getTreeRecursive: vi.fn(),
    };

    await expect(
      planUnusedImageCleanup({
        settings: makeSettings({ branch: 'main' }),
        state: makeState({ lastSyncedCommitSha: 'sha-head-1' }),
        client,
        vault: { listTextFiles: vi.fn(), readText: vi.fn() },
      }),
    ).rejects.toThrow('Remote branch "main" has new commits. Please run Sync first before cleaning up unused images.');
  });

  it('scans live remote tree (excluding ignored paths and non-blobs) and returns unused paths', async () => {
    const client = {
      getBranchHead: vi.fn().mockResolvedValue('sha-head-1'),
      getTreeRecursive: vi.fn().mockResolvedValue([
        { id: '1', name: 'used.png', type: 'blob', path: 'attachments/used.png', mode: '100644' },
        { id: '2', name: 'unused.png', type: 'blob', path: 'attachments/unused.png', mode: '100644' },
        { id: '3', name: 'icon.png', type: 'blob', path: '.obsidian/icon.png', mode: '100644' },
        { id: '4', name: 'note.md', type: 'blob', path: 'note.md', mode: '100644' },
        { id: '5', name: 'sub', type: 'tree', path: 'attachments/sub.png', mode: '040000' },
      ]),
    };
    const vault = {
      listTextFiles: vi.fn().mockResolvedValue(['note.md']),
      readText: vi.fn().mockResolvedValue('![[used.png]]'),
    };

    const result = await planUnusedImageCleanup({
      settings: makeSettings({ syncObsidianDir: false }),
      state: makeState(),
      client,
      vault,
    });

    expect(result).toEqual({
      headSha: 'sha-head-1',
      unusedPaths: ['attachments/unused.png'],
    });
  });
});

describe('executeUnusedImageCleanup', () => {
  it('commits delete actions, updates state, and calls saveState and clearCache', async () => {
    const state = makeState({
      lastSyncedCommitSha: 'sha-head-1',
      remoteImagePaths: ['attachments/used.png', 'attachments/unused-1.png', 'attachments/unused-2.png'],
    });
    const client = {
      createCommit: vi.fn().mockResolvedValue('sha-head-2'),
    };
    const saveState = vi.fn().mockResolvedValue(undefined);
    const clearCache = vi.fn().mockResolvedValue(undefined);

    const newSha = await executeUnusedImageCleanup({
      branch: 'main',
      selectedPaths: ['attachments/unused-1.png', 'attachments/unused-2.png'],
      client,
      state,
      saveState,
      clearCache,
    });

    expect(newSha).toBe('sha-head-2');
    expect(client.createCommit).toHaveBeenCalledWith({
      branch: 'main',
      commitMessage: 'Clean up unused images',
      actions: [
        { action: 'delete', file_path: 'attachments/unused-1.png' },
        { action: 'delete', file_path: 'attachments/unused-2.png' },
      ],
    });
    expect(state.lastSyncedCommitSha).toBe('sha-head-2');
    expect(state.remoteImagePaths).toEqual(['attachments/used.png']);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it('guards against empty selection without calling createCommit', async () => {
    const client = { createCommit: vi.fn() };
    const saveState = vi.fn();

    await expect(
      executeUnusedImageCleanup({
        branch: 'main',
        selectedPaths: [],
        client,
        state: makeState(),
        saveState,
      }),
    ).rejects.toThrow();
    expect(client.createCommit).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });
});

describe('UnusedImagesModal', () => {
  it('renders all checkboxes checked by default, supports unchecking, Select All/Deselect All, disables Delete at 0, and confirms selected paths', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const modal = new UnusedImagesModal({} as App, {
      branch: 'main',
      unusedPaths: ['attachments/a.png', 'attachments/b.jpg'],
      onConfirm,
    });

    modal.open();

    const title = modal.contentEl.querySelector('h2, h3');
    expect(title?.textContent).toBe('Clean Up Unused Remote Images');
    expect(modal.contentEl.textContent).toContain(
      'Found 2 image(s) not referenced in any note on branch "main".',
    );

    const listEl = modal.contentEl.querySelector('.gitlab-cleanup-modal-list');
    expect(listEl).not.toBeNull();

    const checkboxes = Array.from(
      modal.contentEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((cb) => cb.checked)).toBe(true);

    const deleteBtn = Array.from(modal.contentEl.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('Delete ('),
    );
    expect(deleteBtn).toBeDefined();
    expect(deleteBtn?.textContent).toBe('Delete (2)');
    expect(deleteBtn?.classList.contains('mod-warning')).toBe(true);
    expect(deleteBtn?.disabled).toBe(false);

    // Uncheck first checkbox
    checkboxes[0].checked = false;
    checkboxes[0].dispatchEvent(new Event('change'));
    expect(deleteBtn?.textContent).toBe('Delete (1)');
    expect(deleteBtn?.disabled).toBe(false);

    // Toggle Deselect All -> 0 selected
    const toggleAllBtn = Array.from(modal.contentEl.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('All'),
    );
    expect(toggleAllBtn).toBeDefined();
    // Since 1 of 2 is checked, clicking Select All selects all, or Deselect All deselects all:
    // Let's click until 0 are checked, or verify toggle behavior:
    toggleAllBtn!.click();
    if (checkboxes.every((cb) => cb.checked)) {
      toggleAllBtn!.click();
    }
    expect(checkboxes.every((cb) => !cb.checked)).toBe(true);
    expect(deleteBtn?.textContent).toBe('Delete (0)');
    expect(deleteBtn?.disabled).toBe(true);

    // Toggle Select All -> all checked, then uncheck first -> confirm only second
    toggleAllBtn!.click();
    expect(checkboxes.every((cb) => cb.checked)).toBe(true);
    expect(deleteBtn?.textContent).toBe('Delete (2)');

    checkboxes[0].checked = false;
    checkboxes[0].dispatchEvent(new Event('change'));

    deleteBtn!.click();
    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(['attachments/b.jpg']);
    });
  });
});
