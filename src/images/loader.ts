import { setIcon } from 'obsidian';
import type { RemoteGitClient } from '../types';
import { normalizeVaultPath } from '../utils/paths';

export interface BlobUrlApi {
  createObjectURL(b: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface ImageCacheOptions {
  isPersistentCacheEnabled?: () => boolean;
  getMaxCacheBytes?: () => number;
}

const PERSISTENT_CACHE_NAME = 'gitlab-ondemand-sync-images-v1';
const CACHE_KEY_ORIGIN = 'https://git-ondemand-sync.local/img';
const DEFAULT_MAX_CACHE_BYTES = 50 * 1024 * 1024;

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

const DEFAULT_MIME_TYPE = 'application/octet-stream';

function inferMimeType(repoPath: string): string {
  const withoutQuery = repoPath.split(/[?#]/, 1)[0] ?? '';
  const normalized = normalizeVaultPath(withoutQuery);
  const lastSlash = normalized.lastIndexOf('/');
  const baseName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return DEFAULT_MIME_TYPE;
  }
  const ext = baseName.slice(dotIndex).toLowerCase();
  return MIME_TYPES_BY_EXTENSION[ext] ?? DEFAULT_MIME_TYPE;
}

function buildCacheRequestKey(cacheKey: string, ref: string): string {
  return `${CACHE_KEY_ORIGIN}?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(cacheKey)}`;
}

interface MemoryCacheEntry {
  url: string;
  ref?: string;
}

interface QueuedLoadTask {
  cancelled: boolean;
  run: () => Promise<void>;
}

/**
 * Fetches repository images on demand into memory-backed `blob:` URLs with two-tier caching
 * (in-memory LRU + bounded Web Cache API), bounded concurrency, lazy observation, and inline Reload UI.
 */
export class OnDemandImageLoader {
  private readonly client: Pick<RemoteGitClient, 'getRawBinary'>;
  private readonly blobApi: BlobUrlApi;
  private readonly maxConcurrent: number;
  private readonly maxMemoryImages: number;
  private readonly cacheOptions?: ImageCacheOptions;
  private readonly queue: QueuedLoadTask[] = [];
  private readonly activeUrls = new Set<string>();
  private readonly memoryImages = new Map<string, MemoryCacheEntry>();
  private readonly activeCleanups = new Set<() => void>();
  private readonly errorBoxes = new WeakMap<HTMLImageElement, HTMLElement>();
  private readonly imgErrorCleanups = new WeakMap<HTMLImageElement, () => void>();
  private activeCount = 0;

  constructor(
    client: Pick<RemoteGitClient, 'getRawBinary'>,
    blobApi: BlobUrlApi = globalThis.URL,
    maxConcurrent = 3,
    maxMemoryImages = 150,
    cacheOptions?: ImageCacheOptions,
  ) {
    this.client = client;
    this.blobApi = blobApi;
    const validConcurrent = Number.isFinite(maxConcurrent) ? maxConcurrent : 3;
    this.maxConcurrent = Math.max(1, Math.floor(validConcurrent));
    const validMemoryImages = Number.isFinite(maxMemoryImages) ? maxMemoryImages : 50;
    this.maxMemoryImages = Math.max(1, Math.floor(validMemoryImages));
    this.cacheOptions = cacheOptions;
  }

  /**
   * Queues an immediate fetch for `repoPath` at `ref` (with optional `fallbackRef` if `ref` fails),
   * checks Tier 1 memory LRU and Tier 2 persistent cache first, and returns a cleanup callback.
   */
  loadIntoElement(
    imgEl: HTMLImageElement,
    repoPath: string,
    ref: string,
    fallbackRef?: string,
  ): () => void {
    const cacheKey = normalizeVaultPath(repoPath);
    let disposed = false;
    let retryCleanup: (() => void) | null = null;

    const handleDecodeError = (failedUrl: string): void => {
      if (disposed) {
        return;
      }
      const entry = this.memoryImages.get(cacheKey);
      if (entry?.url === failedUrl) {
        this.memoryImages.delete(cacheKey);
      }
      this.revokeUrl(failedUrl);
      imgEl.classList?.remove('gitlab-img-loading', 'gitlab-img-loaded');
      imgEl.classList?.add('gitlab-img-error');
      if (imgEl.dataset) {
        imgEl.dataset.gitlabError = 'Failed to decode image';
      }
      this.renderStatusBox(imgEl, 'Failed to load image', true, () => {
        if (disposed) {
          return;
        }
        this.removeErrorBox(imgEl);
        imgEl.classList?.remove('gitlab-img-error');
        imgEl.classList?.add('gitlab-img-loading');
        if (imgEl.dataset) {
          delete imgEl.dataset.gitlabError;
        }
        retryCleanup = this.loadIntoElement(imgEl, repoPath, ref, fallbackRef);
      });
    };

    const cached = this.findTier1Hit(cacheKey, ref, fallbackRef);
    if (cached) {
      this.applyLoadedUrl(imgEl, repoPath, cached.url, () => handleDecodeError(cached.url));
      return () => {
        disposed = true;
        this.imgErrorCleanups.get(imgEl)?.();
        this.imgErrorCleanups.delete(imgEl);
        this.removeErrorBox(imgEl);
        retryCleanup?.();
        retryCleanup = null;
      };
    }

    if (imgEl.dataset) {
      imgEl.dataset.gitlabSrc = repoPath;
    }
    imgEl.classList?.add('gitlab-img-loading');

    const triggerReload = (): void => {
      if (task.cancelled) {
        return;
      }
      task.cancelled = true;
      const queueIdx = this.queue.indexOf(task);
      if (queueIdx >= 0) {
        this.queue.splice(queueIdx, 1);
      }
      this.removeErrorBox(imgEl);
      imgEl.classList?.remove('gitlab-img-error');
      imgEl.classList?.add('gitlab-img-loading');
      if (imgEl.dataset) {
        delete imgEl.dataset.gitlabError;
      }
      retryCleanup = this.loadIntoElement(imgEl, repoPath, ref, fallbackRef);
    };

    this.renderStatusBox(imgEl, 'Loading image...', false, triggerReload);

    const task: QueuedLoadTask = {
      cancelled: false,
      run: async () => {
        try {
          const existingHit = this.findTier1Hit(cacheKey, ref, fallbackRef);
          if (existingHit) {
            this.applyLoadedUrl(imgEl, repoPath, existingHit.url, () =>
              handleDecodeError(existingHit.url),
            );
            return;
          }

          if (this.isPersistentCacheActive()) {
            const tier2Hit = await this.tryLoadFromPersistentCache(cacheKey, ref, fallbackRef);
            if (task.cancelled) {
              return;
            }
            if (tier2Hit) {
              const blob = new Blob([tier2Hit.buffer], { type: inferMimeType(repoPath) });
              const url = this.blobApi.createObjectURL(blob);
              if (task.cancelled) {
                this.blobApi.revokeObjectURL(url);
                return;
              }
              this.storeMemoryImage(cacheKey, url, tier2Hit.ref);
              this.applyLoadedUrl(imgEl, repoPath, url, () => handleDecodeError(url));
              return;
            }
          }

          let buffer: ArrayBuffer;
          let usedRef = ref;
          try {
            buffer = await this.client.getRawBinary(repoPath, ref);
          } catch (primaryErr) {
            if (task.cancelled) {
              return;
            }
            if (fallbackRef && fallbackRef !== ref) {
              usedRef = fallbackRef;
              buffer = await this.client.getRawBinary(repoPath, fallbackRef);
            } else {
              throw primaryErr;
            }
          }
          if (task.cancelled) {
            return;
          }

          const mimeType = inferMimeType(repoPath);
          const blob = new Blob([buffer], { type: mimeType });
          const url = this.blobApi.createObjectURL(blob);
          if (task.cancelled) {
            this.blobApi.revokeObjectURL(url);
            return;
          }

          this.storeMemoryImage(cacheKey, url, usedRef);
          this.applyLoadedUrl(imgEl, repoPath, url, () => handleDecodeError(url));
          void this.writePersistentCache(cacheKey, usedRef, buffer, mimeType);
        } catch (err) {
          if (!task.cancelled) {
            imgEl.classList?.remove('gitlab-img-loading');
            imgEl.classList?.add('gitlab-img-error');
            if (imgEl.dataset) {
              imgEl.dataset.gitlabError = err instanceof Error ? err.message : String(err);
            }
            this.renderStatusBox(imgEl, 'Failed to load image', true, triggerReload);
          }
        }
      },
    };

    const cleanup = (): void => {
      if (task.cancelled) {
        return;
      }
      disposed = true;
      task.cancelled = true;
      this.activeCleanups.delete(cleanup);

      const queueIdx = this.queue.indexOf(task);
      if (queueIdx >= 0) {
        this.queue.splice(queueIdx, 1);
      }

      imgEl.classList?.remove('gitlab-img-loading');
      this.imgErrorCleanups.get(imgEl)?.();
      this.imgErrorCleanups.delete(imgEl);
      this.removeErrorBox(imgEl);
      retryCleanup?.();
      retryCleanup = null;
    };

    this.activeCleanups.add(cleanup);
    this.queue.push(task);
    this.drainQueue();
    return cleanup;
  }

  /**
   * Lazily loads `repoPath` when `imgEl` enters the viewport via `IntersectionObserver`,
   * falling back to immediate loading when `IntersectionObserver` is unavailable.
   */
  observeAndLoad(
    imgEl: HTMLImageElement,
    repoPath: string,
    ref: string,
    fallbackRef?: string,
  ): () => void {
    const ObserverCtor = globalThis.IntersectionObserver;
    if (typeof ObserverCtor !== 'function') {
      return this.loadIntoElement(imgEl, repoPath, ref, fallbackRef);
    }

    let disposed = false;
    let loadCleanup: (() => void) | null = null;
    imgEl.classList?.add('gitlab-img-loading');

    const startLoad = (): void => {
      if (disposed || loadCleanup) {
        return;
      }
      observer.disconnect();
      loadCleanup = this.loadIntoElement(imgEl, repoPath, ref, fallbackRef);
    };

    const statusBox = this.renderStatusBox(imgEl, 'Loading image...', false, startLoad);
    const observeTarget = statusBox ?? imgEl;

    const observer = new ObserverCtor(
      (entries) => {
        if (disposed) {
          return;
        }
        for (const entry of entries) {
          const matchesTarget = !entry.target || entry.target === observeTarget;
          const visible = entry.isIntersecting || (entry.intersectionRatio ?? 0) > 0;
          if (matchesTarget && visible) {
            startLoad();
            break;
          }
        }
      },
      { rootMargin: '200px 0px' },
    );

    const cleanup = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      this.activeCleanups.delete(cleanup);
      imgEl.classList?.remove('gitlab-img-loading');
      this.removeErrorBox(imgEl);
      observer.disconnect();
      loadCleanup?.();
      loadCleanup = null;
    };

    this.activeCleanups.add(cleanup);
    observer.observe(observeTarget);
    return cleanup;
  }

  /**
   * Registers an in-memory `Blob` (e.g., from a paste upload) for immediate display
   * without writing anything to disk.
   */
  registerMemoryImage(repoPath: string, blob: Blob): string {
    const cacheKey = normalizeVaultPath(repoPath);
    const url = this.blobApi.createObjectURL(blob);
    this.storeMemoryImage(cacheKey, url, undefined);
    return url;
  }

  /**
   * Clears both Tier 1 in-memory `blob:` URLs and Tier 2 persistent CacheStorage entries.
   */
  async clearCache(): Promise<void> {
    for (const entry of Array.from(this.memoryImages.values())) {
      this.revokeUrl(entry.url);
    }
    this.memoryImages.clear();

    if (typeof globalThis.caches?.delete === 'function') {
      try {
        await globalThis.caches.delete(PERSISTENT_CACHE_NAME);
      } catch {
        // Ignore storage errors when clearing cache
      }
    }
  }

  /**
   * Cancels all pending/in-flight loads, disconnects observers, and revokes all active `blob:` URLs.
   */
  revokeAll(): void {
    for (const cleanup of Array.from(this.activeCleanups)) {
      cleanup();
    }
    this.activeCleanups.clear();
    this.queue.length = 0;

    for (const url of Array.from(this.activeUrls)) {
      this.revokeUrl(url);
    }
    this.memoryImages.clear();
  }

  private findTier1Hit(
    cacheKey: string,
    ref: string,
    fallbackRef?: string,
  ): MemoryCacheEntry | null {
    const cached = this.memoryImages.get(cacheKey);
    if (
      !cached ||
      (cached.ref !== undefined &&
        cached.ref !== ref &&
        (fallbackRef === undefined || cached.ref !== fallbackRef))
    ) {
      return null;
    }
    this.memoryImages.delete(cacheKey);
    this.memoryImages.set(cacheKey, cached);
    return cached;
  }

  private storeMemoryImage(cacheKey: string, url: string, ref?: string): void {
    const previous = this.memoryImages.get(cacheKey);
    if (previous) {
      this.memoryImages.delete(cacheKey);
      if (previous.url !== url) {
        this.revokeUrl(previous.url);
      }
    }

    this.memoryImages.set(cacheKey, { url, ref });
    this.activeUrls.add(url);

    while (this.memoryImages.size > this.maxMemoryImages) {
      const oldestKey = this.memoryImages.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldestEntry = this.memoryImages.get(oldestKey);
      this.memoryImages.delete(oldestKey);
      if (oldestEntry) {
        this.revokeUrl(oldestEntry.url);
      }
    }
  }

  private isPersistentCacheActive(): boolean {
    return (
      Boolean(this.cacheOptions?.isPersistentCacheEnabled?.()) &&
      typeof globalThis.caches?.open === 'function'
    );
  }

  private getMaxCacheBytes(): number {
    const raw = this.cacheOptions?.getMaxCacheBytes?.();
    if (raw === undefined || !Number.isFinite(raw)) {
      return DEFAULT_MAX_CACHE_BYTES;
    }
    return Math.max(0, raw);
  }

  private async tryLoadFromPersistentCache(
    cacheKey: string,
    ref: string,
    fallbackRef?: string,
  ): Promise<{ buffer: ArrayBuffer; ref: string } | null> {
    if (!this.isPersistentCacheActive()) {
      return null;
    }
    try {
      const cache = await globalThis.caches.open(PERSISTENT_CACHE_NAME);
      const candidates =
        fallbackRef && fallbackRef !== ref ? [ref, fallbackRef] : [ref];
      for (const candidateRef of candidates) {
        const reqKey = buildCacheRequestKey(cacheKey, candidateRef);
        const match = await cache.match(reqKey);
        if (match) {
          const buffer = await match.arrayBuffer();
          const mimeType = match.headers.get('Content-Type') ?? inferMimeType(cacheKey);
          void this.putCacheEntry(cache, reqKey, buffer, mimeType);
          return { buffer, ref: candidateRef };
        }
      }
    } catch {
      // Never block or fail image loading when CacheStorage is unavailable or throws
    }
    return null;
  }

  private async writePersistentCache(
    cacheKey: string,
    ref: string,
    buffer: ArrayBuffer,
    mimeType: string,
  ): Promise<void> {
    if (!this.isPersistentCacheActive()) {
      return;
    }
    try {
      const cache = await globalThis.caches.open(PERSISTENT_CACHE_NAME);
      const reqKey = buildCacheRequestKey(cacheKey, ref);
      await this.putCacheEntry(cache, reqKey, buffer, mimeType);
      await this.evictPersistentCache(cache);
    } catch {
      // Ignore quota or storage failures
    }
  }

  private async putCacheEntry(
    cache: Cache,
    reqKey: string,
    buffer: ArrayBuffer,
    mimeType: string,
  ): Promise<void> {
    try {
      const response = new Response(buffer, {
        headers: {
          'Content-Type': mimeType,
          'X-Cached-At': String(Date.now()),
          'X-Byte-Length': String(buffer.byteLength),
        },
      });
      await cache.put(reqKey, response);
    } catch {
      // Ignore quota or storage failures
    }
  }

  private async evictPersistentCache(cache: Cache): Promise<void> {
    const maxBytes = this.getMaxCacheBytes();
    const keys = await cache.keys();
    const entries: Array<{ key: Request; cachedAt: number; bytes: number }> = [];
    let totalBytes = 0;

    for (const key of keys) {
      const res = await cache.match(key);
      if (!res) {
        continue;
      }
      const rawBytes = Number(res.headers.get('X-Byte-Length'));
      const bytes = Number.isFinite(rawBytes) && rawBytes >= 0 ? rawBytes : 0;
      const rawCachedAt = Number(res.headers.get('X-Cached-At'));
      const cachedAt = Number.isFinite(rawCachedAt) ? rawCachedAt : 0;
      entries.push({ key, cachedAt, bytes });
      totalBytes += bytes;
    }

    if (totalBytes <= maxBytes) {
      return;
    }

    entries.sort((a, b) => a.cachedAt - b.cachedAt);
    for (const entry of entries) {
      if (totalBytes <= maxBytes) {
        break;
      }
      await cache.delete(entry.key);
      totalBytes -= entry.bytes;
    }
  }

  private renderStatusBox(
    imgEl: HTMLImageElement,
    message: string,
    isError: boolean,
    onReload: () => void,
  ): HTMLElement | null {
    if (typeof document === 'undefined' || !imgEl.parentElement) {
      return null;
    }

    this.removeErrorBox(imgEl);
    imgEl.classList?.add('gitlab-img-hidden');

    const box = document.createElement('div');
    box.className = isError ? 'gitlab-img-error-box' : 'gitlab-img-status-box';

    const textEl = document.createElement('span');
    textEl.className = 'gitlab-img-error-text';
    textEl.textContent = message;
    box.appendChild(textEl);

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'gitlab-img-reload-btn';

    if (typeof setIcon === 'function') {
      const iconEl = document.createElement('span');
      iconEl.className = 'gitlab-img-reload-icon';
      setIcon(iconEl, 'rotate-cw');
      reloadBtn.appendChild(iconEl);
    }

    const labelEl = document.createElement('span');
    labelEl.textContent = 'Reload';
    reloadBtn.appendChild(labelEl);

    const stopEditorPointer = (ev: Event): void => {
      ev.stopPropagation();
    };
    reloadBtn.addEventListener('mousedown', stopEditorPointer);
    reloadBtn.addEventListener('touchstart', stopEditorPointer);
    reloadBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onReload();
    });
    box.appendChild(reloadBtn);

    if (typeof imgEl.after === 'function') {
      imgEl.after(box);
    } else {
      imgEl.parentElement.appendChild(box);
    }
    this.errorBoxes.set(imgEl, box);
    return box;
  }

  private removeErrorBox(imgEl: HTMLImageElement): void {
    const existing = this.errorBoxes.get(imgEl);
    if (existing) {
      existing.remove();
      this.errorBoxes.delete(imgEl);
    }
    imgEl.classList?.remove('gitlab-img-hidden');
  }

  private applyLoadedUrl(
    imgEl: HTMLImageElement,
    repoPath: string,
    url: string,
    onDecodeError?: () => void,
  ): void {
    this.imgErrorCleanups.get(imgEl)?.();
    this.imgErrorCleanups.delete(imgEl);
    this.removeErrorBox(imgEl);

    if (onDecodeError && typeof imgEl.addEventListener === 'function') {
      const handleError = (): void => {
        this.imgErrorCleanups.delete(imgEl);
        onDecodeError();
      };
      const handleLoad = (): void => {
        this.imgErrorCleanups.delete(imgEl);
        imgEl.removeEventListener?.('error', handleError);
      };
      imgEl.addEventListener('error', handleError, { once: true });
      imgEl.addEventListener('load', handleLoad, { once: true });
      this.imgErrorCleanups.set(imgEl, () => {
        imgEl.removeEventListener?.('error', handleError);
        imgEl.removeEventListener?.('load', handleLoad);
      });
    }

    imgEl.src = url;
    if (imgEl.dataset) {
      imgEl.dataset.gitlabSrc = repoPath;
    }
    imgEl.classList?.remove('gitlab-img-loading', 'gitlab-img-error');
    imgEl.classList?.add('gitlab-img-loaded');
  }

  private revokeUrl(url: string): void {
    if (this.activeUrls.has(url)) {
      this.activeUrls.delete(url);
      this.blobApi.revokeObjectURL(url);
    }
  }

  private drainQueue(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      if (task.cancelled) {
        continue;
      }
      this.activeCount++;
      void task.run().finally(() => {
        this.activeCount--;
        this.drainQueue();
      });
    }
  }
}
