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

import { TFile, type Editor, type Plugin } from 'obsidian';
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

function createWorkspaceHarness(activeEditor?: Editor, options?: { deferLayoutReady?: boolean }) {
  const listeners = new Map<string, (...args: any[]) => unknown>();
  const vaultListeners = new Map<string, (...args: any[]) => unknown>();
  const layoutReadyCallbacks: Array<() => void> = [];
  const registerEvent = vi.fn();
  const readBinary = vi.fn();
  const deleteFile = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    app: {
      workspace: {
        on: vi.fn((name: string, cb: (...args: any[]) => unknown) => {
          listeners.set(name, cb);
          return { name, cb };
        }),
        onLayoutReady: vi.fn((cb: () => void) => {
          if (options?.deferLayoutReady) {
            layoutReadyCallbacks.push(cb);
          } else {
            cb();
          }
        }),
        getActiveViewOfType: vi.fn(() => (activeEditor ? { editor: activeEditor } : null)),
      },
      vault: {
        on: vi.fn((name: string, cb: (...args: any[]) => unknown) => {
          vaultListeners.set(name, cb);
          return { name, cb };
        }),
        readBinary,
        delete: deleteFile,
      },
    },
    registerEvent,
  } as unknown as Plugin;

  const triggerLayoutReady = (): void => {
    while (layoutReadyCallbacks.length > 0) {
      layoutReadyCallbacks.shift()!();
    }
  };

  return {
    plugin,
    listeners,
    vaultListeners,
    registerEvent,
    readBinary,
    deleteFile,
    triggerLayoutReady,
  };
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

    expect(registerEvent).toHaveBeenCalledTimes(3);
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

  it('uploads mobile camera/picker image created in vault, deletes temp file, and updates active editor', async () => {
    let editorContent = 'Photo: ![[Pasted image 999.heic]]';
    const editor = {
      getValue: vi.fn(() => editorContent),
      setValue: vi.fn((val: string) => {
        editorContent = val;
      }),
      replaceSelection: vi.fn(),
    } as unknown as Editor;

    const { plugin, vaultListeners, readBinary, deleteFile } = createWorkspaceHarness(editor);
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    readBinary.mockResolvedValue(bytes);

    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, branch: 'main', attachmentFolder: 'attachments' },
      state,
      client: { createCommit: vi.fn().mockResolvedValue('c_cam') } as any,
      loader: { registerMemoryImage: vi.fn().mockReturnValue('blob:cam-1') } as any,
      saveState: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
    };

    registerMobileImageUpload(plugin, () => deps);
    const createHandler = vaultListeners.get('create')!;
    expect(createHandler).toBeDefined();

    const tempFile = new TFile();
    tempFile.path = 'Pasted image 999.heic';
    tempFile.name = 'Pasted image 999.heic';
    tempFile.extension = 'heic';

    await createHandler(tempFile);

    expect(readBinary).toHaveBeenCalledWith(tempFile);
    expect(deps.client.createCommit).toHaveBeenCalledTimes(1);
    expect(deps.loader.registerMemoryImage).toHaveBeenCalledWith(
      expect.stringMatching(/^attachments\/Pasted image \d{14}\.heic$/),
      expect.any(Blob),
    );
    expect(deleteFile).toHaveBeenCalledWith(tempFile);
    expect(editor.setValue).toHaveBeenCalledWith(
      expect.stringMatching(/^Photo: !\[\[attachments\/Pasted image \d{14}\.heic\]\]$/),
    );
  });

  it('shows Notice and preserves temp file if vault create upload fails', async () => {
    const { plugin, vaultListeners, readBinary, deleteFile } = createWorkspaceHarness();
    readBinary.mockResolvedValue(new Uint8Array([1, 2]).buffer);

    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c0',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: [],
      },
      client: { createCommit: vi.fn().mockRejectedValue(new Error('Upload timeout')) } as any,
      loader: { registerMemoryImage: vi.fn() } as any,
      saveState: vi.fn(),
      isEnabled: () => true,
    };

    registerMobileImageUpload(plugin, () => deps);
    const createHandler = vaultListeners.get('create')!;

    const tempFile = new TFile();
    tempFile.path = 'camera.jpg';
    tempFile.name = 'camera.jpg';
    tempFile.extension = 'jpg';

    await createHandler(tempFile);

    expect(deleteFile).not.toHaveBeenCalled();
    expect(noticeMessages).toHaveLength(1);
    expect(noticeMessages[0]).toMatch(/Upload timeout/);
  });

  it('defers vault create listener until onLayoutReady and ignores ignored paths', async () => {
    const { plugin, vaultListeners, readBinary, triggerLayoutReady } = createWorkspaceHarness(
      undefined,
      { deferLayoutReady: true },
    );
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, syncObsidianDir: false },
      state: {
        lastSyncedCommitSha: 'c0',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: [],
      },
      client: { createCommit: vi.fn() } as any,
      loader: { registerMemoryImage: vi.fn() } as any,
      saveState: vi.fn(),
      isEnabled: () => true,
    };

    registerMobileImageUpload(plugin, () => deps);
    expect(vaultListeners.get('create')).toBeUndefined();

    triggerLayoutReady();
    const createHandler = vaultListeners.get('create')!;
    expect(createHandler).toBeDefined();

    const ignoredFile = new TFile();
    ignoredFile.path = '.obsidian/themes/cover.png';
    ignoredFile.name = 'cover.png';
    ignoredFile.extension = 'png';

    await createHandler(ignoredFile);
    expect(readBinary).not.toHaveBeenCalled();
    expect(deps.client.createCommit).not.toHaveBeenCalled();
  });

  it('serializes concurrent vault create events so multi-image picks do not collide', async () => {
    const { plugin, vaultListeners, readBinary } = createWorkspaceHarness();
    readBinary.mockResolvedValue(new Uint8Array([1, 2]).buffer);

    let inFlight = 0;
    let maxInFlight = 0;
    const createCommit = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return 'c_seq';
    });

    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, attachmentFolder: 'attachments' },
      state,
      client: { createCommit } as any,
      loader: { registerMemoryImage: vi.fn() } as any,
      saveState: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
    };

    registerMobileImageUpload(plugin, () => deps);
    const createHandler = vaultListeners.get('create')!;

    const f1 = new TFile();
    f1.path = 'pick1.png';
    f1.name = 'pick1.png';
    f1.extension = 'png';

    const f2 = new TFile();
    f2.path = 'pick2.png';
    f2.name = 'pick2.png';
    f2.extension = 'png';

    await Promise.all([createHandler(f1), createHandler(f2)]);

    expect(maxInFlight).toBe(1);
    expect(createCommit).toHaveBeenCalledTimes(2);
    expect(state.remoteImagePaths).toHaveLength(2);
    expect(new Set(state.remoteImagePaths).size).toBe(2);
  });

  it('intercepts editor-drop image when file.type is empty but filename has an image extension', async () => {
    const { plugin, listeners } = createWorkspaceHarness();
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const onUploaded = vi.fn();
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, branch: 'main', attachmentFolder: 'attachments' },
      state,
      client: { createCommit: vi.fn().mockResolvedValue('c_empty_mime') } as any,
      loader: { registerMemoryImage: vi.fn().mockReturnValue('blob:mem-empty') } as any,
      saveState: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
      onUploaded,
    };

    registerMobileImageUpload(plugin, () => deps);
    const dropHandler = listeners.get('editor-drop')!;

    const file = createMockFile([1, 2, 3], '', 'photo.png');
    const preventDefault = vi.fn();
    const editor = { replaceSelection: vi.fn() } as unknown as Editor;

    await dropHandler(
      {
        defaultPrevented: false,
        preventDefault,
        dataTransfer: { files: [file], items: [] },
      } as unknown as DragEvent,
      editor,
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.client.createCommit).toHaveBeenCalledTimes(1);
    expect(deps.loader.registerMemoryImage).toHaveBeenCalledWith(
      expect.stringMatching(/^attachments\/Pasted image \d{14}\.png$/),
      expect.objectContaining({ type: 'image/png' }),
    );
    expect(editor.replaceSelection).toHaveBeenCalledWith(
      expect.stringMatching(/^!\[\[attachments\/Pasted image \d{14}\.png\]\]$/),
    );
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  function createStatefulEditor(initialDoc: string, initialCursor = 0) {
    let doc = initialDoc;
    let cursor = initialCursor;
    const posToOffset = (pos: { line: number; ch: number }): number => {
      const lines = doc.split('\n');
      let off = 0;
      for (let i = 0; i < pos.line; i++) {
        off += (lines[i]?.length ?? 0) + 1;
      }
      return off + pos.ch;
    };
    const offsetToPos = vi.fn((offset: number) => {
      const before = doc.slice(0, offset);
      const lines = before.split('\n');
      return { line: lines.length - 1, ch: lines[lines.length - 1].length };
    });
    const setValue = vi.fn((val: string) => {
      doc = val;
    });
    const replaceSelection = vi.fn((text: string) => {
      doc = doc.slice(0, cursor) + text + doc.slice(cursor);
      cursor += text.length;
    });
    const replaceRange = vi.fn(
      (text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => {
        const fromOff = posToOffset(from);
        const toOff = to ? posToOffset(to) : fromOff;
        doc = doc.slice(0, fromOff) + text + doc.slice(toOff);
      },
    );
    return {
      editor: {
        getValue: vi.fn(() => doc),
        setValue,
        offsetToPos,
        replaceSelection,
        replaceRange,
      } as unknown as Editor,
      getDoc: () => doc,
      setDoc: (next: string) => {
        doc = next;
      },
      appendAtEnd: (text: string) => {
        doc += text;
        cursor = doc.length;
      },
      setValue,
      replaceRange,
    };
  }

  it('replaces only placeholder marker range on async editor-paste even if cursor moves, and removes marker on offline failure', async () => {
    const { plugin, listeners } = createWorkspaceHarness();
    let resolveCommit!: (sha: string) => void;
    const createCommit = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    const onUploaded = vi.fn();
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, attachmentFolder: 'attachments' },
      state,
      client: { createCommit } as any,
      loader: { registerMemoryImage: vi.fn().mockReturnValue('blob:mem-async') } as any,
      saveState: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
      onUploaded,
    };

    registerMobileImageUpload(plugin, () => deps);
    const pasteHandler = listeners.get('editor-paste')!;

    // 1. Slow paste succeeds after user moves cursor and edits end of note
    const ed1 = createStatefulEditor('Line 1\nInsert here: \nLine 3', 'Line 1\nInsert here: '.length);
    const pastePromise = pasteHandler(
      {
        defaultPrevented: false,
        preventDefault: vi.fn(),
        clipboardData: { files: [createMockFile([1, 2], 'image/png')], items: [] },
      } as unknown as ClipboardEvent,
      ed1.editor,
    );

    await Promise.resolve();
    expect(ed1.getDoc()).toMatch(/<!-- uploading-gitlab-image-\d+ -->/);
    ed1.appendAtEnd(' + tail edit');

    resolveCommit('c_async_1');
    await pastePromise;

    expect(ed1.replaceRange).toHaveBeenCalledTimes(1);
    expect(ed1.getDoc()).toMatch(
      /^Line 1\nInsert here: !\[\[attachments\/Pasted image \d{14}\.png\]\]\nLine 3 \+ tail edit$/,
    );
    expect(onUploaded).toHaveBeenCalledTimes(1);

    // 2. Offline failure removes placeholder marker cleanly
    deps.client = { createCommit: vi.fn().mockRejectedValue(new Error('Network offline')) } as any;
    const ed2 = createStatefulEditor('Before After', 'Before '.length);
    await pasteHandler(
      {
        defaultPrevented: false,
        preventDefault: vi.fn(),
        clipboardData: { files: [createMockFile([1, 2], 'image/png')], items: [] },
      } as unknown as ClipboardEvent,
      ed2.editor,
    );

    expect(ed2.replaceRange).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ line: 0, ch: 7 }),
      expect.any(Object),
    );
    expect(ed2.getDoc()).toBe('Before After');
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(noticeMessages).toHaveLength(1);
    expect(noticeMessages[0]).toMatch(/offline/i);
  });

  it('uses targeted editor.replaceRange in handleVaultImageCreate when supported and calls deps.onUploaded', async () => {
    const ed = createStatefulEditor('Line 0\nPhoto: ![[Pasted image 999.heic]]\nLine 2');
    const { plugin, vaultListeners, readBinary, deleteFile } = createWorkspaceHarness(ed.editor);
    readBinary.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);

    const onUploaded = vi.fn();
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {},
      remoteImagePaths: [],
    };
    const deps: PasteUploadDeps = {
      settings: { ...DEFAULT_SETTINGS, attachmentFolder: 'attachments', syncObsidianDir: false },
      state,
      client: { createCommit: vi.fn().mockResolvedValue('c_range') } as any,
      loader: { registerMemoryImage: vi.fn().mockReturnValue('blob:cam-range') } as any,
      saveState: vi.fn().mockResolvedValue(undefined),
      isEnabled: () => true,
      configDir: '.custom-obsidian',
      onUploaded,
    };

    registerMobileImageUpload(plugin, () => deps);
    const createHandler = vaultListeners.get('create')!;

    const tempFile = new TFile();
    tempFile.path = 'Pasted image 999.heic';
    tempFile.name = 'Pasted image 999.heic';
    tempFile.extension = 'heic';

    await createHandler(tempFile);

    expect(ed.setValue).not.toHaveBeenCalled();
    expect(ed.replaceRange).toHaveBeenCalledWith(
      expect.stringMatching(/^!\[\[attachments\/Pasted image \d{14}\.heic\]\]$/),
      { line: 1, ch: 7 },
      { line: 1, ch: 33 },
    );
    expect(ed.getDoc()).toMatch(/^Line 0\nPhoto: !\[\[attachments\/Pasted image \d{14}\.heic\]\]\nLine 2$/);
    expect(deleteFile).toHaveBeenCalledWith(tempFile);
    expect(onUploaded).toHaveBeenCalledTimes(1);

    // Also replaces percent-encoded markdown link and respects custom configDir
    ed.setDoc('Shot: ![cam](attachments/camera%20shot.jpg)');
    const mdFile = new TFile();
    mdFile.path = 'attachments/camera shot.jpg';
    mdFile.name = 'camera shot.jpg';
    mdFile.extension = 'jpg';
    await createHandler(mdFile);
    expect(ed.setValue).not.toHaveBeenCalled();
    expect(ed.getDoc()).toMatch(/^Shot: !\[\[attachments\/Pasted image \d{14}\.jpg\]\]$/);
    expect(onUploaded).toHaveBeenCalledTimes(2);

    const ignoredCustom = new TFile();
    ignoredCustom.path = '.custom-obsidian/themes/bg.png';
    ignoredCustom.name = 'bg.png';
    ignoredCustom.extension = 'png';
    await createHandler(ignoredCustom);
    expect(deps.client.createCommit).toHaveBeenCalledTimes(2);
  });
});
