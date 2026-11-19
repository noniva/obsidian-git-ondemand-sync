import { App, Modal } from 'obsidian';
import type { VaultTextAdapter } from '../sync/engine';
import type { PluginSettings, RemoteGitClient, SyncState } from '../types';
import {
  isIgnoredPath,
  isImagePath,
  normalizeVaultPath,
  resolveRemoteImagePath,
} from '../utils/paths';

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;
const HTML_IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const IMAGE_TOKEN_RE =
  /[^\s"'`<>()[\]{}|]+?\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|ico|tiff?)/gi;

function addTargetIfLocal(raw: string, targets: Set<string>): void {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//') || URI_SCHEME_RE.test(trimmed)) {
    return;
  }
  targets.add(trimmed);
}

function extractMarkdownLinkTargets(content: string, targets: Set<string>): void {
  let idx = 0;
  while (idx < content.length) {
    const start = content.indexOf('](', idx);
    if (start < 0) {
      break;
    }

    let pos = start + 2;
    while (pos < content.length && /\s/.test(content[pos])) {
      pos++;
    }

    if (pos >= content.length) {
      break;
    }

    if (content[pos] === '<') {
      const endAngle = content.indexOf('>', pos + 1);
      if (endAngle > pos + 1) {
        addTargetIfLocal(content.slice(pos + 1, endAngle), targets);
        idx = endAngle + 1;
        continue;
      }
    }

    let depth = 1;
    let end = pos;
    while (end < content.length && depth > 0) {
      const ch = content[end];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          break;
        }
      } else if (/\s/.test(ch)) {
        break;
      }
      end++;
    }

    if (end > pos) {
      addTargetIfLocal(content.slice(pos, end), targets);
    }
    idx = end + 1;
  }
}

/**
 * Extracts local image/link targets from markdown, HTML, canvas JSON, and YAML frontmatter.
 */
export function extractImageTargetsFromText(content: string): string[] {
  const targets = new Set<string>();

  for (const match of content.matchAll(WIKILINK_RE)) {
    const rawInner = match[1];
    const pipeIdx = rawInner.indexOf('|');
    const withoutAlias = pipeIdx >= 0 ? rawInner.slice(0, pipeIdx) : rawInner;
    const hashIdx = withoutAlias.indexOf('#');
    const clean = hashIdx >= 0 ? withoutAlias.slice(0, hashIdx) : withoutAlias;
    addTargetIfLocal(clean, targets);
  }

  extractMarkdownLinkTargets(content, targets);

  for (const match of content.matchAll(HTML_IMG_SRC_RE)) {
    addTargetIfLocal(match[1] ?? match[2] ?? '', targets);
  }

  for (const match of content.matchAll(IMAGE_TOKEN_RE)) {
    addTargetIfLocal(match[0], targets);
  }

  return Array.from(targets);
}

/**
 * Scans all text files in the vault and returns sorted remote image paths that are not referenced.
 */
export async function findUnusedRemoteImages(
  vault: Pick<VaultTextAdapter, 'listTextFiles' | 'readText'>,
  remoteImagePaths: string[],
): Promise<string[]> {
  if (remoteImagePaths.length === 0) {
    return [];
  }

  const referenced = new Set<string>();
  const textFiles = await vault.listTextFiles();

  for (const filePath of textFiles) {
    const content = await vault.readText(filePath);
    const normalizedFile = normalizeVaultPath(filePath);
    const lastSlash = normalizedFile.lastIndexOf('/');
    const noteDir = lastSlash >= 0 ? normalizedFile.slice(0, lastSlash) : '';

    for (const target of extractImageTargetsFromText(content)) {
      const resolved = resolveRemoteImagePath(target, noteDir, remoteImagePaths, {
        decodeTarget: true,
      });
      if (resolved) {
        referenced.add(resolved);
      }
    }
  }

  return remoteImagePaths.filter((p) => !referenced.has(p)).sort((a, b) => a.localeCompare(b));
}

/**
 * Verifies sync state against the remote branch HEAD and returns live unused remote image paths.
 */
export async function planUnusedImageCleanup(params: {
  settings: PluginSettings;
  state: SyncState;
  client: Pick<RemoteGitClient, 'getBranchHead' | 'getTreeRecursive'>;
  vault: Pick<VaultTextAdapter, 'listTextFiles' | 'readText'>;
  configDir?: string;
}): Promise<{ headSha: string; unusedPaths: string[] }> {
  if (!params.settings.projectId.trim() || !params.settings.token.trim()) {
    throw new Error('Please configure your repository Project ID and token in settings.');
  }
  if (params.state.lastSyncedCommitSha === null) {
    throw new Error('Please run Sync before cleaning up unused images.');
  }
  if (params.state.activeConflictBranch) {
    throw new Error('Resolve and clear the active conflict branch before cleaning up unused images.');
  }

  const branch = params.settings.branch.trim() || 'main';
  const headSha = await params.client.getBranchHead(branch);
  if (headSha !== params.state.lastSyncedCommitSha) {
    throw new Error(
      `Remote branch "${branch}" has new commits. Please run Sync first before cleaning up unused images.`,
    );
  }

  const tree = await params.client.getTreeRecursive(headSha);
  const liveImagePaths = tree
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        !isIgnoredPath(entry.path, params.settings.syncObsidianDir, params.configDir) &&
        isImagePath(entry.path),
    )
    .map((entry) => entry.path);

  const unusedPaths = await findUnusedRemoteImages(params.vault, liveImagePaths);
  return { headSha, unusedPaths };
}

/**
 * Deletes the selected remote images in a single commit and updates local sync state.
 */
export async function executeUnusedImageCleanup(params: {
  branch: string;
  selectedPaths: string[];
  client: Pick<RemoteGitClient, 'createCommit'>;
  state: SyncState;
  saveState: () => Promise<void>;
  clearCache?: () => Promise<void> | void;
}): Promise<string> {
  if (params.selectedPaths.length === 0) {
    throw new Error('No images selected for deletion.');
  }

  const actions = params.selectedPaths.map((filePath) => ({
    action: 'delete' as const,
    file_path: filePath,
  }));

  const newHeadSha = await params.client.createCommit({
    branch: params.branch,
    commitMessage: 'Clean up unused images',
    actions,
  });

  const deletedSet = new Set(params.selectedPaths);
  params.state.lastSyncedCommitSha = newHeadSha;
  params.state.remoteImagePaths = params.state.remoteImagePaths.filter((p) => !deletedSet.has(p));

  await params.saveState();
  await params.clearCache?.();
  return newHeadSha;
}

export interface UnusedImagesModalOptions {
  branch: string;
  unusedPaths: string[];
  onConfirm: (selectedPaths: string[]) => Promise<void> | void;
}

/**
 * Confirmation modal listing unused remote images with checkboxes before deletion.
 */
export class UnusedImagesModal extends Modal {
  private readonly opts: UnusedImagesModalOptions;

  constructor(app: App, opts: UnusedImagesModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const titleEl = document.createElement('h2');
    titleEl.textContent = 'Clean Up Unused Remote Images';
    contentEl.appendChild(titleEl);

    const descEl = document.createElement('p');
    descEl.textContent = `Found ${this.opts.unusedPaths.length} image(s) not referenced in any note on branch "${this.opts.branch}".`;
    contentEl.appendChild(descEl);

    const controlsEl = document.createElement('div');
    controlsEl.className = 'gitlab-cleanup-modal-controls';
    const toggleAllBtn = document.createElement('button');
    toggleAllBtn.type = 'button';
    controlsEl.appendChild(toggleAllBtn);
    contentEl.appendChild(controlsEl);

    const listEl = document.createElement('div');
    listEl.className = 'gitlab-cleanup-modal-list';
    contentEl.appendChild(listEl);

    const checkboxes: Array<{ path: string; input: HTMLInputElement }> = [];
    for (const filePath of this.opts.unusedPaths) {
      const itemEl = document.createElement('label');
      itemEl.className = 'gitlab-cleanup-modal-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;

      const labelText = document.createElement('span');
      labelText.textContent = filePath;

      itemEl.append(checkbox, labelText);
      listEl.appendChild(itemEl);
      checkboxes.push({ path: filePath, input: checkbox });
    }

    const actionsEl = document.createElement('div');
    actionsEl.className = 'gitlab-cleanup-modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.close());

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'mod-warning';

    actionsEl.append(cancelBtn, deleteBtn);
    contentEl.appendChild(actionsEl);

    let submitting = false;

    const getSelectedPaths = (): string[] =>
      checkboxes.filter((item) => item.input.checked).map((item) => item.path);

    const updateUi = (): void => {
      const selectedCount = getSelectedPaths().length;
      const allSelected = selectedCount === checkboxes.length && checkboxes.length > 0;
      toggleAllBtn.textContent = allSelected ? 'Deselect All' : 'Select All';
      toggleAllBtn.disabled = submitting || checkboxes.length === 0;
      deleteBtn.textContent = submitting ? 'Deleting...' : `Delete (${selectedCount})`;
      deleteBtn.disabled = submitting || selectedCount === 0;
      cancelBtn.disabled = submitting;
      for (const item of checkboxes) {
        item.input.disabled = submitting;
      }
    };

    for (const item of checkboxes) {
      item.input.addEventListener('change', updateUi);
    }

    toggleAllBtn.addEventListener('click', () => {
      const allSelected = getSelectedPaths().length === checkboxes.length;
      const nextChecked = !allSelected;
      for (const item of checkboxes) {
        item.input.checked = nextChecked;
      }
      updateUi();
    });

    deleteBtn.addEventListener('click', () => {
      const selected = getSelectedPaths();
      if (submitting || selected.length === 0) {
        return;
      }
      submitting = true;
      updateUi();
      void Promise.resolve(this.opts.onConfirm(selected))
        .then(() => {
          this.close();
        })
        .catch(() => {
          submitting = false;
          updateUi();
        });
    });

    updateUi();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
