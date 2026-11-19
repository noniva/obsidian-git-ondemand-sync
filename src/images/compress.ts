export interface CompressImageOptions {
  enabled?: boolean;
  maxDimension?: number;
  quality?: number;
  minBytesToCompress?: number;
}

const SKIP_COMPRESS_MIMES = new Set([
  'image/gif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const DEFAULT_MAX_DIMENSION = 1920;
const MIN_MAX_DIMENSION = 256;
const DEFAULT_QUALITY = 0.85;
const DEFAULT_MIN_BYTES = 51_200;

/**
 * Resizes and re-encodes large raster images to WebP before upload, falling back
 * to the original bytes on unsupported formats, errors, or non-shrinking output.
 */
export async function compressImageForUpload(
  bytes: ArrayBuffer,
  mimeType: string,
  options?: CompressImageOptions,
): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  const baseMime = mimeType.split(';', 1)[0].trim().toLowerCase();
  const minBytes = options?.minBytesToCompress ?? DEFAULT_MIN_BYTES;

  if (
    options?.enabled === false ||
    SKIP_COMPRESS_MIMES.has(baseMime) ||
    bytes.byteLength <= minBytes ||
    typeof createImageBitmap !== 'function' ||
    typeof document === 'undefined'
  ) {
    return { bytes, mimeType };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: baseMime }));
    const maxDimension = Math.max(
      MIN_MAX_DIMENSION,
      options?.maxDimension ?? DEFAULT_MAX_DIMENSION,
    );
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const scale = longestSide > maxDimension ? maxDimension / longestSide : 1;
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = createEl('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { bytes, mimeType };
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    const quality = options?.quality ?? DEFAULT_QUALITY;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality),
    );
    if (blob && blob.size > 0 && blob.size < bytes.byteLength) {
      return {
        bytes: await blob.arrayBuffer(),
        mimeType: 'image/webp',
      };
    }
    return { bytes, mimeType };
  } catch {
    return { bytes, mimeType };
  } finally {
    bitmap?.close?.();
  }
}
