// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamLanguage, defaultHighlightStyle } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  editorInfoField,
  editorLivePreviewField,
  setEditorLivePreviewEffect,
} from 'obsidian';
import {
  createLivePreviewImageExtension,
  refreshRemoteImagesEffect,
} from '../src/images/live-preview';
import { OnDemandImageLoader } from '../src/images/loader';
import type { ImageRenderContext } from '../src/images/reading-view';
import { DEFAULT_SETTINGS } from '../src/types';

const codeTokenTag = defaultHighlightStyle.specs[0].tag;

const testMarkdownCodeLang = StreamLanguage.define<{ inFence: boolean }>({
  startState: () => ({ inFence: false }),
  token(stream, state) {
    if (stream.sol() && stream.match(/^```/)) {
      state.inFence = !state.inFence;
      stream.skipToEnd();
      return 'codeblock';
    }
    if (state.inFence) {
      stream.skipToEnd();
      return 'codeblock';
    }
    if (stream.match(/^`[^`]+`/)) {
      return 'inlinecode';
    }
    stream.next();
    return null;
  },
  tokenTable: {
    codeblock: codeTokenTag,
    inlinecode: codeTokenTag,
  },
});

describe('createLivePreviewImageExtension', () => {
  const activeViews: EditorView[] = [];
  const containers: HTMLElement[] = [];

  function mountEditor(
    doc: string,
    getContext: () => ImageRenderContext,
    options?: { filePath?: string; livePreview?: boolean; cursor?: number },
  ): EditorView {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    containers.push(parent);

    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(options?.cursor ?? 0),
      extensions: [
        testMarkdownCodeLang,
        editorLivePreviewField.init(() => options?.livePreview ?? true),
        editorInfoField.init(() => ({ file: { path: options?.filePath ?? 'notes/today.md' } })),
        createLivePreviewImageExtension(getContext),
      ],
    });

    const view = new EditorView({ state, parent });
    activeViews.push(view);
    return view;
  }

  afterEach(() => {
    while (activeViews.length > 0) {
      activeViews.pop()!.destroy();
    }
    while (containers.length > 0) {
      containers.pop()!.remove();
    }
    vi.unstubAllGlobals();
  });

  it('renders wikilink and markdown image embeds with parentheses, alt, and width', () => {
    const observeAndLoad = vi.fn().mockReturnValue(vi.fn());
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS, branch: 'main' },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: 'mobile-conflict/20261119-060000',
        files: {},
        remoteImagePaths: ['notes/img.png', 'attachments/sub/photo(1).png'],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const doc = 'Intro\n![[img.png]]\n![Diagram alt|240](sub/photo(1).png)\nEnd';
    const view = mountEditor(doc, () => ctx, { cursor: 0 });

    const embeds = Array.from(view.dom.querySelectorAll<HTMLElement>('.gitlab-ondemand-embed'));
    expect(embeds).toHaveLength(2);

    const img0 = embeds[0].querySelector('img')!;
    expect(img0.classList.contains('gitlab-ondemand-img')).toBe(true);

    const img1 = embeds[1].querySelector('img')!;
    expect(img1.alt).toBe('Diagram alt');
    expect(img1.style.width).toBe('240px');
    expect(img1.style.maxWidth).toBe('100%');

    expect(observeAndLoad).toHaveBeenCalledTimes(2);
    expect(observeAndLoad).toHaveBeenNthCalledWith(
      1,
      img0,
      'notes/img.png',
      'mobile-conflict/20261119-060000',
      'main',
    );
    expect(observeAndLoad).toHaveBeenNthCalledWith(
      2,
      img1,
      'attachments/sub/photo(1).png',
      'mobile-conflict/20261119-060000',
      'main',
    );
  });

  it('expands embed when cursor overlaps and hides decorations in Source Mode or when disabled/local', () => {
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const observeAndLoad = vi.fn(() => {
      const fn = vi.fn();
      cleanups.push(fn);
      return fn;
    });
    let enabled = true;
    let localPaths = new Set<string>();

    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: ['attachments/img.png'],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: (p) => localPaths.has(p),
      isEnabled: () => enabled,
    };

    const doc = 'Top line\n![[img.png]]\nBottom line';
    const embedStart = doc.indexOf('![[img.png]]');
    const view = mountEditor(doc, () => ctx, { cursor: 0 });

    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(1);
    expect(cleanups).toHaveLength(1);

    // Move cursor onto the embed -> widget removed & destroy() runs cleanup
    view.dispatch({ selection: EditorSelection.cursor(embedStart + 3) });
    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(0);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);

    // Move cursor outside again -> widget restored
    view.dispatch({ selection: EditorSelection.cursor(doc.length) });
    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(1);
    expect(cleanups).toHaveLength(2);

    // Switch to Source Mode -> widget removed & cleaned up
    view.dispatch({ effects: setEditorLivePreviewEffect.of(false) });
    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(0);
    expect(cleanups[1]).toHaveBeenCalledTimes(1);

    // Back to Live Preview -> restored
    view.dispatch({ effects: setEditorLivePreviewEffect.of(true) });
    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(1);

    // Local file present -> skipped
    localPaths.add('attachments/img.png');
    view.dispatch({ effects: refreshRemoteImagesEffect.of(undefined) });
    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(0);

    // Disabled -> skipped
    localPaths.clear();
    enabled = false;
    view.dispatch({ effects: refreshRemoteImagesEffect.of(undefined) });
    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(0);
  });

  it('excludes embeds inside inline code and fenced code blocks via syntax tree', () => {
    const observeAndLoad = vi.fn().mockReturnValue(vi.fn());
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: [
          'attachments/inline.png',
          'attachments/fenced.png',
          'attachments/visible.png',
        ],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const doc = [
      'Inline `![[inline.png]]` example',
      '```md',
      '![[fenced.png]]',
      '```',
      '![[visible.png]]',
    ].join('\n');

    const view = mountEditor(doc, () => ctx, { cursor: 0 });
    const embeds = view.dom.querySelectorAll('.gitlab-ondemand-embed');
    expect(embeds).toHaveLength(1);
    expect(observeAndLoad).toHaveBeenCalledTimes(1);
    expect(observeAndLoad.mock.calls[0][1]).toBe('attachments/visible.png');
  });

  it('updates decorations when refreshRemoteImagesEffect is dispatched after sync', () => {
    const observeAndLoad = vi.fn().mockReturnValue(vi.fn());
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: [],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const view = mountEditor('Header\n![[synced.png]]', () => ctx, { cursor: 0 });
    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(0);
    expect(observeAndLoad).not.toHaveBeenCalled();

    ctx.state.remoteImagePaths = ['attachments/synced.png'];
    view.dispatch({ effects: refreshRemoteImagesEffect.of(undefined) });

    expect(view.dom.querySelectorAll('.gitlab-ondemand-embed')).toHaveLength(1);
    expect(observeAndLoad).toHaveBeenCalledTimes(1);
    expect(observeAndLoad.mock.calls[0][1]).toBe('attachments/synced.png');
  });

  it('revokes real OnDemandImageLoader blob URL when widget destroy() runs on editor destroy', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    let seq = 0;
    const blobApi = {
      createObjectURL: vi.fn(() => `blob:lp-${++seq}`),
      revokeObjectURL: vi.fn(),
    };
    const client = {
      getRawBinary: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    };
    const loader = new OnDemandImageLoader(client, blobApi, 3);
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: ['attachments/pic.png'],
      },
      loader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const view = mountEditor('Text\n![[pic.png]]', () => ctx, { cursor: 0 });
    const imgEl = view.dom.querySelector<HTMLImageElement>('.gitlab-ondemand-img')!;
    await vi.waitFor(() => expect(imgEl.src).toBe('blob:lp-1'));

    view.destroy();
    expect(blobApi.revokeObjectURL).not.toHaveBeenCalled();
    loader.revokeAll();
    expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:lp-1');
  });

  it('hydrates built-in .internal-embed nodes injected into Live Preview DOM and cleans up on destroy', async () => {
    const cleanup = vi.fn();
    const observeAndLoad = vi.fn().mockReturnValue(cleanup);
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: ['Asset/builtin.png'],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const view = mountEditor('Intro', () => ctx, { cursor: 0 });
    const builtInEmbed = document.createElement('div');
    builtInEmbed.className = 'internal-embed image-embed is-unresolved';
    builtInEmbed.setAttribute('src', 'builtin.png');
    view.contentDOM.appendChild(builtInEmbed);

    await vi.waitFor(() => expect(observeAndLoad).toHaveBeenCalledTimes(1));
    expect(builtInEmbed.classList.contains('is-unresolved')).toBe(false);
    expect(builtInEmbed.classList.contains('gitlab-ondemand-embed')).toBe(true);
    expect(builtInEmbed.querySelector('img')).not.toBeNull();
    expect(observeAndLoad).toHaveBeenCalledWith(
      expect.any(HTMLImageElement),
      'Asset/builtin.png',
      'main',
      undefined,
    );

    view.destroy();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('reloads a failed image in Live Preview without expanding raw markdown on mousedown + click', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const blobApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:lp-reloaded'),
      revokeObjectURL: vi.fn(),
    };
    const client = {
      getRawBinary: vi
        .fn()
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        .mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer),
    };
    const loader = new OnDemandImageLoader(client, blobApi, 3);
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: ['attachments/pic.png'],
      },
      loader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const view = mountEditor('Intro\n![[pic.png]]', () => ctx, { cursor: 0 });
    const reloadBtn = await vi.waitFor(() => {
      const btn = view.dom.querySelector<HTMLButtonElement>('.gitlab-img-reload-btn');
      if (!btn) {
        throw new Error('Reload button not rendered yet');
      }
      return btn;
    });

    reloadBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    reloadBtn.click();

    await vi.waitFor(() => {
      const img = view.dom.querySelector<HTMLImageElement>('.gitlab-ondemand-img');
      expect(img?.src).toBe('blob:lp-reloaded');
    });
    expect(view.dom.querySelector('.gitlab-img-error-box')).toBeNull();
    expect(client.getRawBinary).toHaveBeenCalledTimes(2);
    expect(view.state.selection.main.head).toBe(0);
  });
});
