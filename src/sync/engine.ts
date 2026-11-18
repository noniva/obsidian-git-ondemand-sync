import type { GitLabClient } from '../gitlab/client';
import type { GitLabCommitAction, PluginSettings, SyncState } from '../types';
import { isIgnoredPath, isImagePath, isTextSyncPath, sha256Hex } from '../utils/paths';
import { computeSyncPlan, type LocalFileSnapshot, type SyncPlan } from './diff';

export interface VaultTextAdapter {
  listTextFiles(): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

export interface SyncResult {
  pulled: number;
  deletedLocal: number;
  pushed: number;
  conflictBranch: string | null;
  headCommitSha: string;
}

export interface SyncEngineOptions {
  settings: PluginSettings;
  state: SyncState;
  client: Pick<GitLabClient, 'getBranchHead' | 'getTreeRecursive' | 'getRawText' | 'createCommit'>;
  vault: VaultTextAdapter;
  saveState: () => Promise<void> | void;
  now?: () => Date;
}

function formatConflictBranchName(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `mobile-conflict/${y}${m}${d}-${hh}${mm}${ss}`;
}

function buildPushActions(
  plan: SyncPlan,
  localContents: Record<string, string>,
): GitLabCommitAction[] {
  const actions: GitLabCommitAction[] = [];

  for (const path of plan.pushCreates) {
    actions.push({
      action: 'create',
      file_path: path,
      content: localContents[path],
      encoding: 'text',
    });
  }

  for (const path of plan.pushUpdates) {
    actions.push({
      action: 'update',
      file_path: path,
      content: localContents[path],
      encoding: 'text',
    });
  }

  for (const path of plan.pushDeletes) {
    actions.push({
      action: 'delete',
      file_path: path,
    });
  }

  return actions;
}

function buildReconciledConflictActions(
  plan: SyncPlan,
  localContents: Record<string, string>,
  conflictPaths: Set<string>,
): GitLabCommitAction[] {
  const actions: GitLabCommitAction[] = [];

  for (const path of [...plan.pushCreates, ...plan.pushUpdates]) {
    actions.push({
      action: conflictPaths.has(path) ? 'update' : 'create',
      file_path: path,
      content: localContents[path],
      encoding: 'text',
    });
  }

  for (const path of plan.pushDeletes) {
    if (conflictPaths.has(path)) {
      actions.push({
        action: 'delete',
        file_path: path,
      });
    }
  }

  return actions;
}

/**
 * Orchestrates 3-way text-only vault synchronization against GitLab,
 * indexing remote images in memory and isolating conflicts onto a mobile branch.
 */
export class SyncEngine {
  private readonly settings: PluginSettings;
  private readonly state: SyncState;
  private readonly client: SyncEngineOptions['client'];
  private readonly vault: VaultTextAdapter;
  private readonly saveState: () => Promise<void> | void;
  private readonly now: () => Date;

  constructor(options: SyncEngineOptions) {
    this.settings = options.settings;
    this.state = options.state;
    this.client = options.client;
    this.vault = options.vault;
    this.saveState = options.saveState;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Executes a full pull-then-push sync cycle and persists updated `SyncState`.
   */
  async sync(): Promise<SyncResult> {
    const rawLocalPaths = await this.vault.listTextFiles();
    const localPaths = rawLocalPaths.filter(
      (path) =>
        !isIgnoredPath(path, this.settings.syncObsidianDir) &&
        isTextSyncPath(path, this.settings.textAllowlist),
    );

    if (this.state.lastSyncedCommitSha === null && localPaths.length > 0) {
      throw new Error(
        'Initial sync requires an empty vault; existing local text files detected.',
      );
    }

    const headSha = await this.client.getBranchHead(this.settings.branch);
    const tree = await this.client.getTreeRecursive(headSha);

    const remoteTextFiles: Record<string, string> = {};
    const remoteImagePaths: string[] = [];

    for (const entry of tree) {
      if (entry.type !== 'blob' || isIgnoredPath(entry.path, this.settings.syncObsidianDir)) {
        continue;
      }
      if (isTextSyncPath(entry.path, this.settings.textAllowlist)) {
        remoteTextFiles[entry.path] = entry.id;
      } else if (isImagePath(entry.path)) {
        remoteImagePaths.push(entry.path);
      }
    }

    this.state.remoteImagePaths = remoteImagePaths.sort();

    const localHashes: LocalFileSnapshot = {};
    const localContents: Record<string, string> = {};

    for (const path of localPaths) {
      const content = await this.vault.readText(path);
      localContents[path] = content;
      localHashes[path] = await sha256Hex(content);
    }

    const plan = computeSyncPlan({
      state: this.state,
      remoteTextFiles,
      localHashes,
    });

    await this.applyPulls(plan, headSha, remoteTextFiles);

    if (plan.pullDownloads.length > 0 || plan.pullDeletes.length > 0) {
      await this.saveState();
    }

    let actions = buildPushActions(plan, localContents);
    if (plan.targetPushBranch === 'active-conflict' && actions.length > 0) {
      const conflictBranch = this.state.activeConflictBranch!;
      const conflictHeadSha = await this.client.getBranchHead(conflictBranch);
      const conflictTree = await this.client.getTreeRecursive(conflictHeadSha);
      const conflictPaths = new Set(
        conflictTree.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
      );
      actions = buildReconciledConflictActions(plan, localContents, conflictPaths);
    }

    const resultHeadSha = await this.applyPushes(plan, actions, headSha, localHashes);

    await this.saveState();

    return {
      pulled: plan.pullDownloads.length,
      deletedLocal: plan.pullDeletes.length,
      pushed: actions.length,
      conflictBranch: this.state.activeConflictBranch,
      headCommitSha: resultHeadSha,
    };
  }

  /**
   * Clears the active conflict branch marker after the user merges it on desktop.
   */
  async clearConflictBranch(): Promise<void> {
    this.state.activeConflictBranch = null;
    await this.saveState();
  }

  private async applyPulls(
    plan: SyncPlan,
    headSha: string,
    remoteTextFiles: Record<string, string>,
  ): Promise<void> {
    for (const path of plan.pullDownloads) {
      const content = await this.client.getRawText(path, headSha);
      await this.vault.writeText(path, content);
      this.state.files[path] = {
        blobSha: remoteTextFiles[path],
        contentHash: await sha256Hex(content),
      };
    }

    for (const path of plan.pullDeletes) {
      await this.vault.deleteFile(path);
      delete this.state.files[path];
    }
  }

  private async applyPushes(
    plan: SyncPlan,
    actions: GitLabCommitAction[],
    headSha: string,
    localHashes: LocalFileSnapshot,
  ): Promise<string> {
    if (actions.length === 0) {
      if (!this.state.activeConflictBranch) {
        this.state.lastSyncedCommitSha = headSha;
      }
      return headSha;
    }

    if (plan.targetPushBranch === 'target') {
      const newHeadSha = await this.client.createCommit({
        branch: this.settings.branch,
        commitMessage: 'Sync mobile vault changes',
        actions,
      });

      const updatedTree = await this.client.getTreeRecursive(newHeadSha);
      const updatedBlobs = new Map<string, string>();
      for (const entry of updatedTree) {
        if (entry.type === 'blob') {
          updatedBlobs.set(entry.path, entry.id);
        }
      }

      for (const path of [...plan.pushCreates, ...plan.pushUpdates]) {
        this.state.files[path] = {
          blobSha: updatedBlobs.get(path) ?? '',
          contentHash: localHashes[path],
        };
      }
      for (const path of plan.pushDeletes) {
        delete this.state.files[path];
      }

      this.state.lastSyncedCommitSha = newHeadSha;
      return newHeadSha;
    }

    const isNewConflictBranch = plan.targetPushBranch === 'conflict';
    const conflictBranch = isNewConflictBranch
      ? formatConflictBranchName(this.now())
      : this.state.activeConflictBranch!;

    await this.client.createCommit({
      branch: conflictBranch,
      commitMessage: 'Sync mobile conflict changes',
      actions,
      ...(isNewConflictBranch && this.state.lastSyncedCommitSha
        ? { startSha: this.state.lastSyncedCommitSha }
        : {}),
    });

    if (isNewConflictBranch) {
      this.state.activeConflictBranch = conflictBranch;
    }

    return headSha;
  }
}
