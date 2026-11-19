import type { GitLabClient } from '../gitlab/client';
import { normalizeVaultPath } from '../utils/paths';

export interface BlobUrlApi {
  createObjectURL(b: Blob): string;
  revokeObjectURL(url: string): void;
}

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

interface QueuedLoadTask {
  cancelled: boolean;
  blobUrl: string | null;
  run: () => Promise<void>;
}

/**
 * Fetches GitLab repository images on demand into memory-backed `blob:` URLs
 * with bounded concurrency, optional IntersectionObserver lazy loading, and leak-free cleanup.
 */
export class OnDemandImageLoader {
  private readonly client: Pick<GitLabClient, 'getRawBinary'>;
  private readonly blobApi: BlobUrlApi;
  private readonly maxConcurrent: number;
  private readonly maxMemoryImages: number;
  private readonly queue: QueuedLoadTask[] = [];
  private readonly activeUrls = new Set<string>();
  private readonly memoryImages = new Map<string, string>();
  private readonly activeCleanups = new Set<() => void>();
  private activeCount = 0;

  constructor(
    client: Pick<GitLabClient, 'getRawBinary'>,
    blobApi: BlobUrlApi = globalThis.URL,
    maxConcurrent = 3,
    maxMemoryImages = 20,
  ) {
    this.client = client;
    this.blobApi = blobApi;
    const validConcurrent = Number.isFinite(maxConcurrent) ? maxConcurrent : 3;
    this.maxConcurrent = Math.max(1, Math.floor(validConcurrent));
    const validMemoryImages = Number.isFinite(maxMemoryImages) ? maxMemoryImages : 20;
    this.maxMemoryImages = Math.max(1, Math.floor(validMemoryImages));
  }

  /**
   * Queues an immediate fetch for `repoPath` at `ref` (with optional `fallbackRef` if `ref` fails),
   * binds the resulting `blob:` URL to `imgEl.src`, and returns a cleanup callback.
   */
  loadIntoElement(
    imgEl: HTMLImageElement,
    repoPath: string,
    ref: string,
    fallbackRef?: string,
  ): () => void {
    const cacheKey = normalizeVaultPath(repoPath);
    const cachedUrl = this.memoryImages.get(cacheKey);
    if (cachedUrl) {
      this.memoryImages.delete(cacheKey);
      this.memoryImages.set(cacheKey, cachedUrl);
      this.applyLoadedUrl(imgEl, repoPath, cachedUrl);
      return () => {};
    }

    if (imgEl.dataset) {
      imgEl.dataset.gitlabSrc = repoPath;
    }
    imgEl.classList?.add('gitlab-img-loading');

    const task: QueuedLoadTask = {
      cancelled: false,
      blobUrl: null,
      run: async () => {
        try {
          let buffer: ArrayBuffer;
          try {
            buffer = await this.client.getRawBinary(repoPath, ref);
          } catch (primaryErr) {
            if (task.cancelled) {
              return;
            }
            if (fallbackRef && fallbackRef !== ref) {
              buffer = await this.client.getRawBinary(repoPath, fallbackRef);
            } else {
              throw primaryErr;
            }
          }
          if (task.cancelled) {
            return;
          }

          const blob = new Blob([buffer], { type: inferMimeType(repoPath) });
          const url = this.blobApi.createObjectURL(blob);
          if (task.cancelled) {
            this.blobApi.revokeObjectURL(url);
            return;
          }

          task.blobUrl = url;
          this.activeUrls.add(url);
          this.applyLoadedUrl(imgEl, repoPath, url);
        } catch (err) {
          if (!task.cancelled) {
            imgEl.classList?.remove('gitlab-img-loading');
            imgEl.classList?.add('gitlab-img-error');
            if (imgEl.dataset) {
              imgEl.dataset.gitlabError = err instanceof Error ? err.message : String(err);
            }
          }
        }
      },
    };

    const cleanup = (): void => {
      if (task.cancelled) {
        return;
      }
      task.cancelled = true;
      this.activeCleanups.delete(cleanup);

      const queueIdx = this.queue.indexOf(task);
      if (queueIdx >= 0) {
        this.queue.splice(queueIdx, 1);
      }

      imgEl.classList?.remove('gitlab-img-loading');
      if (task.blobUrl) {
        this.revokeUrl(task.blobUrl);
        task.blobUrl = null;
      }
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

    const observer = new ObserverCtor((entries) => {
      if (disposed) {
        return;
      }
      for (const entry of entries) {
        const matchesTarget = !entry.target || entry.target === imgEl;
        const visible = entry.isIntersecting || (entry.intersectionRatio ?? 0) > 0;
        if (matchesTarget && visible) {
          observer.disconnect();
          if (!loadCleanup) {
            loadCleanup = this.loadIntoElement(imgEl, repoPath, ref, fallbackRef);
          }
          break;
        }
      }
    });

    const cleanup = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      this.activeCleanups.delete(cleanup);
      observer.disconnect();
      loadCleanup?.();
      loadCleanup = null;
    };

    this.activeCleanups.add(cleanup);
    observer.observe(imgEl);
    return cleanup;
  }

  /**
   * Registers an in-memory `Blob` (e.g., from a paste upload) for immediate display
   * without writing anything to disk.
   */
  registerMemoryImage(repoPath: string, blob: Blob): string {
    const cacheKey = normalizeVaultPath(repoPath);
    const previousUrl = this.memoryImages.get(cacheKey);
    if (previousUrl) {
      this.memoryImages.delete(cacheKey);
      this.revokeUrl(previousUrl);
    }

    const url = this.blobApi.createObjectURL(blob);
    this.memoryImages.set(cacheKey, url);
    this.activeUrls.add(url);

    while (this.memoryImages.size > this.maxMemoryImages) {
      const oldestKey = this.memoryImages.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldestUrl = this.memoryImages.get(oldestKey);
      this.memoryImages.delete(oldestKey);
      if (oldestUrl) {
        this.revokeUrl(oldestUrl);
      }
    }

    return url;
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

  private applyLoadedUrl(imgEl: HTMLImageElement, repoPath: string, url: string): void {
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
