// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MarkdownRenderChild,
  type MarkdownPostProcessor,
  type MarkdownPostProcessorContext,
  type Plugin,
} from 'obsidian';
import { OnDemandImageLoader } from '../src/images/loader';
import {
  registerReadingViewImageProcessor,
  type ImageRenderContext,
} from '../src/images/reading-view';
import { DEFAULT_SETTINGS } from '../src/types';

function setupPostProcessor(getContext: () => ImageRenderContext) {
  let registered: MarkdownPostProcessor | null = null;
  const plugin = {
    registerMarkdownPostProcessor: vi.fn((processor: MarkdownPostProcessor) => {
      registered = processor;
    }),
  } as unknown as Plugin;

  registerReadingViewImageProcessor(plugin, getContext);
  expect(registered).not.toBeNull();

  return async (el: HTMLElement, sourcePath = 'notes/today.md') => {
    const children: MarkdownRenderChild[] = [];
    const mdCtx = {
      docId: 'doc-1',
      sourcePath,
      frontmatter: null,
      addChild: vi.fn((child: MarkdownRenderChild) => {
        children.push(child);
      }),
      getSectionInfo: vi.fn(() => null),
    } as unknown as MarkdownPostProcessorContext;

    await registered!(el, mdCtx);
    return { children, mdCtx };
  };
}

describe('registerReadingViewImageProcessor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces .internal-embed with lazy img, handles multi-pipe alt/width, and avoids double-processing', async () => {
    const cleanup = vi.fn();
    const observeAndLoad = vi.fn().mockReturnValue(cleanup);
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS, branch: 'main' },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: ['notes/pic.png', 'attachments/arch.png', 'attachments/fallback.jpg'],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const runProcessor = setupPostProcessor(() => ctx);
    const root = document.createElement('div');
    root.innerHTML = `
      <span class="internal-embed is-unresolved" src="pic.png|My Caption|300"></span>
      <span class="internal-embed is-unresolved" data-src="arch.png|part one|part two|420"></span>
      <span class="internal-embed is-unresolved" src="fallback.jpg" alt="legacy|caption|250"></span>
      <span class="internal-embed is-unresolved" src="OtherNote.md"></span>
    `;

    const { children } = await runProcessor(root, 'notes/daily.md');

    const embeds = Array.from(root.querySelectorAll<HTMLElement>('.internal-embed'));
    expect(embeds[0].dataset.gitlabProcessed).toBe('true');
    expect(embeds[0].classList.contains('is-unresolved')).toBe(false);
    expect(embeds[0].classList.contains('is-loaded')).toBe(true);
    expect(embeds[0].classList.contains('gitlab-ondemand-embed')).toBe(true);

    const img0 = embeds[0].querySelector('img')!;
    expect(img0).not.toBeNull();
    expect(img0.classList.contains('gitlab-ondemand-img')).toBe(true);
    expect(img0.alt).toBe('My Caption');
    expect(img0.style.width).toBe('300px');
    expect(img0.style.maxWidth).toBe('100%');

    const img1 = embeds[1].querySelector('img')!;
    expect(img1.alt).toBe('part one|part two');
    expect(img1.style.width).toBe('420px');

    const img2 = embeds[2].querySelector('img')!;
    expect(img2.alt).toBe('legacy|caption');
    expect(img2.style.width).toBe('250px');

    // Non-image markdown embed untouched
    expect(embeds[3].querySelector('img')).toBeNull();
    expect(embeds[3].dataset.gitlabProcessed).toBeUndefined();

    // Only the 3 remote images triggered observeAndLoad (inserted <img> elements were not double-processed)
    expect(observeAndLoad).toHaveBeenCalledTimes(3);
    expect(observeAndLoad).toHaveBeenNthCalledWith(1, img0, 'notes/pic.png', 'main', undefined);
    expect(observeAndLoad).toHaveBeenNthCalledWith(2, img1, 'attachments/arch.png', 'main', undefined);
    expect(observeAndLoad).toHaveBeenNthCalledWith(3, img2, 'attachments/fallback.jpg', 'main', undefined);
    expect(children).toHaveLength(3);

    // Re-running processor skips already-processed embeds
    await runProcessor(root, 'notes/daily.md');
    expect(observeAndLoad).toHaveBeenCalledTimes(3);
  });

  it('processes standalone <img> tags, strips src, and passes conflict ref + fallbackRef', async () => {
    const observeAndLoad = vi.fn().mockReturnValue(vi.fn());
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS, branch: 'main' },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: 'mobile-conflict/20261119-060000',
        files: {},
        remoteImagePaths: ['attachments/chart.webp'],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const runProcessor = setupPostProcessor(() => ctx);
    const root = document.createElement('div');
    root.innerHTML = `
      <img src="chart.webp" alt="Revenue|280">
      <img src="https://example.com/external.png" alt="External">
    `;

    const { children } = await runProcessor(root, 'index.md');
    const imgs = Array.from(root.querySelectorAll('img'));

    expect(imgs[0].hasAttribute('src')).toBe(false);
    expect(imgs[0].dataset.gitlabProcessed).toBe('true');
    expect(imgs[0].alt).toBe('Revenue');
    expect(imgs[0].style.width).toBe('280px');
    expect(observeAndLoad).toHaveBeenCalledTimes(1);
    expect(observeAndLoad).toHaveBeenCalledWith(
      imgs[0],
      'attachments/chart.webp',
      'mobile-conflict/20261119-060000',
      'main',
    );
    expect(children).toHaveLength(1);

    // External URL left untouched
    expect(imgs[1].getAttribute('src')).toBe('https://example.com/external.png');
    expect(imgs[1].dataset.gitlabProcessed).toBeUndefined();
  });

  it('skips processing when local file is present or plugin is disabled', async () => {
    const observeAndLoad = vi.fn().mockReturnValue(vi.fn());
    let enabled = true;
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: ['attachments/local.png', 'attachments/remote.png'],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: (p) => p === 'attachments/local.png',
      isEnabled: () => enabled,
    };

    const runProcessor = setupPostProcessor(() => ctx);
    const root = document.createElement('div');
    root.innerHTML = `
      <span class="internal-embed is-unresolved" src="local.png"></span>
      <img src="local.png">
    `;

    const { children: localChildren } = await runProcessor(root);
    expect(observeAndLoad).not.toHaveBeenCalled();
    expect(localChildren).toHaveLength(0);
    expect(root.querySelector('img')?.getAttribute('src')).toBe('local.png');

    enabled = false;
    const disabledRoot = document.createElement('div');
    disabledRoot.innerHTML = `<span class="internal-embed is-unresolved" src="remote.png"></span>`;
    const { children: disabledChildren } = await runProcessor(disabledRoot);
    expect(observeAndLoad).not.toHaveBeenCalled();
    expect(disabledChildren).toHaveLength(0);
    expect(disabledRoot.querySelector('img')).toBeNull();
  });

  it('invokes loader cleanup and revokes blob URL when MarkdownRenderChild unloads', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    let seq = 0;
    const blobApi = {
      createObjectURL: vi.fn(() => `blob:rv-${++seq}`),
      revokeObjectURL: vi.fn(),
    };
    const client = {
      getRawBinary: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer),
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

    const runProcessor = setupPostProcessor(() => ctx);
    const root = document.createElement('div');
    root.innerHTML = `<span class="internal-embed is-unresolved" src="pic.png"></span>`;

    const { children } = await runProcessor(root);
    expect(children).toHaveLength(1);
    const imgEl = root.querySelector('img')!;
    await vi.waitFor(() => expect(imgEl.src).toBe('blob:rv-1'));

    children[0].onunload();
    expect(blobApi.revokeObjectURL).not.toHaveBeenCalled();
    loader.revokeAll();
    expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:rv-1');
  });

  it('processes a root element that is itself an .internal-embed', async () => {
    const observeAndLoad = vi.fn().mockReturnValue(vi.fn());
    const ctx: ImageRenderContext = {
      settings: { ...DEFAULT_SETTINGS },
      state: {
        lastSyncedCommitSha: 'c1',
        activeConflictBranch: null,
        files: {},
        remoteImagePaths: ['Asset/pic.png'],
      },
      loader: { observeAndLoad } as unknown as OnDemandImageLoader,
      isLocalFilePresent: () => false,
      isEnabled: () => true,
    };

    const runProcessor = setupPostProcessor(() => ctx);
    const embedEl = document.createElement('span');
    embedEl.className = 'internal-embed is-unresolved';
    embedEl.setAttribute('src', 'pic.png');

    const { children } = await runProcessor(embedEl);
    expect(children).toHaveLength(1);
    expect(observeAndLoad).toHaveBeenCalledTimes(1);
    expect(observeAndLoad).toHaveBeenCalledWith(expect.any(HTMLImageElement), 'Asset/pic.png', 'main', undefined);

    // Simulate host DOM overwrite clearing children while keeping data-gitlab-processed
    embedEl.replaceChildren(document.createTextNode('pic.png'));
    const { children: rehydrated } = await runProcessor(embedEl);
    expect(rehydrated).toHaveLength(1);
    expect(observeAndLoad).toHaveBeenCalledTimes(2);
  });
});
