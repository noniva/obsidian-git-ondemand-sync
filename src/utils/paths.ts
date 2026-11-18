const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.avif',
  '.heic',
  '.heif',
  '.ico',
  '.tiff',
  '.tif',
]);

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const EMBED_SIZE_RE = /^(\d+)(?:x\d+)?$/;

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getLowerExtension(filePath: string): string {
  const normalized = normalizeVaultPath(filePath);
  const lastSlash = normalized.lastIndexOf('/');
  const baseName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dotIdx = baseName.lastIndexOf('.');
  if (dotIdx <= 0) {
    return '';
  }
  return baseName.slice(dotIdx).toLowerCase();
}

/**
 * Normalizes a vault-relative path by converting backslashes, resolving `.` and `..`,
 * and trimming leading/trailing slashes.
 */
export function normalizeVaultPath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  const resolved: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join('/');
}

/**
 * Returns true if the path has a supported image file extension.
 */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getLowerExtension(path));
}

/**
 * Returns true if the path matches one of the allowlisted text file extensions.
 */
export function isTextSyncPath(path: string, allowlist: string[]): boolean {
  const ext = getLowerExtension(path);
  if (!ext) {
    return false;
  }
  return allowlist.some((item) => {
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) {
      return false;
    }
    const normalizedExt = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    return normalizedExt === ext;
  });
}

/**
 * Returns true for paths that should never be synced: any path containing a dot-prefixed
 * segment (e.g. `.git`, `.github`, `.vscode`), except `.obsidian` when `syncObsidianDir` is true.
 */
export function isIgnoredPath(path: string, syncObsidianDir: boolean): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized) {
    return false;
  }
  const segments = normalized.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment.startsWith('.')) {
      continue;
    }
    if (i === 0 && segment === '.obsidian' && syncObsidianDir) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Extracts a trailing numeric width from an embed alias/size string (e.g. `300`,
 * `300x200`, or `alt text|300`).
 */
export function parseEmbedWidth(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const lastPipe = trimmed.lastIndexOf('|');
  const candidate = (lastPipe >= 0 ? trimmed.slice(lastPipe + 1) : trimmed).trim();
  const sizeMatch = EMBED_SIZE_RE.exec(candidate);
  if (!sizeMatch) {
    return undefined;
  }
  const width = Number(sizeMatch[1]);
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

/**
 * Parses an Obsidian wikilink or markdown image embed target, extracting optional width
 * and returning null for empty targets or external/non-vault URIs.
 */
export function parseImageEmbed(rawTarget: string): { target: string; width?: number } | null {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return null;
  }

  const pipeIdx = trimmed.indexOf('|');
  const rawPath = (pipeIdx >= 0 ? trimmed.slice(0, pipeIdx) : trimmed).trim();
  const alias = pipeIdx >= 0 ? trimmed.slice(pipeIdx + 1).trim() : '';

  const hashIdx = rawPath.indexOf('#');
  const pathWithoutFragment = (hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath).trim();
  if (!pathWithoutFragment || URI_SCHEME_RE.test(pathWithoutFragment)) {
    return null;
  }

  const decodedPath = safeDecodeURIComponent(pathWithoutFragment);
  const cleanedTarget = decodedPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:\.\/)+/, '');
  if (!cleanedTarget) {
    return null;
  }

  const width = alias ? parseEmbedWidth(alias) : undefined;

  return { target: cleanedTarget, width };
}

function findMatchingPath(candidate: string, remoteImagePaths: string[]): string | null {
  for (const remote of remoteImagePaths) {
    if (normalizeVaultPath(remote) === candidate) {
      return remote;
    }
  }
  const lowerCandidate = candidate.toLowerCase();
  for (const remote of remoteImagePaths) {
    if (normalizeVaultPath(remote).toLowerCase() === lowerCandidate) {
      return remote;
    }
  }
  return null;
}

/**
 * Resolves an embed target relative to the current note directory or via Obsidian's
 * shortest-path lookup against the synced remote image path index.
 */
export function resolveRemoteImagePath(
  target: string,
  noteDir: string,
  remoteImagePaths: string[],
): string | null {
  const decodedTarget = safeDecodeURIComponent(target.trim());
  const cleanedTarget = decodedTarget.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanedTarget || URI_SCHEME_RE.test(cleanedTarget)) {
    return null;
  }

  const normalizedNoteDir = normalizeVaultPath(noteDir);
  if (normalizedNoteDir) {
    const relativeCandidate = normalizeVaultPath(`${normalizedNoteDir}/${cleanedTarget}`);
    const relativeMatch = findMatchingPath(relativeCandidate, remoteImagePaths);
    if (relativeMatch) {
      return relativeMatch;
    }
  }

  const rootCandidate = normalizeVaultPath(cleanedTarget);
  const rootMatch = findMatchingPath(rootCandidate, remoteImagePaths);
  if (rootMatch) {
    return rootMatch;
  }

  const suffix = `/${rootCandidate}`;
  for (const remote of remoteImagePaths) {
    const normalizedRemote = normalizeVaultPath(remote);
    if (normalizedRemote === rootCandidate || normalizedRemote.endsWith(suffix)) {
      return remote;
    }
  }

  const lowerSuffix = suffix.toLowerCase();
  const lowerRoot = rootCandidate.toLowerCase();
  for (const remote of remoteImagePaths) {
    const normalizedRemote = normalizeVaultPath(remote).toLowerCase();
    if (normalizedRemote === lowerRoot || normalizedRemote.endsWith(lowerSuffix)) {
      return remote;
    }
  }

  return null;
}

/**
 * Computes a lowercase hexadecimal SHA-256 digest of a UTF-8 string using Web Crypto.
 */
export async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
