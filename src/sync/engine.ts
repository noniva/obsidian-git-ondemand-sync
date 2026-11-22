import type {
  PluginSettings,
  RemoteCommitAction,
  RemoteGitClient,
  RemoteTreeEntry,
  SyncState,
} from '../types';
import { isIgnoredPath, isImagePath, isTextSyncPath, sha256Hex } from '../utils/paths';
import { computeSyncPlan, type LocalFileSnapshot, type SyncPlan } from './diff';
import { mergeThreeWayKeepBoth } from './merge';

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

export interface SyncProgress {
  stage: 'checking' | 'tree' | 'pulling' | 'writing' | 'pushing';
  message: string;
  current?: number;
  total?: number;
}

export interface SyncEngineOptions {
  settings: PluginSettings;
  state: SyncState;
  client: Pick<RemoteGitClient, 'getBranchHead' | 'getTreeRecursive' | 'getRawText' | 'createCommit'> &
    Partial<Pick<RemoteGitClient, 'getRawTextsBatch' | 'compareCommits'>>;
  vault: VaultTextAdapter;
  saveState: () => Promise<void> | void;
  now?: () => Date;
  configDir?: string;
  onProgress?: (progress: SyncProgress) => void;
  downloadConcurrency?: number;
  batchDownloadSize?: number;
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
): RemoteCommitAction[] {
  const actions: RemoteCommitAction[] = [];

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

/**
 * Orchestrates 3-way text-only vault synchronization against a remote Git repository,
 * indexing remote images in memory and isolating conflicts onto a mobile branch.
 */
export class SyncEngine {
  private readonly settings: PluginSettings;
  private readonly state: SyncState;
  private readonly client: SyncEngineOptions['client'];
  private readonly vault: VaultTextAdapter;
  private readonly saveState: () => Promise<void> | void;
  private readonly now: () => Date;
  private readonly configDir: string;
  private readonly onProgress?: (progress: SyncProgress) => void;
  private readonly downloadConcurrency: number;
  private readonly batchDownloadSize: number;

  constructor(options: SyncEngineOptions) {
    this.settings = options.settings;
    this.state = options.state;
    this.client = options.client;
    this.vault = options.vault;
    this.saveState = options.saveState;
    this.now = options.now ?? (() => new Date());
    this.configDir = options.configDir ?? '';
    this.onProgress = options.onProgress;
    const rawConc = options.downloadConcurrency;
    this.downloadConcurrency =
      typeof rawConc === 'number' && Number.isFinite(rawConc)
        ? Math.max(1, Math.floor(rawConc))
        : 4;
    const rawBatch = options.batchDownloadSize;
    this.batchDownloadSize =
      typeof rawBatch === 'number' && Number.isFinite(rawBatch)
        ? Math.max(1, Math.floor(rawBatch))
        : 50;
  }

  private emitProgress(progress: SyncProgress): void {
    this.onProgress?.(progress);
  }

  private isAllowlistedText(path: string): boolean {
    return (
      !isIgnoredPath(path, this.settings.syncObsidianDir, this.configDir) &&
      isTextSyncPath(path, this.settings.textAllowlist)
    );
  }

  /**
   * Executes a full pull-then-push sync cycle and persists updated `SyncState`.
   */
  async sync(): Promise<SyncResult> {
    const initialRemoteImages = new Set(this.state.remoteImagePaths);
    const rawLocalPaths = await this.vault.listTextFiles();
    const localPaths = rawLocalPaths.filter((path) => this.isAllowlistedText(path));

    const isInitialSync = this.state.lastSyncedCommitSha === null;
    if (isInitialSync && localPaths.length > 0) {
      throw new Error(
        'Initial sync requires an empty vault; existing local text files detected.',
      );
    }

    this.emitProgress({ stage: 'checking', message: 'Checking remote branch...' });
    const headSha = await this.client.getBranchHead(this.settings.branch);
    const { remoteTextFiles, remoteImagePaths } = await this.resolveRemoteSnapshot(headSha);

    let conflictTree: RemoteTreeEntry[] | null = null;
    if (this.state.activeConflictBranch) {
      let conflictHeadSha: string;
      try {
        conflictHeadSha = await this.client.getBranchHead(this.state.activeConflictBranch);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('(404)')) {
          throw new Error(
            `Conflict branch "${this.state.activeConflictBranch}" no longer exists on remote (likely merged and deleted). Open Settings and click "Clear Conflict State" to adopt the merged target branch.`,
            { cause: err },
          );
        }
        throw err;
      }
      conflictTree = await this.client.getTreeRecursive(conflictHeadSha);
      for (const entry of conflictTree) {
        if (
          entry.type === 'blob' &&
          !isIgnoredPath(entry.path, this.settings.syncObsidianDir, this.configDir) &&
          isImagePath(entry.path)
        ) {
          remoteImagePaths.push(entry.path);
        }
      }
    }

    this.mergeRemoteImagePaths(remoteImagePaths, initialRemoteImages);

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

    if (plan.conflicts.length > 0) {
      await this.resolveConvergedConflicts(plan, headSha, remoteTextFiles, localHashes);
    }

    if (plan.conflicts.length > 0 && !this.state.activeConflictBranch) {
      await this.resolveAutoMergeConflicts(
        plan,
        headSha,
        remoteTextFiles,
        localContents,
        localHashes,
      );
    }

    await this.applyPulls(plan, headSha, remoteTextFiles);

    let actions = buildPushActions(plan, localContents);
    if (plan.targetPushBranch === 'active-conflict' && conflictTree !== null) {
      actions = await this.buildReconciledConflictActionsAsync(
        plan,
        localContents,
        localHashes,
        remoteTextFiles,
        conflictTree,
      );
    }

    const resultHeadSha = await this.applyPushes(plan, actions, headSha, localHashes);

    this.mergeRemoteImagePaths(this.state.remoteImagePaths, initialRemoteImages);
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
   * Clears the active conflict branch marker after the user merges it on desktop,
   * adopting 3-way merged target branch files while preserving post-push local edits.
   */
  async clearConflictBranch(): Promise<void> {
    const headSha = await this.client.getBranchHead(this.settings.branch);
    const tree = await this.client.getTreeRecursive(headSha);

    const localPaths = (await this.vault.listTextFiles()).filter((path) =>
      this.isAllowlistedText(path),
    );
    const localHashes: LocalFileSnapshot = {};
    for (const path of localPaths) {
      const content = await this.vault.readText(path);
      localHashes[path] = await sha256Hex(content);
    }

    const conflictDeletedSet = new Set(this.state.conflictDeletedPaths ?? []);
    const remoteTextEntries = tree.filter(
      (entry) => entry.type === 'blob' && this.isAllowlistedText(entry.path),
    );
    const remoteTextPaths = new Set(remoteTextEntries.map((entry) => entry.path));

    // Pre-fetch all changed target-branch files before touching disk or state.
    const remoteFiles = new Map<string, { blobSha: string; text: string; hash: string }>();
    for (const entry of remoteTextEntries) {
      const localHash = localHashes[entry.path];
      const existing = this.state.files[entry.path];
      const pushedHash = this.state.conflictPushedHashes?.[entry.path];
      const wasPushedDeleted = conflictDeletedSet.has(entry.path);
      if (
        existing &&
        existing.blobSha === entry.id &&
        localHash === existing.contentHash &&
        !wasPushedDeleted &&
        (pushedHash === undefined || pushedHash === localHash)
      ) {
        continue;
      }

      const remoteText = await this.client.getRawText(entry.path, headSha);
      if (typeof remoteText !== 'string') {
        continue;
      }
      remoteFiles.set(entry.path, {
        blobSha: entry.id,
        text: remoteText,
        hash: await sha256Hex(remoteText),
      });
    }

    let mutated = false;
    let completed = false;
    try {
      for (const [path, remote] of remoteFiles) {
        const localHash = localHashes[path];
        if (
          this.isUntouchedSinceConflict(path, localHash, conflictDeletedSet) &&
          localHash !== remote.hash
        ) {
          await this.vault.writeText(path, remote.text);
        }
        this.state.files[path] = {
          blobSha: remote.blobSha,
          contentHash: remote.hash,
        };
        this.clearConflictMarker(path);
        mutated = true;
      }

      const trackedOrConflictPaths = new Set([
        ...Object.keys(this.state.files),
        ...Object.keys(this.state.conflictPushedHashes ?? {}),
        ...(this.state.conflictDeletedPaths ?? []),
      ]);
      for (const path of trackedOrConflictPaths) {
        if (remoteTextPaths.has(path) || !this.isAllowlistedText(path)) {
          continue;
        }
        const localHash = localHashes[path];
        if (
          localHash !== undefined &&
          this.isUntouchedSinceConflict(path, localHash, conflictDeletedSet)
        ) {
          await this.vault.deleteFile(path);
        }
        delete this.state.files[path];
        this.clearConflictMarker(path);
        mutated = true;
      }

      this.state.activeConflictBranch = null;
      delete this.state.conflictPushedHashes;
      delete this.state.conflictDeletedPaths;
      this.state.lastSyncedCommitSha = headSha;
      completed = true;
    } finally {
      if (completed || mutated) {
        await this.saveState();
      }
    }
  }

  private clearConflictMarker(path: string): void {
    if (this.state.conflictPushedHashes) {
      delete this.state.conflictPushedHashes[path];
    }
    if (this.state.conflictDeletedPaths) {
      this.state.conflictDeletedPaths = this.state.conflictDeletedPaths.filter((p) => p !== path);
    }
  }

  private isUntouchedSinceConflict(
    path: string,
    localHash: string | undefined,
    conflictDeletedSet: Set<string>,
  ): boolean {
    if (conflictDeletedSet.has(path)) {
      return localHash === undefined;
    }
    const pushedHash = this.state.conflictPushedHashes?.[path];
    if (pushedHash !== undefined) {
      return localHash === pushedHash;
    }
    const base = this.state.files[path];
    if (base !== undefined) {
      return localHash === base.contentHash;
    }
    // Brand-new remote-only path when absent locally.
    return localHash === undefined;
  }

  private async resolveRemoteSnapshot(headSha: string): Promise<{
    remoteTextFiles: Record<string, string>;
    remoteImagePaths: string[];
  }> {
    const baseSha = this.state.lastSyncedCommitSha;
    const hasTrackedBaseline =
      Object.keys(this.state.files).length > 0 || this.state.remoteImagePaths.length > 0;

    if (baseSha !== null && hasTrackedBaseline && headSha === baseSha) {
      const remoteTextFiles: Record<string, string> = {};
      for (const [path, entry] of Object.entries(this.state.files)) {
        if (this.isAllowlistedText(path)) {
          remoteTextFiles[path] = entry.blobSha;
        }
      }
      const remoteImagePaths = this.state.remoteImagePaths.filter(
        (path) => !isIgnoredPath(path, this.settings.syncObsidianDir, this.configDir),
      );
      return { remoteTextFiles, remoteImagePaths };
    }

    if (baseSha !== null && hasTrackedBaseline && typeof this.client.compareCommits === 'function') {
      const changes = await this.client.compareCommits(baseSha, headSha);
      if (changes !== null) {
        const remoteTextFiles: Record<string, string> = {};
        for (const [path, entry] of Object.entries(this.state.files)) {
          if (this.isAllowlistedText(path)) {
            remoteTextFiles[path] = entry.blobSha;
          }
        }
        const imageSet = new Set(
          this.state.remoteImagePaths.filter(
            (path) => !isIgnoredPath(path, this.settings.syncObsidianDir, this.configDir),
          ),
        );

        let needsFullScan = false;
        for (const change of changes) {
          if (change.previousPath) {
            delete remoteTextFiles[change.previousPath];
            imageSet.delete(change.previousPath);
          }
          if (change.status === 'deleted') {
            delete remoteTextFiles[change.path];
            imageSet.delete(change.path);
            continue;
          }
          if (isIgnoredPath(change.path, this.settings.syncObsidianDir, this.configDir)) {
            continue;
          }
          if (isTextSyncPath(change.path, this.settings.textAllowlist)) {
            if (!change.blobSha) {
              needsFullScan = true;
              break;
            }
            remoteTextFiles[change.path] = change.blobSha;
            imageSet.delete(change.path);
          } else if (isImagePath(change.path)) {
            imageSet.add(change.path);
            delete remoteTextFiles[change.path];
          }
        }

        if (!needsFullScan) {
          return {
            remoteTextFiles,
            remoteImagePaths: Array.from(imageSet),
          };
        }
      }
    }

    const tree = await this.client.getTreeRecursive(headSha, (info) => {
      this.emitProgress({
        stage: 'tree',
        message: info.totalPages
          ? `Scanning repository (page ${info.page}/${info.totalPages}, ${info.entries} items)...`
          : `Scanning repository (page ${info.page}, ${info.entries} items)...`,
        current: info.page,
        total: info.totalPages,
      });
    });

    const remoteTextFiles: Record<string, string> = {};
    const remoteImagePaths: string[] = [];

    for (const entry of tree) {
      if (
        entry.type !== 'blob' ||
        isIgnoredPath(entry.path, this.settings.syncObsidianDir, this.configDir)
      ) {
        continue;
      }
      if (isTextSyncPath(entry.path, this.settings.textAllowlist)) {
        remoteTextFiles[entry.path] = entry.id;
      } else if (isImagePath(entry.path)) {
        remoteImagePaths.push(entry.path);
      }
    }

    return { remoteTextFiles, remoteImagePaths };
  }

  private mergeRemoteImagePaths(collected: string[], initialRemoteImages: Set<string>): void {
    const addedDuringSync = this.state.remoteImagePaths.filter((p) => !initialRemoteImages.has(p));
    this.state.remoteImagePaths = Array.from(new Set([...collected, ...addedDuringSync])).sort();
  }

  private async resolveConvergedConflicts(
    plan: SyncPlan,
    headSha: string,
    remoteTextFiles: Record<string, string>,
    localHashes: LocalFileSnapshot,
  ): Promise<void> {
    const convergedPaths = new Set<string>();
    for (const path of plan.conflicts) {
      const localHash = localHashes[path];
      if (localHash === undefined || remoteTextFiles[path] === undefined) {
        continue;
      }
      const remoteText = await this.client.getRawText(path, headSha);
      if (typeof remoteText === 'string' && (await sha256Hex(remoteText)) === localHash) {
        convergedPaths.add(path);
        this.state.files[path] = {
          blobSha: remoteTextFiles[path],
          contentHash: localHash,
        };
      }
    }

    if (convergedPaths.size === 0) {
      return;
    }

    plan.conflicts = plan.conflicts.filter((p) => !convergedPaths.has(p));
    plan.pushCreates = plan.pushCreates.filter((p) => !convergedPaths.has(p));
    plan.pushUpdates = plan.pushUpdates.filter((p) => !convergedPaths.has(p));
    plan.pushDeletes = plan.pushDeletes.filter((p) => !convergedPaths.has(p));
    plan.hasConflict = plan.conflicts.length > 0;
    if (!this.state.activeConflictBranch) {
      plan.targetPushBranch = plan.hasConflict ? 'conflict' : 'target';
    }
  }

  private async fetchOptionalRawText(path: string, ref: string): Promise<string | null> {
    try {
      const text = await this.client.getRawText(path, ref);
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  }

  /**
   * Auto-merges conflicting text files by keeping all lines from both Remote and Local,
   * preserving edited files over deletions, and falling back to `mobile-conflict` if base/remote cannot be fetched.
   */
  private async resolveAutoMergeConflicts(
    plan: SyncPlan,
    headSha: string,
    remoteTextFiles: Record<string, string>,
    localContents: Record<string, string>,
    localHashes: LocalFileSnapshot,
  ): Promise<void> {
    const resolvedPaths = new Set<string>();
    const convergedToRemote = new Set<string>();
    const promoteCreateToUpdate = new Set<string>();
    const restoreFromRemote = new Set<string>();

    for (const path of plan.conflicts) {
      const remoteSha = remoteTextFiles[path];
      const localText = localContents[path];

      if (remoteSha === undefined && localText !== undefined) {
        resolvedPaths.add(path);
        continue;
      }

      if (remoteSha !== undefined && localText === undefined) {
        resolvedPaths.add(path);
        restoreFromRemote.add(path);
        continue;
      }

      if (remoteSha === undefined || localText === undefined) {
        continue;
      }

      const remoteText = await this.fetchOptionalRawText(path, headSha);
      if (remoteText === null) {
        continue;
      }

      let baseText = '';
      if (this.state.files[path]) {
        if (!this.state.lastSyncedCommitSha) {
          continue;
        }
        const fetchedBase = await this.fetchOptionalRawText(path, this.state.lastSyncedCommitSha);
        if (fetchedBase === null) {
          continue;
        }
        baseText = fetchedBase;
      }

      const mergedText = mergeThreeWayKeepBoth(baseText, remoteText, localText);
      const mergedHash = await sha256Hex(mergedText);
      if (mergedText !== localText) {
        await this.vault.writeText(path, mergedText);
        localContents[path] = mergedText;
        localHashes[path] = mergedHash;
      }

      resolvedPaths.add(path);
      if (mergedText === remoteText) {
        convergedToRemote.add(path);
        this.state.files[path] = {
          blobSha: remoteSha,
          contentHash: mergedHash,
        };
      } else if (plan.pushCreates.includes(path)) {
        // Remote already has this path; pushing merged content must update rather than create.
        promoteCreateToUpdate.add(path);
      }
    }

    if (resolvedPaths.size === 0) {
      return;
    }

    plan.conflicts = plan.conflicts.filter((p) => !resolvedPaths.has(p));
    plan.pushCreates = plan.pushCreates.filter(
      (p) => !convergedToRemote.has(p) && !promoteCreateToUpdate.has(p),
    );
    plan.pushUpdates = plan.pushUpdates.filter((p) => !convergedToRemote.has(p));
    for (const path of promoteCreateToUpdate) {
      if (!plan.pushUpdates.includes(path)) {
        plan.pushUpdates.push(path);
      }
    }
    plan.pushUpdates.sort();
    plan.pushDeletes = plan.pushDeletes.filter((p) => !restoreFromRemote.has(p));
    for (const path of restoreFromRemote) {
      if (!plan.pullDownloads.includes(path)) {
        plan.pullDownloads.push(path);
      }
    }
    plan.pullDownloads.sort();
    plan.hasConflict = plan.conflicts.length > 0;
    plan.targetPushBranch = plan.hasConflict ? 'conflict' : 'target';
  }

  private async buildReconciledConflictActionsAsync(
    plan: SyncPlan,
    localContents: Record<string, string>,
    localHashes: LocalFileSnapshot,
    remoteTextFiles: Record<string, string>,
    conflictTree: RemoteTreeEntry[],
  ): Promise<RemoteCommitAction[]> {
    const conflictBranch = this.state.activeConflictBranch!;
    const conflictPaths = new Set(
      conflictTree.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
    );

    const actions: RemoteCommitAction[] = [];

    for (const path of [...plan.pushCreates, ...plan.pushUpdates]) {
      if (conflictPaths.has(path)) {
        const conflictText = await this.client.getRawText(path, conflictBranch);
        if (typeof conflictText === 'string' && (await sha256Hex(conflictText)) === localHashes[path]) {
          continue;
        }
        actions.push({
          action: 'update',
          file_path: path,
          content: localContents[path],
          encoding: 'text',
        });
      } else {
        actions.push({
          action: 'create',
          file_path: path,
          content: localContents[path],
          encoding: 'text',
        });
      }
    }

    const deletedPaths = new Set<string>();
    for (const path of plan.pushDeletes) {
      if (conflictPaths.has(path)) {
        deletedPaths.add(path);
        actions.push({
          action: 'delete',
          file_path: path,
        });
      }
    }

    for (const entry of conflictTree) {
      if (entry.type !== 'blob' || !this.isAllowlistedText(entry.path)) {
        continue;
      }
      if (
        remoteTextFiles[entry.path] === undefined &&
        localHashes[entry.path] === undefined &&
        !deletedPaths.has(entry.path)
      ) {
        deletedPaths.add(entry.path);
        actions.push({
          action: 'delete',
          file_path: entry.path,
        });
      }
    }

    return actions;
  }

  private async applyPulls(
    plan: SyncPlan,
    headSha: string,
    remoteTextFiles: Record<string, string>,
  ): Promise<void> {
    const totalDownloads = plan.pullDownloads.length;
    const downloaded = new Map<string, string>();

    if (totalDownloads > 0) {
      let completed = 0;
      const remainingPaths: string[] = [];

      this.emitProgress({
        stage: 'pulling',
        message: `Downloading notes (0/${totalDownloads})...`,
        current: 0,
        total: totalDownloads,
      });

      if (totalDownloads > 1 && typeof this.client.getRawTextsBatch === 'function') {
        for (let i = 0; i < totalDownloads; i += this.batchDownloadSize) {
          const chunk = plan.pullDownloads.slice(i, i + this.batchDownloadSize);
          const batch = await this.client.getRawTextsBatch(chunk, headSha);
          if (batch.size === 0) {
            // GraphQL unsupported or returned no blobs; fall back to REST for this and remaining chunks.
            remainingPaths.push(...plan.pullDownloads.slice(i));
            break;
          }
          for (const path of chunk) {
            const text = batch.get(path);
            if (text !== undefined) {
              downloaded.set(path, text);
              completed++;
            } else {
              remainingPaths.push(path);
            }
          }
          this.emitProgress({
            stage: 'pulling',
            message: `Downloading notes (${completed}/${totalDownloads})...`,
            current: completed,
            total: totalDownloads,
          });
        }
      } else {
        remainingPaths.push(...plan.pullDownloads);
      }

      if (remainingPaths.length > 0) {
        let nextIdx = 0;
        let failed = false;
        const workerCount = Math.min(this.downloadConcurrency, remainingPaths.length);
        const workers = Array.from({ length: workerCount }, async () => {
          while (!failed && nextIdx < remainingPaths.length) {
            const path = remainingPaths[nextIdx++];
            try {
              const text = await this.client.getRawText(path, headSha);
              if (failed) {
                return;
              }
              downloaded.set(path, text);
              completed++;
              this.emitProgress({
                stage: 'pulling',
                message: `Downloading notes (${completed}/${totalDownloads})...`,
                current: completed,
                total: totalDownloads,
              });
            } catch (err) {
              failed = true;
              throw err;
            }
          }
        });

        await Promise.all(workers);
      }
    }

    const totalWrites = downloaded.size + plan.pullDeletes.length;
    if (totalWrites === 0) {
      return;
    }

    let written = 0;
    let mutated = false;
    try {
      for (const path of plan.pullDownloads) {
        const content = downloaded.get(path)!;
        const contentHash = await sha256Hex(content);
        await this.vault.writeText(path, content);
        this.state.files[path] = {
          blobSha: remoteTextFiles[path],
          contentHash,
        };
        this.clearConflictMarker(path);
        mutated = true;
        written++;
        this.emitProgress({
          stage: 'writing',
          message: `Writing notes (${written}/${totalWrites})...`,
          current: written,
          total: totalWrites,
        });
      }

      for (const path of plan.pullDeletes) {
        await this.vault.deleteFile(path);
        delete this.state.files[path];
        this.clearConflictMarker(path);
        mutated = true;
        written++;
        this.emitProgress({
          stage: 'writing',
          message: `Writing notes (${written}/${totalWrites})...`,
          current: written,
          total: totalWrites,
        });
      }
    } finally {
      if (mutated) {
        await this.saveState();
      }
    }
  }

  private async applyPushes(
    plan: SyncPlan,
    actions: RemoteCommitAction[],
    headSha: string,
    localHashes: LocalFileSnapshot,
  ): Promise<string> {
    if (actions.length === 0) {
      if (!this.state.activeConflictBranch) {
        this.state.lastSyncedCommitSha = headSha;
      }
      return headSha;
    }

    this.emitProgress({
      stage: 'pushing',
      message: `Pushing ${actions.length} change(s)...`,
    });

    if (plan.targetPushBranch === 'target') {
      const latestHead = await this.client.getBranchHead(this.settings.branch);
      if (latestHead !== headSha) {
        throw new Error(
          'Remote target branch moved during sync; please run sync again to merge or pull latest changes.',
        );
      }

      const newHeadSha = await this.client.createCommit({
        branch: this.settings.branch,
        commitMessage: 'Sync mobile vault changes',
        actions,
      });

      const updatedBlobs = new Map<string, string>();
      const pushedDiffs =
        typeof this.client.compareCommits === 'function'
          ? await this.client.compareCommits(headSha, newHeadSha)
          : null;
      if (pushedDiffs !== null) {
        for (const entry of pushedDiffs) {
          if (entry.status !== 'deleted' && entry.blobSha) {
            updatedBlobs.set(entry.path, entry.blobSha);
          }
        }
      } else {
        const updatedTree = await this.client.getTreeRecursive(newHeadSha);
        for (const entry of updatedTree) {
          if (entry.type === 'blob') {
            updatedBlobs.set(entry.path, entry.id);
          }
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

    const pushedHashes: Record<string, string> = isNewConflictBranch
      ? {}
      : { ...(this.state.conflictPushedHashes ?? {}) };
    const deletedPaths = new Set<string>(
      isNewConflictBranch ? [] : (this.state.conflictDeletedPaths ?? []),
    );

    for (const action of actions) {
      if (action.action === 'delete') {
        delete pushedHashes[action.file_path];
        deletedPaths.add(action.file_path);
      } else {
        const hash = localHashes[action.file_path];
        if (hash !== undefined) {
          pushedHashes[action.file_path] = hash;
        }
        deletedPaths.delete(action.file_path);
      }
    }

    this.state.conflictPushedHashes = pushedHashes;
    this.state.conflictDeletedPaths = Array.from(deletedPaths).sort();

    return headSha;
  }
}
