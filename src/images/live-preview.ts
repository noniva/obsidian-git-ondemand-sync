import { syntaxTree } from '@codemirror/language';
import { Prec, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { editorInfoField, editorLivePreviewField } from 'obsidian';
import {
  applyImageWidth,
  getActiveRefs,
  getNoteDir,
  hydrateRemoteEmbed,
  type ImageRenderContext,
} from './reading-view';
import { isImagePath, parseImageEmbed, resolveRemoteImagePath } from '../utils/paths';

/**
 * CodeMirror state effect dispatched when open Live Preview editors should rebuild
 * remote image decorations (for example after sync or paste upload updates `remoteImagePaths`).
 */
export const refreshRemoteImagesEffect = StateEffect.define<void>();

const IMAGE_EMBED_RE =
  /!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\((?:<([^>]+)>|([^()\s]*(?:\([^()\s]*\)[^()\s]*)*))(?:\s+"[^"]*")?\)/g;
const ALT_SIZE_RE = /(?:^|\|)(\d+)(?:x\d+)?$/;
const CODE_NODE_NAMES = [
  'codeblock',
  'hmd-codeblock',
  'hypermd-codeblock',
  'inlinecode',
  'inline-code',
  'fencedcode',
  'codeinfo',
  'codemarks',
  'codemark',
  'codetext',
];

const widgetCleanups = new WeakMap<HTMLElement, () => void>();

function parseMarkdownAlt(rawAlt: string): { alt: string; width?: number } {
  const trimmed = rawAlt.trim();
  if (!trimmed) {
    return { alt: '' };
  }
  const sizeMatch = ALT_SIZE_RE.exec(trimmed);
  if (!sizeMatch) {
    return { alt: trimmed };
  }
  const width = Number(sizeMatch[1]);
  const pipeIdx = trimmed.lastIndexOf('|');
  const alt = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx).trim() : '';
  return {
    alt,
    width: Number.isFinite(width) && width > 0 ? width : undefined,
  };
}

function selectionOverlapsRange(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) {
      return true;
    }
  }
  return false;
}

function isInsideCodeContext(view: EditorView, pos: number): boolean {
  const tree = syntaxTree(view.state);
  for (
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    const lowerName = node.name.toLowerCase();
    if (CODE_NODE_NAMES.some((codeName) => lowerName.includes(codeName))) {
      return true;
    }
  }
  return false;
}

class RemoteImageWidget extends WidgetType {
  private readonly repoPath: string;
  private readonly ref: string;
  private readonly fallbackRef: string | undefined;
  private readonly alt: string;
  private readonly width: number | undefined;
  private readonly getContext: () => ImageRenderContext;

  constructor(
    repoPath: string,
    ref: string,
    fallbackRef: string | undefined,
    alt: string,
    width: number | undefined,
    getContext: () => ImageRenderContext,
  ) {
    super();
    this.repoPath = repoPath;
    this.ref = ref;
    this.fallbackRef = fallbackRef;
    this.alt = alt;
    this.width = width;
    this.getContext = getContext;
  }

  override eq(other: RemoteImageWidget): boolean {
    return (
      other.repoPath === this.repoPath &&
      other.ref === this.ref &&
      other.fallbackRef === this.fallbackRef &&
      other.alt === this.alt &&
      other.width === this.width
    );
  }

  override toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'gitlab-ondemand-embed';

    const imgEl = document.createElement('img');
    imgEl.className = 'gitlab-ondemand-img';
    if (this.alt) {
      imgEl.alt = this.alt;
    }
    applyImageWidth(imgEl, this.width);

    container.appendChild(imgEl);

    const cleanup = this.getContext().loader.observeAndLoad(
      imgEl,
      this.repoPath,
      this.ref,
      this.fallbackRef,
    );
    widgetCleanups.set(container, cleanup);
    return container;
  }

  override destroy(dom: HTMLElement): void {
    const cleanup = widgetCleanups.get(dom);
    if (cleanup) {
      cleanup();
      widgetCleanups.delete(dom);
    }
  }

  override ignoreEvent(event: Event): boolean {
    const target = event.target as Node | null;
    const element = target?.instanceOf(Element) ? target : (target?.parentElement ?? null);
    return Boolean(
      element?.closest?.('.gitlab-img-error-box, .gitlab-img-status-box, .gitlab-img-reload-btn'),
    );
  }
}

function buildDecorations(view: EditorView, getContext: () => ImageRenderContext): DecorationSet {
  const ctx = getContext();
  if (!ctx.isEnabled()) {
    return Decoration.none;
  }

  // Only replace embeds in Live Preview, never in Source Mode.
  if (view.state.field(editorLivePreviewField, false) === false) {
    return Decoration.none;
  }

  const fileInfo = view.state.field(editorInfoField, false);
  const noteDir = getNoteDir(fileInfo?.file?.path ?? '');
  const { ref, fallbackRef } = getActiveRefs(ctx);

  const builder = new RangeSetBuilder<Decoration>();
  let lastScannedLineFrom = -1;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (line.from <= lastScannedLineFrom) {
        pos = line.to + 1;
        continue;
      }
      lastScannedLineFrom = line.from;

      IMAGE_EMBED_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = IMAGE_EMBED_RE.exec(line.text)) !== null) {
        const matchStart = line.from + match.index;
        const matchEnd = matchStart + match[0].length;

        if (selectionOverlapsRange(view, matchStart, matchEnd) || isInsideCodeContext(view, matchStart)) {
          continue;
        }

        const isWikilink = match[1] !== undefined;
        const rawTarget = isWikilink ? match[1] : (match[3] ?? match[4] ?? '');
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

        let alt = parsed.alt ?? '';
        let width = parsed.width;
        if (!isWikilink) {
          const mdAlt = parseMarkdownAlt(match[2] ?? '');
          alt = mdAlt.alt;
          if (width === undefined) {
            width = mdAlt.width;
          }
        }

        const widget = new RemoteImageWidget(resolved, ref, fallbackRef, alt, width, getContext);
        builder.add(matchStart, matchEnd, Decoration.replace({ widget }));
      }

      pos = line.to + 1;
    }
  }

  return builder.finish();
}

/**
 * Creates a CodeMirror 6 `ViewPlugin` extension that renders remote-only GitLab
 * image embeds inline in Live Preview when the cursor is outside the embed syntax.
 */
export function createLivePreviewImageExtension(getContext: () => ImageRenderContext): Extension {
  return Prec.highest(
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        private readonly view: EditorView;
        private readonly domEmbedCleanups = new Map<HTMLElement, () => void>();
        private readonly observer: MutationObserver | null;

        constructor(view: EditorView) {
          this.view = view;
          this.decorations = buildDecorations(view, getContext);
          this.observer =
            typeof MutationObserver === 'function'
              ? new MutationObserver(() => this.syncBuiltInEmbeds())
              : null;
          this.observer?.observe(view.contentDOM, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'data-src'],
          });
          this.syncBuiltInEmbeds();
        }

        update(update: ViewUpdate): void {
          const livePreviewChanged =
            update.startState.field(editorLivePreviewField, false) !==
            update.state.field(editorLivePreviewField, false);
          const refreshRequested = update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(refreshRemoteImagesEffect)),
          );

          if (
            update.docChanged ||
            update.viewportChanged ||
            update.selectionSet ||
            livePreviewChanged ||
            refreshRequested
          ) {
            this.decorations = buildDecorations(update.view, getContext);
            this.syncBuiltInEmbeds();
          }
        }

        destroy(): void {
          this.observer?.disconnect();
          this.clearDomEmbedCleanups();
        }

        private clearDomEmbedCleanups(): void {
          for (const cleanup of this.domEmbedCleanups.values()) {
            cleanup();
          }
          this.domEmbedCleanups.clear();
        }

        private syncBuiltInEmbeds(): void {
          for (const [el, cleanup] of Array.from(this.domEmbedCleanups.entries())) {
            if (!el.isConnected) {
              cleanup();
              this.domEmbedCleanups.delete(el);
            }
          }

          const ctx = getContext();
          if (!ctx.isEnabled() || this.view.state.field(editorLivePreviewField, false) === false) {
            this.clearDomEmbedCleanups();
            return;
          }

          const fileInfo = this.view.state.field(editorInfoField, false);
          const noteDir = getNoteDir(fileInfo?.file?.path ?? '');

          const embeds = this.view.contentDOM.querySelectorAll<HTMLElement>('.internal-embed');
          for (const embedEl of Array.from(embeds)) {
            const cleanup = hydrateRemoteEmbed(embedEl, noteDir, ctx);
            if (cleanup) {
              this.domEmbedCleanups.get(embedEl)?.();
              this.domEmbedCleanups.set(embedEl, cleanup);
            }
          }
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
      },
    ),
  );
}
