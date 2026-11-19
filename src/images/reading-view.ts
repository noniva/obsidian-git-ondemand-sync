import { MarkdownRenderChild, type Plugin } from 'obsidian';
import type { OnDemandImageLoader } from './loader';
import type { PluginSettings, SyncState } from '../types';
import {
  isImagePath,
  normalizeVaultPath,
  parseEmbedWidth,
  parseImageEmbed,
  resolveRemoteImagePath,
} from '../utils/paths';

export interface ImageRenderContext {
  settings: PluginSettings;
  state: SyncState;
  loader: OnDemandImageLoader;
  isLocalFilePresent: (path: string) => boolean;
  isEnabled: () => boolean;
}

class GitLabImageRenderChild extends MarkdownRenderChild {
  private readonly cleanup: () => void;

  constructor(containerEl: HTMLElement, cleanup: () => void) {
    super(containerEl);
    this.cleanup = cleanup;
  }

  override onunload(): void {
    this.cleanup();
  }
}

function getNoteDir(sourcePath: string): string {
  const normalized = normalizeVaultPath(sourcePath);
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
}

function getActiveRefs(ctx: ImageRenderContext): { ref: string; fallbackRef?: string } {
  const targetBranch = ctx.settings.branch || 'main';
  if (ctx.state.activeConflictBranch) {
    return { ref: ctx.state.activeConflictBranch, fallbackRef: targetBranch };
  }
  return { ref: targetBranch };
}

function parseWidthAttr(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  return parseEmbedWidth(raw);
}

function applyImageAttributes(imgEl: HTMLImageElement, alt: string, width?: number): void {
  imgEl.classList.add('gitlab-ondemand-img');
  const trimmedAlt = alt.trim();
  if (trimmedAlt && parseEmbedWidth(trimmedAlt) === undefined) {
    imgEl.alt = trimmedAlt;
  } else if (trimmedAlt && trimmedAlt.includes('|')) {
    const lastPipe = trimmedAlt.lastIndexOf('|');
    const cleanedAlt = trimmedAlt.slice(0, lastPipe).trim();
    if (cleanedAlt) {
      imgEl.alt = cleanedAlt;
    }
  }
  if (width !== undefined && Number.isFinite(width) && width > 0) {
    imgEl.style.width = `${width}px`;
    imgEl.style.maxWidth = '100%';
  }
}

/**
 * Registers a Reading View `MarkdownPostProcessor` that lazily loads remote-only
 * GitLab images in memory when they are absent from local vault storage.
 */
export function registerReadingViewImageProcessor(
  plugin: Plugin,
  getContext: () => ImageRenderContext,
): void {
  plugin.registerMarkdownPostProcessor((el, mdCtx) => {
    const ctx = getContext();
    if (!ctx.isEnabled()) {
      return;
    }

    const noteDir = getNoteDir(mdCtx.sourcePath);
    const { ref, fallbackRef } = getActiveRefs(ctx);

    const embeds = el.querySelectorAll<HTMLElement>('.internal-embed');
    for (const embedEl of Array.from(embeds)) {
      if (embedEl.dataset.gitlabProcessed === 'true') {
        continue;
      }

      const rawTarget = embedEl.getAttribute('src') ?? embedEl.getAttribute('data-src') ?? '';
      const parsed = parseImageEmbed(rawTarget);
      if (!parsed || !isImagePath(parsed.target)) {
        continue;
      }

      const resolved = resolveRemoteImagePath(
        parsed.target,
        noteDir,
        ctx.state.remoteImagePaths,
        { decodeTarget: false },
      );
      if (!resolved || ctx.isLocalFilePresent(resolved)) {
        continue;
      }

      const altAttr = embedEl.getAttribute('alt') ?? '';
      const width =
        parsed.width ??
        parseWidthAttr(embedEl.getAttribute('width')) ??
        parseWidthAttr(altAttr);

      const imgEl = document.createElement('img');
      applyImageAttributes(imgEl, parsed.alt ?? altAttr, width);

      embedEl.dataset.gitlabProcessed = 'true';
      embedEl.classList.remove('is-unresolved');
      embedEl.classList.add('is-loaded', 'gitlab-ondemand-embed');
      embedEl.replaceChildren(imgEl);

      const cleanup = ctx.loader.observeAndLoad(imgEl, resolved, ref, fallbackRef);
      mdCtx.addChild(new GitLabImageRenderChild(embedEl, cleanup));
    }

    const images = el.querySelectorAll<HTMLImageElement>('img');
    for (const imgEl of Array.from(images)) {
      if (
        imgEl.dataset.gitlabProcessed === 'true' ||
        imgEl.dataset.gitlabSrc ||
        imgEl.closest('.gitlab-ondemand-embed')
      ) {
        continue;
      }

      const rawTarget = imgEl.getAttribute('src') ?? imgEl.getAttribute('data-src') ?? '';
      const parsed = parseImageEmbed(rawTarget);
      if (!parsed || !isImagePath(parsed.target)) {
        continue;
      }

      const resolved = resolveRemoteImagePath(
        parsed.target,
        noteDir,
        ctx.state.remoteImagePaths,
        { decodeTarget: false },
      );
      if (!resolved || ctx.isLocalFilePresent(resolved)) {
        continue;
      }

      const altAttr = imgEl.getAttribute('alt') ?? '';
      const width =
        parsed.width ??
        parseWidthAttr(imgEl.getAttribute('width')) ??
        parseWidthAttr(altAttr);

      applyImageAttributes(imgEl, parsed.alt ?? altAttr, width);
      imgEl.dataset.gitlabProcessed = 'true';
      imgEl.removeAttribute('src');

      const cleanup = ctx.loader.observeAndLoad(imgEl, resolved, ref, fallbackRef);
      mdCtx.addChild(new GitLabImageRenderChild(imgEl, cleanup));
    }
  });
}
