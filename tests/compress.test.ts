import { describe, it, expect, vi, afterEach } from 'vitest';
import { compressImageForUpload } from '../src/images/compress';

function makeBuffer(byteLength: number, fill = 1): ArrayBuffer {
  const buf = new Uint8Array(byteLength);
  buf.fill(fill);
  return buf.buffer;
}

describe('compressImageForUpload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('skips compression when enabled is false', async () => {
    const createBitmapSpy = vi.fn();
    vi.stubGlobal('createImageBitmap', createBitmapSpy);
    const bytes = makeBuffer(100_000);

    const res = await compressImageForUpload(bytes, 'image/png', { enabled: false });

    expect(res).toEqual({ bytes, mimeType: 'image/png' });
    expect(createBitmapSpy).not.toHaveBeenCalled();
  });

  it('skips compression when byteLength <= 51_200', async () => {
    const createBitmapSpy = vi.fn();
    vi.stubGlobal('createImageBitmap', createBitmapSpy);
    const bytes = makeBuffer(51_200);

    const res = await compressImageForUpload(bytes, 'image/png');

    expect(res).toEqual({ bytes, mimeType: 'image/png' });
    expect(createBitmapSpy).not.toHaveBeenCalled();
  });

  it.each([
    'image/gif',
    'image/svg+xml',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/gif; charset=utf-8',
  ])('skips compression for %s', async (mimeType) => {
    const createBitmapSpy = vi.fn();
    vi.stubGlobal('createImageBitmap', createBitmapSpy);
    const bytes = makeBuffer(100_000);

    const res = await compressImageForUpload(bytes, mimeType);

    expect(res).toEqual({ bytes, mimeType });
    expect(createBitmapSpy).not.toHaveBeenCalled();
  });

  it('resizes and converts large PNG to smaller WebP while preserving aspect ratio', async () => {
    const closeSpy = vi.fn();
    const bitmap = { width: 3840, height: 1920, close: closeSpy };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));

    const compressedBytes = makeBuffer(12_345, 7);
    const drawImage = vi.fn();
    const toBlob = vi.fn((cb: (b: Blob | null) => void, type?: string, quality?: number) => {
      expect(type).toBe('image/webp');
      expect(quality).toBe(0.85);
      cb({
        size: compressedBytes.byteLength,
        arrayBuffer: vi.fn().mockResolvedValue(compressedBytes),
      } as unknown as Blob);
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob,
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => canvas),
    });

    const bytes = makeBuffer(100_000);
    const res = await compressImageForUpload(bytes, 'image/png');

    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(960);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1920, 960);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(res.mimeType).toBe('image/webp');
    expect(res.bytes).toBe(compressedBytes);
  });

  it('clamps maxDimension to >= 256', async () => {
    const closeSpy = vi.fn();
    const bitmap = { width: 1000, height: 500, close: closeSpy };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));

    const compressedBytes = makeBuffer(2_000);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((cb: (b: Blob | null) => void) =>
        cb({
          size: compressedBytes.byteLength,
          arrayBuffer: vi.fn().mockResolvedValue(compressedBytes),
        } as unknown as Blob),
      ),
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });

    const bytes = makeBuffer(100_000);
    await compressImageForUpload(bytes, 'image/png', { maxDimension: 64 });

    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(128);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to original bytes when compressed WebP is not smaller', async () => {
    const closeSpy = vi.fn();
    const bitmap = { width: 800, height: 600, close: closeSpy };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));

    const largerBytes = makeBuffer(120_000);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((cb: (b: Blob | null) => void) =>
        cb({
          size: largerBytes.byteLength,
          arrayBuffer: vi.fn().mockResolvedValue(largerBytes),
        } as unknown as Blob),
      ),
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });

    const bytes = makeBuffer(100_000);
    const res = await compressImageForUpload(bytes, 'image/jpeg');

    expect(res).toEqual({ bytes, mimeType: 'image/jpeg' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to original bytes when createImageBitmap is missing or throws', async () => {
    const bytes = makeBuffer(100_000);

    vi.stubGlobal('createImageBitmap', undefined);
    expect(await compressImageForUpload(bytes, 'image/png')).toEqual({
      bytes,
      mimeType: 'image/png',
    });

    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
    vi.stubGlobal('document', { createElement: vi.fn() });
    expect(await compressImageForUpload(bytes, 'image/png')).toEqual({
      bytes,
      mimeType: 'image/png',
    });
  });
});
