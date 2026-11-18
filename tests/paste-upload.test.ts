import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import type { Editor, Plugin } from 'obsidian';
import {
  uploadPastedImage,
  registerMobileImageUpload,
  type PasteUploadDeps,
} from '../src/images/paste-upload';
import { DEFAULT_SETTINGS, type SyncState } from '../src/types';

function createMockFile(bytes: number[], mimeType: string, name = 'image.png'): File {
  const buffer = new Uint8Array(bytes).buffer;
  return {
    name,
    type: mimeType,
    size: bytes.length,
    arrayBuffer: vi.fn().mockResolvedValue(buffer),
  } as unknown as File;
}

function createWorkspaceHarness() {
  const listeners = new Map<string, (...args: any[]) => unknown>();
  const registerEvent = vi.fn();
  const plugin = {
    app: {
      workspace: {
        on: vi.fn((name: string, cb: (...args: any[]) => unknown) => {
          listeners.set(name, cb);
          return { name, cb };
        }),
      },
    },
    registerEvent,
  } as unknown as Plugin;

  return { plugin, listeners, registerEvent };
}

describe('uploadPastedImage', () => {
  it('uploads base64 image to GitLab, updates remoteImagePaths, and returns wikilink', async () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const client = { createCommit: vi.fn().mockResolvedValue('c1') } as any;
    const saveState = vi.fn().mockResolvedValue(undefined);
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;

    const res = await uploadPastedImage({
      bytes,
      mimeType: 'image/png',
      attachmentFolder: 'attachments',
      branch: 'main',
      client,
      state,
      saveState,
      now: new Date('2026-11-19T04:10:00Z'),
    });

    expect(res.repoPath).toBe('attachments/Pasted image 20261119041000.png');
    expect(res.wikilink).toBe('![[attachments/Pasted image 20261119041000.png]]');
    expect(client.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'main',
        actions: [
          expect.objectContaining({
            action: 'create',
            encoding: 'base64',
            file_path: res.repoPath,
            content: 'iVBORw==',
          }),
        ],
      }),
    );
    expect(state.remoteImagePaths).toContain(res.repoPath);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(state.lastSyncedCommitSha).toBe('c0');
  });

  it('propagates network error without mutating remoteImagePaths when offline', async () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const client = { createCommit: vi.fn().mockRejectedValue(new Error('Network offline')) } as any;
    const saveState = vi.fn();

    await expect(
      uploadPastedImage({
        bytes: new Uint8Array([1]).buffer,
        mimeType: 'image/png',
        attachmentFolder: 'attachments',
        branch: 'main',
        client,
        state,
        saveState,
      }),
    ).rejects.toThrow(/offline/i);

    expect(state.remoteImagePaths).toEqual([]);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('encodes large buffers in chunks without Node Buffer and avoids timestamp collisions', async () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: ['assets/imgs/Pasted image 20261119041000.jpg'],
    };
    const client = { createCommit: vi.fn().mockResolvedValue('c2') } as any;
    const saveState = vi.fn().mockResolvedValue(undefined);
    const largeBytes = new Uint8Array(70000);
    largeBytes.fill(65);

    const res = await uploadPastedImage({
      bytes: largeBytes.buffer,
      mimeType: 'image/jpeg',
      attachmentFolder: '/assets/imgs/',
      branch: 'main',
      client,
      state,
      saveState,
      now: new Date('2026-11-19T04:10:00Z'),
    });

    expect(res.repoPath).toBe('assets/imgs/Pasted image 20261119041000-1.jpg');
    expect(res.wikilink).toBe('![[assets/imgs/Pasted image 20261119041000-1.jpg]]');
    const actionContent = client.createCommit.mock.calls[0][0].actions[0].content;
    expect(actionContent).toBe('QUFB'.repeat(23333) + 'QQ==');
  });
});

describe('registerMobileImageUpload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    noticeMessages.length = 0;
  });

  it('intercepts editor-paste image, prevents disk write, registers memory blob, and inserts wikilink', async () => {
    const { plugin, listeners, registerEvent } = createWorkspaceHarness();
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261119-040000',
      files: {},
      remoteImagePaths: [],
    };
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, branch: 'main', attachmentFolder: 'attachments' },
      state,
      client: { createCommit: vi.fn().mockResolvedValue('c3') } as any,
      loader: { registerMemoryImage: vi.fn().mockReturnValue('blob:mem-1') } as any,
      saveState: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
    };

    registerMobileImageUpload(plugin, () => deps);

    expect(registerEvent).toHaveBeenCalledTimes(2);
    const pasteHandler = listeners.get('editor-paste');
    expect(pasteHandler).toBeDefined();

    const file = createMockFile([137, 80, 78, 71], 'image/png');
    const preventDefault = vi.fn();
    const evt = {
      defaultPrevented: false,
      preventDefault,
      clipboardData: { files: [file], items: [] },
    } as unknown as ClipboardEvent;
    const editor = { replaceSelection: vi.fn() } as unknown as Editor;

    await pasteHandler!(evt, editor);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.client.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'mobile-conflict/20261119-040000',
      }),
    );
    expect(deps.loader.registerMemoryImage).toHaveBeenCalledWith(
      expect.stringMatching(/^attachments\/Pasted image \d{14}\.png$/),
      expect.any(Blob),
    );
    expect(editor.replaceSelection).toHaveBeenCalledWith(
      expect.stringMatching(/^!\[\[attachments\/Pasted image \d{14}\.png\]\]$/),
    );
  });

  it('intercepts editor-drop image and inserts wikilink', async () => {
    const { plugin, listeners } = createWorkspaceHarness();
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, branch: 'main', attachmentFolder: 'attachments' },
      state,
      client: { createCommit: vi.fn().mockResolvedValue('c4') } as any,
      loader: { registerMemoryImage: vi.fn().mockReturnValue('blob:mem-2') } as any,
      saveState: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
    };

    registerMobileImageUpload(plugin, () => deps);
    const dropHandler = listeners.get('editor-drop');
    expect(dropHandler).toBeDefined();

    const file = createMockFile([1, 2, 3], 'image/webp', 'photo.webp');
    const preventDefault = vi.fn();
    const evt = {
      defaultPrevented: false,
      preventDefault,
      dataTransfer: { files: [file], items: [] },
    } as unknown as DragEvent;
    const editor = { replaceSelection: vi.fn() } as unknown as Editor;

    await dropHandler!(evt, editor);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.loader.registerMemoryImage).toHaveBeenCalledWith(
      expect.stringMatching(/^attachments\/Pasted image \d{14}\.webp$/),
      expect.any(Blob),
    );
    expect(editor.replaceSelection).toHaveBeenCalledWith(
      expect.stringMatching(/^!\[\[attachments\/Pasted image \d{14}\.webp\]\]$/),
    );
  });

  it('does not insert broken wikilink and shows Notice when upload fails offline', async () => {
    const { plugin, listeners } = createWorkspaceHarness();
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS },
      state,
      client: { createCommit: vi.fn().mockRejectedValue(new Error('Network offline')) } as any,
      loader: { registerMemoryImage: vi.fn() } as any,
      saveState: vi.fn(),
      isEnabled: () => true,
    };

    registerMobileImageUpload(plugin, () => deps);
    const pasteHandler = listeners.get('editor-paste')!;

    const file = createMockFile([1, 2], 'image/png');
    const preventDefault = vi.fn();
    const evt = {
      defaultPrevented: false,
      preventDefault,
      clipboardData: { files: [file], items: [] },
    } as unknown as ClipboardEvent;
    const editor = { replaceSelection: vi.fn() } as unknown as Editor;

    await pasteHandler(evt, editor);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.loader.registerMemoryImage).not.toHaveBeenCalled();
    expect(editor.replaceSelection).not.toHaveBeenCalled();
    expect(state.remoteImagePaths).toEqual([]);
    expect(noticeMessages).toHaveLength(1);
    expect(noticeMessages[0]).toMatch(/offline/i);
  });

  it('supports DataTransfer.items fallback and ignores already defaultPrevented events', async () => {
    const { plugin, listeners } = createWorkspaceHarness();
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, attachmentFolder: '' },
      state,
      client: { createCommit: vi.fn().mockResolvedValue('c5') } as any,
      loader: { registerMemoryImage: vi.fn().mockReturnValue('blob:mem-3') } as any,
      saveState: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
    };

    registerMobileImageUpload(plugin, () => deps);
    const pasteHandler = listeners.get('editor-paste')!;
    const editor = { replaceSelection: vi.fn() } as unknown as Editor;

    await pasteHandler(
      {
        defaultPrevented: true,
        preventDefault: vi.fn(),
        clipboardData: { files: [createMockFile([1], 'image/png')], items: [] },
      } as unknown as ClipboardEvent,
      editor,
    );
    expect(deps.client.createCommit).not.toHaveBeenCalled();

    const itemFile = createMockFile([1, 2, 3], 'image/gif');
    const preventDefault = vi.fn();
    await pasteHandler(
      {
        defaultPrevented: false,
        preventDefault,
        clipboardData: {
          files: [],
          items: [{ kind: 'file', type: 'image/gif', getAsFile: () => itemFile }],
        },
      } as unknown as ClipboardEvent,
      editor,
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(editor.replaceSelection).toHaveBeenCalledWith(
      expect.stringMatching(/^!\[\[Pasted image \d{14}\.gif\]\]$/),
    );
  });

  it('ignores paste when disabled or when clipboard contains only text', async () => {
    const { plugin, listeners } = createWorkspaceHarness();
    let enabled = false;
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c0',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: [],
      },
      client: { createCommit: vi.fn() } as any,
      loader: { registerMemoryImage: vi.fn() } as any,
      saveState: vi.fn(),
      isEnabled: () => enabled,
    };

    registerMobileImageUpload(plugin, () => deps);
    const pasteHandler = listeners.get('editor-paste')!;

    const imageFile = createMockFile([1, 2], 'image/png');
    const preventDisabled = vi.fn();
    await pasteHandler(
      {
        defaultPrevented: false,
        preventDefault: preventDisabled,
        clipboardData: { files: [imageFile], items: [] },
      } as unknown as ClipboardEvent,
      { replaceSelection: vi.fn() } as unknown as Editor,
    );
    expect(preventDisabled).not.toHaveBeenCalled();
    expect(deps.client.createCommit).not.toHaveBeenCalled();

    enabled = true;
    const textFile = createMockFile([65, 66], 'text/plain', 'note.txt');
    const preventText = vi.fn();
    await pasteHandler(
      {
        defaultPrevented: false,
        preventDefault: preventText,
        clipboardData: { files: [textFile], items: [] },
      } as unknown as ClipboardEvent,
      { replaceSelection: vi.fn() } as unknown as Editor,
    );
    expect(preventText).not.toHaveBeenCalled();
    expect(deps.client.createCommit).not.toHaveBeenCalled();
  });
});
