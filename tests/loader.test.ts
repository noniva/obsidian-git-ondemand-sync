import { describe, it, expect, vi, afterEach } from 'vitest';
import { OnDemandImageLoader } from '../src/images/loader';

function createMockImg(): HTMLImageElement {
  return {
    src: '',
    dataset: {} as Record<string, string>,
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
    },
  } as unknown as HTMLImageElement;
}

describe('OnDemandImageLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches image bytes, creates blob URL, and revokes on cleanup', async () => {
    const client = { getRawBinary: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer) } as any;
    const blobApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:mock-1'),
      revokeObjectURL: vi.fn(),
    };
    const imgEl = createMockImg();
    const loader = new OnDemandImageLoader(client, blobApi, 3);
    const cleanup = loader.loadIntoElement(imgEl, 'attachments/pic.png', 'main');
    await vi.waitFor(() => expect(imgEl.src).toBe('blob:mock-1'));

    expect(client.getRawBinary).toHaveBeenCalledWith('attachments/pic.png', 'main');
    const createdBlob = blobApi.createObjectURL.mock.calls[0][0] as Blob;
    expect(createdBlob.type).toBe('image/png');

    cleanup();
    expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  it('revokes blob URL if cleanup is called while fetch is still in flight', async () => {
    let resolveFetch!: (buf: ArrayBuffer) => void;
    const client = {
      getRawBinary: vi.fn().mockReturnValue(
        new Promise<ArrayBuffer>((r) => {
          resolveFetch = r;
        }),
      ),
    } as any;
    const blobApi = { createObjectURL: vi.fn().mockReturnValue('blob:late'), revokeObjectURL: vi.fn() };
    const imgEl = createMockImg();

    const loader = new OnDemandImageLoader(client, blobApi, 3);
    const cleanup = loader.loadIntoElement(imgEl, 'attachments/late.png', 'main');
    cleanup(); // User closed note before fetch finished

    resolveFetch(new Uint8Array([9]).buffer);
    await new Promise((r) => setTimeout(r, 10));
    expect(imgEl.src).toBe('');
    expect(blobApi.createObjectURL).not.toHaveBeenCalled();
  });

  it('enforces bounded concurrency and skips queued items cancelled before starting', async () => {
    const resolvers = new Map<string, (buf: ArrayBuffer) => void>();
    let inFlight = 0;
    let maxInFlight = 0;

    const client = {
      getRawBinary: vi.fn((path: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<ArrayBuffer>((resolve) => {
          resolvers.set(path, (buf) => {
            inFlight--;
            resolve(buf);
          });
        });
      }),
    } as any;

    let counter = 0;
    const blobApi = {
      createObjectURL: vi.fn(() => `blob:img-${++counter}`),
      revokeObjectURL: vi.fn(),
    };

    const loader = new OnDemandImageLoader(client, blobApi, 3);
    const imgs = Array.from({ length: 6 }, () => createMockImg());
    const cleanups = imgs.map((img, idx) =>
      loader.loadIntoElement(img, `attachments/${idx}.jpg`, 'main'),
    );

    // Only 3 should be running initially
    expect(client.getRawBinary).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(3);

    // Cancel queued item #4 before it starts fetching
    cleanups[4]();

    // Finish first batch
    resolvers.get('attachments/0.jpg')!(new Uint8Array([1]).buffer);
    resolvers.get('attachments/1.jpg')!(new Uint8Array([2]).buffer);
    resolvers.get('attachments/2.jpg')!(new Uint8Array([3]).buffer);

    await vi.waitFor(() => expect(client.getRawBinary).toHaveBeenCalledTimes(5));
    // Item 4 was cancelled while queued, so only 0,1,2,3,5 should have been fetched
    expect(client.getRawBinary).not.toHaveBeenCalledWith('attachments/4.jpg', 'main');

    resolvers.get('attachments/3.jpg')!(new Uint8Array([4]).buffer);
    resolvers.get('attachments/5.jpg')!(new Uint8Array([6]).buffer);

    await vi.waitFor(() => expect(imgs[3].src).not.toBe(''));
    await vi.waitFor(() => expect(imgs[5].src).not.toBe(''));
    expect(maxInFlight).toBe(3);
  });

  it('infers MIME types from common image extensions', async () => {
    const client = { getRawBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer) } as any;
    const createdTypes: string[] = [];
    const blobApi = {
      createObjectURL: vi.fn((blob: Blob) => {
        createdTypes.push(blob.type);
        return `blob:${createdTypes.length}`;
      }),
      revokeObjectURL: vi.fn(),
    };

    const loader = new OnDemandImageLoader(client, blobApi, 10);
    const paths = [
      'a.png',
      'b.JPG',
      'c.jpeg',
      'd.gif',
      'e.webp',
      'f.svg',
      'g.bmp',
      'h.avif',
      'i.heic',
      'j.unknown',
    ];

    const imgs = paths.map(() => createMockImg());
    paths.forEach((p, idx) => loader.loadIntoElement(imgs[idx], p, 'main'));

    await vi.waitFor(() => expect(createdTypes).toHaveLength(paths.length));
    expect(createdTypes).toEqual([
      'image/png',
      'image/jpeg',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'image/bmp',
      'image/avif',
      'image/heic',
      'application/octet-stream',
    ]);
  });

  it('observeAndLoad uses IntersectionObserver when available and defers load until intersecting', async () => {
    let observerCallback!: (entries: IntersectionObserverEntry[]) => void;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const unobserve = vi.fn();

    class MockIntersectionObserver {
      constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
        observerCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = unobserve;
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

    const client = { getRawBinary: vi.fn().mockResolvedValue(new Uint8Array([5]).buffer) } as any;
    const blobApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:observed'),
      revokeObjectURL: vi.fn(),
    };
    const imgEl = createMockImg();
    const loader = new OnDemandImageLoader(client, blobApi, 3);

    const cleanup = loader.observeAndLoad(imgEl, 'attachments/lazy.webp', 'main');
    expect(observe).toHaveBeenCalledWith(imgEl);
    expect(client.getRawBinary).not.toHaveBeenCalled();

    // Non-intersecting entry does not trigger load
    observerCallback([{ target: imgEl, isIntersecting: false } as unknown as IntersectionObserverEntry]);
    expect(client.getRawBinary).not.toHaveBeenCalled();

    // Intersecting entry triggers load and disconnects observer
    observerCallback([{ target: imgEl, isIntersecting: true } as unknown as IntersectionObserverEntry]);
    expect(disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(imgEl.src).toBe('blob:observed'));

    cleanup();
    expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:observed');
  });

  it('observeAndLoad cancels observation if cleaned up before intersecting and falls back when absent', async () => {
    const disconnect = vi.fn();
    class MockIntersectionObserver {
      constructor(_cb: (entries: IntersectionObserverEntry[]) => void) {}
      observe = vi.fn();
      disconnect = disconnect;
      unobserve = vi.fn();
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

    const client = { getRawBinary: vi.fn().mockResolvedValue(new Uint8Array([7]).buffer) } as any;
    const blobApi = { createObjectURL: vi.fn().mockReturnValue('blob:fallback'), revokeObjectURL: vi.fn() };
    const loader = new OnDemandImageLoader(client, blobApi, 3);

    const img1 = createMockImg();
    const cleanup1 = loader.observeAndLoad(img1, 'attachments/never-seen.png', 'main');
    cleanup1();
    expect(disconnect).toHaveBeenCalled();
    expect(client.getRawBinary).not.toHaveBeenCalled();

    // Now test fallback when IntersectionObserver is unavailable
    vi.stubGlobal('IntersectionObserver', undefined);
    const img2 = createMockImg();
    loader.observeAndLoad(img2, 'attachments/immediate.png', 'main');
    await vi.waitFor(() => expect(img2.src).toBe('blob:fallback'));
    expect(client.getRawBinary).toHaveBeenCalledTimes(1);
  });

  it('registerMemoryImage caches blob URLs without fetching and revokeAll revokes everything', async () => {
    let resolveInFlight!: (buf: ArrayBuffer) => void;
    const client = {
      getRawBinary: vi.fn().mockReturnValue(
        new Promise<ArrayBuffer>((r) => {
          resolveInFlight = r;
        }),
      ),
    } as any;

    let seq = 0;
    const blobApi = {
      createObjectURL: vi.fn(() => `blob:mem-${++seq}`),
      revokeObjectURL: vi.fn(),
    };

    const loader = new OnDemandImageLoader(client, blobApi, 3);
    const pastedBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const url1 = loader.registerMemoryImage('attachments/pasted.png', pastedBlob);
    expect(url1).toBe('blob:mem-1');

    // Re-registering same path revokes previous URL
    const url2 = loader.registerMemoryImage('attachments/pasted.png', pastedBlob);
    expect(url2).toBe('blob:mem-2');
    expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:mem-1');

    // loadIntoElement uses memory image immediately without network call
    const memImg = createMockImg();
    const memCleanup = loader.loadIntoElement(memImg, 'attachments/pasted.png', 'main');
    expect(memImg.src).toBe('blob:mem-2');
    expect(client.getRawBinary).not.toHaveBeenCalled();
    memCleanup();

    // Start an in-flight network load, then revokeAll()
    const netImg = createMockImg();
    loader.loadIntoElement(netImg, 'attachments/remote.png', 'main');
    loader.revokeAll();

    expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:mem-2');

    // Resolving in-flight request after revokeAll must not create a blob URL
    resolveInFlight(new Uint8Array([8]).buffer);
    await new Promise((r) => setTimeout(r, 10));
    expect(netImg.src).toBe('');
    expect(blobApi.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('handles fetch errors without crashing and releases concurrency slot', async () => {
    const client = {
      getRawBinary: vi
        .fn()
        .mockRejectedValueOnce(new Error('404 Not Found'))
        .mockResolvedValueOnce(new Uint8Array([42]).buffer),
    } as any;
    const blobApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:ok'),
      revokeObjectURL: vi.fn(),
    };

    const loader = new OnDemandImageLoader(client, blobApi, 1);
    const errImg = createMockImg();
    const okImg = createMockImg();

    loader.loadIntoElement(errImg, 'attachments/missing.png', 'main');
    loader.loadIntoElement(okImg, 'attachments/valid.png', 'main');

    await vi.waitFor(() => expect(okImg.src).toBe('blob:ok'));
    expect(errImg.src).toBe('');
    expect(errImg.classList.add).toHaveBeenCalledWith('gitlab-img-error');
  });

  it('retries with fallbackRef when primary ref fails and enters error only if both fail', async () => {
    const client = {
      getRawBinary: vi
        .fn()
        .mockRejectedValueOnce(new Error('404 on conflict branch'))
        .mockResolvedValueOnce(new Uint8Array([9, 8, 7]).buffer)
        .mockRejectedValueOnce(new Error('404 on conflict branch'))
        .mockRejectedValueOnce(new Error('404 on main')),
    } as any;
    const blobApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:fallback-ok'),
      revokeObjectURL: vi.fn(),
    };

    const loader = new OnDemandImageLoader(client, blobApi, 2);
    const okImg = createMockImg();
    const failImg = createMockImg();

    loader.loadIntoElement(okImg, 'attachments/existing.png', 'mobile-conflict/1', 'main');
    await vi.waitFor(() => expect(okImg.src).toBe('blob:fallback-ok'));
    expect(client.getRawBinary).toHaveBeenNthCalledWith(
      1,
      'attachments/existing.png',
      'mobile-conflict/1',
    );
    expect(client.getRawBinary).toHaveBeenNthCalledWith(2, 'attachments/existing.png', 'main');

    loader.loadIntoElement(failImg, 'attachments/missing.png', 'mobile-conflict/1', 'main');
    await vi.waitFor(() =>
      expect(failImg.classList.add).toHaveBeenCalledWith('gitlab-img-error'),
    );
    expect(failImg.src).toBe('');
  });

  it('falls back to default concurrency 3 when maxConcurrent is NaN and evicts oldest LRU memoryImage past maxMemoryImages', async () => {
    let seq = 0;
    const blobApi = {
      createObjectURL: vi.fn(() => `blob:lru-${++seq}`),
      revokeObjectURL: vi.fn(),
    };
    const resolvers = new Map<string, (buf: ArrayBuffer) => void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      getRawBinary: vi.fn((path: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<ArrayBuffer>((resolve) => {
          resolvers.set(path, (buf) => {
            inFlight--;
            resolve(buf);
          });
        });
      }),
    } as any;
    const loader = new OnDemandImageLoader(client, blobApi, Number.NaN, 2);

    loader.registerMemoryImage('a.png', new Blob([new Uint8Array([1])]));
    loader.registerMemoryImage('b.png', new Blob([new Uint8Array([2])]));
    // Touch a.png via loadIntoElement so b.png becomes least recently used
    loader.loadIntoElement(createMockImg(), 'a.png', 'main');
    loader.registerMemoryImage('c.png', new Blob([new Uint8Array([3])]));

    expect(blobApi.revokeObjectURL).toHaveBeenCalledWith('blob:lru-2');
    const cachedImg = createMockImg();
    loader.loadIntoElement(cachedImg, 'c.png', 'main');
    expect(cachedImg.src).toBe('blob:lru-3');
    expect(client.getRawBinary).not.toHaveBeenCalled();

    // Verify async drainQueue() defaults to 3 concurrent requests when maxConcurrent is NaN
    const netImgs = Array.from({ length: 4 }, () => createMockImg());
    netImgs.forEach((img, idx) => loader.loadIntoElement(img, `net/${idx}.png`, 'main'));
    expect(client.getRawBinary).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(3);

    resolvers.get('net/0.png')!(new Uint8Array([1]).buffer);
    await vi.waitFor(() => expect(client.getRawBinary).toHaveBeenCalledTimes(4));

    resolvers.get('net/1.png')!(new Uint8Array([2]).buffer);
    resolvers.get('net/2.png')!(new Uint8Array([3]).buffer);
    resolvers.get('net/3.png')!(new Uint8Array([4]).buffer);
    await vi.waitFor(() => expect(netImgs[3].src).toMatch(/^blob:lru-/));
    expect(maxInFlight).toBe(3);
  });

  it('observeAndLoad adds loading placeholder class before observing with 200px rootMargin', () => {
    let capturedOptions: IntersectionObserverInit | undefined;
    class MockIntersectionObserver {
      constructor(_cb: (entries: IntersectionObserverEntry[]) => void, options?: IntersectionObserverInit) {
        capturedOptions = options;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

    const client = { getRawBinary: vi.fn() } as any;
    const blobApi = { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() };
    const imgEl = createMockImg();
    const loader = new OnDemandImageLoader(client, blobApi, 3);

    const cleanup = loader.observeAndLoad(imgEl, 'attachments/pic.png', 'main');
    expect(imgEl.classList.add).toHaveBeenCalledWith('gitlab-img-loading');
    expect(capturedOptions).toEqual({ rootMargin: '200px 0px' });

    cleanup();
    expect(imgEl.classList.remove).toHaveBeenCalledWith('gitlab-img-loading');
  });
});
