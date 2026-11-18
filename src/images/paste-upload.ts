import { MarkdownView, Notice, TFile, type Editor, type Plugin } from 'obsidian';
import type { GitLabClient } from '../gitlab/client';
import type { OnDemandImageLoader } from './loader';
import type { PluginSettings, SyncState } from '../types';
import { isImagePath, normalizeVaultPath } from '../utils/paths';

export interface PasteUploadDeps {
  settings: PluginSettings;
  state: SyncState;
  client: GitLabClient;
  loader: OnDemandImageLoader;
  saveState: () => Promise<void>;
  isEnabled: () => boolean;
}

export interface UploadPastedImageParams {
  bytes: ArrayBuffer;
  mimeType: string;
  attachmentFolder: string;
  branch: string;
  client: Pick<GitLabClient, 'createCommit'>;
  state: SyncState;
  saveState: () => Promise<void>;
  now?: Date;
}

export interface UploadPastedImageResult {
  repoPath: string;
  wikilink: string;
}

const BASE64_CHUNK_SIZE = 0x8000;

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
};

function arrayBufferToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const parts: string[] = [];

  for (let i = 0; i < view.length; i += BASE64_CHUNK_SIZE) {
    const slice = view.subarray(i, i + BASE64_CHUNK_SIZE);
    let chunk = '';
    for (let j = 0; j < slice.length; j++) {
      chunk += String.fromCharCode(slice[j]);
    }
    parts.push(chunk);
  }

  return btoa(parts.join(''));
}

function extensionFromMimeType(mimeType: string): string {
  const baseMime = mimeType.split(';', 1)[0].trim().toLowerCase();
  const mapped = MIME_TO_EXTENSION[baseMime];
  if (mapped) {
    return mapped;
  }

  if (baseMime.startsWith('image/')) {
    const rawSubtype = baseMime.slice('image/'.length).split('+', 1)[0];
    const sanitized = rawSubtype.replace(/[^a-z0-9]/g, '');
    if (sanitized) {
      return sanitized;
    }
  }

  return 'png';
}

function formatTimestampUtc(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${y}${m}${d}${hh}${mm}${ss}`;
}

function buildUniqueRepoPath(
  attachmentFolder: string,
  timestamp: string,
  ext: string,
  existingPaths: string[],
): string {
  const folder = normalizeVaultPath(attachmentFolder);
  const known = new Set(existingPaths.map((p) => normalizeVaultPath(p)));
  const joinFolder = (fileName: string): string => (folder ? `${folder}/${fileName}` : fileName);

  const baseCandidate = joinFolder(`Pasted image ${timestamp}.${ext}`);
  if (!known.has(baseCandidate)) {
    return baseCandidate;
  }

  let suffix = 1;
  while (true) {
    const candidate = joinFolder(`Pasted image ${timestamp}-${suffix}.${ext}`);
    if (!known.has(candidate)) {
      return candidate;
    }
    suffix++;
  }
}

function extractImageFiles(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) {
    return [];
  }

  const images: File[] = [];
  if (transfer.files && transfer.files.length > 0) {
    for (const file of Array.from(transfer.files)) {
      if (file.type && file.type.toLowerCase().startsWith('image/')) {
        images.push(file);
      }
    }
    if (images.length > 0) {
      return images;
    }
  }

  if (transfer.items && transfer.items.length > 0) {
    for (const item of Array.from(transfer.items)) {
      if (item.kind === 'file' && item.type.toLowerCase().startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          images.push(file);
        }
      }
    }
  }

  return images;
}

async function handleImageTransfer(
  evt: Event,
  transfer: DataTransfer | null | undefined,
  editor: Editor,
  getDeps: () => PasteUploadDeps,
): Promise<void> {
  if (evt.defaultPrevented) {
    return;
  }

  const deps = getDeps();
  if (!deps.isEnabled()) {
    return;
  }

  const imageFiles = extractImageFiles(transfer);
  if (imageFiles.length === 0) {
    return;
  }

  // Prevent Obsidian from persisting pasted/dropped images to local vault storage.
  evt.preventDefault();

  const branch = deps.state.activeConflictBranch ?? (deps.settings.branch || 'main');
  let insertedCount = 0;

  try {
    for (const file of imageFiles) {
      const bytes = await file.arrayBuffer();
      const mimeType = file.type || 'image/png';
      const result = await uploadPastedImage({
        bytes,
        mimeType,
        attachmentFolder: deps.settings.attachmentFolder,
        branch,
        client: deps.client,
        state: deps.state,
        saveState: deps.saveState,
      });

      deps.loader.registerMemoryImage(result.repoPath, new Blob([bytes], { type: mimeType }));
      editor.replaceSelection(insertedCount > 0 ? `\n${result.wikilink}` : result.wikilink);
      insertedCount++;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    new Notice(`Failed to upload image to GitLab: ${message}`);
  }
}

/**
 * Encodes a pasted/dropped image as base64 without Node `Buffer`, commits it directly to GitLab,
 * records the new path in `state.remoteImagePaths`, and returns the repo path and wikilink.
 */
export async function uploadPastedImage(
  params: UploadPastedImageParams,
): Promise<UploadPastedImageResult> {
  const now = params.now ?? new Date();
  const ext = extensionFromMimeType(params.mimeType);
  const repoPath = buildUniqueRepoPath(
    params.attachmentFolder,
    formatTimestampUtc(now),
    ext,
    params.state.remoteImagePaths,
  );
  const content = arrayBufferToBase64(params.bytes);

  await params.client.createCommit({
    branch: params.branch,
    commitMessage: `Upload pasted image ${repoPath}`,
    actions: [
      {
        action: 'create',
        file_path: repoPath,
        content,
        encoding: 'base64',
      },
    ],
  });

  if (!params.state.remoteImagePaths.includes(repoPath)) {
    params.state.remoteImagePaths.push(repoPath);
  }
  await params.saveState();

  return {
    repoPath,
    wikilink: `![[${repoPath}]]`,
  };
}

const EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

function mimeTypeFromExtension(extOrPath: string): string {
  const clean = extOrPath.trim().toLowerCase().replace(/^\./, '');
  const dotIdx = clean.lastIndexOf('.');
  const ext = dotIdx >= 0 ? clean.slice(dotIdx + 1) : clean;
  return EXTENSION_TO_MIME[ext] ?? 'image/png';
}

function getActiveMarkdownEditor(plugin: Plugin): Editor | null {
  const activeView = plugin.app.workspace.getActiveViewOfType?.(MarkdownView);
  if (activeView?.editor) {
    return activeView.editor;
  }
  const activeEditor = (plugin.app.workspace as { activeEditor?: { editor?: Editor } }).activeEditor;
  return activeEditor?.editor ?? null;
}

async function handleVaultImageCreate(
  file: unknown,
  plugin: Plugin,
  getDeps: () => PasteUploadDeps,
): Promise<void> {
  const deps = getDeps();
  if (!deps.isEnabled() || !(file instanceof TFile) || !isImagePath(file.path)) {
    return;
  }

  const branch = deps.state.activeConflictBranch ?? (deps.settings.branch || 'main');
  try {
    const bytes = await plugin.app.vault.readBinary(file);
    const mimeType = mimeTypeFromExtension(file.extension || file.path);
    const result = await uploadPastedImage({
      bytes,
      mimeType,
      attachmentFolder: deps.settings.attachmentFolder,
      branch,
      client: deps.client,
      state: deps.state,
      saveState: deps.saveState,
    });

    deps.loader.registerMemoryImage(result.repoPath, new Blob([bytes], { type: mimeType }));
    await plugin.app.vault.delete(file);

    const editor = getActiveMarkdownEditor(plugin);
    if (editor) {
      const content = editor.getValue();
      if (!content.includes(result.repoPath)) {
        const pathLink = `![[${file.path}]]`;
        const nameLink = `![[${file.name}]]`;
        if (content.includes(pathLink)) {
          editor.setValue(content.replace(pathLink, result.wikilink));
        } else if (content.includes(nameLink)) {
          editor.setValue(content.replace(nameLink, result.wikilink));
        } else {
          editor.replaceSelection(result.wikilink);
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    new Notice(`Failed to upload image to GitLab: ${message}`);
  }
}

/**
 * Registers `editor-paste`, `editor-drop`, and `vault.on('create')` handlers that upload image
 * files directly to GitLab and cache their blobs in memory without keeping local mobile files.
 */
export function registerMobileImageUpload(
  plugin: Plugin,
  getDeps: () => PasteUploadDeps,
): void {
  plugin.registerEvent(
    plugin.app.workspace.on('editor-paste', (evt, editor) =>
      handleImageTransfer(evt, evt.clipboardData, editor, getDeps),
    ),
  );

  plugin.registerEvent(
    plugin.app.workspace.on('editor-drop', (evt, editor) =>
      handleImageTransfer(evt, evt.dataTransfer, editor, getDeps),
    ),
  );

  plugin.registerEvent(
    plugin.app.vault.on('create', (file) => handleVaultImageCreate(file, plugin, getDeps)),
  );
}
