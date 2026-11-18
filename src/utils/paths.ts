const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.avif',
  '.ico',
  '.tiff',
  '.tif',
]);

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const EMBED_SIZE_RE = /^(\d+)(?:x\d+)?$/;

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
 * Returns true for paths that should never be synced (`.git` always, `.obsidian` unless enabled).
 */
export function isIgnoredPath(path: string, syncObsidianDir: boolean): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized) {
    return false;
  }
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    return true;
  }
  if (!syncObsidianDir && (normalized === '.obsidian' || normalized.startsWith('.obsidian/'))) {
    return true;
  }
  return false;
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

  const cleanedTarget = pathWithoutFragment
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:\.\/)+/, '');
  if (!cleanedTarget) {
    return null;
  }

  let width: number | undefined;
  if (alias) {
    const sizeMatch = EMBED_SIZE_RE.exec(alias);
    if (sizeMatch) {
      width = Number(sizeMatch[1]);
    }
  }

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
  const cleanedTarget = target.trim().replace(/\\/g, '/').replace(/^\/+/, '');
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
