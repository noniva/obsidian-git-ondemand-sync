import type { SyncState, SyncedFileEntry } from '../types';

export type LocalFileSnapshot = Record<string, string>;

export type TargetPushBranch = 'target' | 'conflict' | 'active-conflict';

export interface SyncPlan {
  pullDownloads: string[];
  pullDeletes: string[];
  pushCreates: string[];
  pushUpdates: string[];
  pushDeletes: string[];
  conflicts: string[];
  hasConflict: boolean;
  targetPushBranch: TargetPushBranch;
}

export interface ComputeSyncPlanParams {
  state: SyncState;
  remoteTextFiles: Record<string, string>;
  localHashes: LocalFileSnapshot;
}

function classifyUntrackedPath(
  path: string,
  remoteSha: string | undefined,
  localHash: string | undefined,
  plan: SyncPlan,
): void {
  if (remoteSha !== undefined && localHash !== undefined) {
    plan.conflicts.push(path);
    plan.pushCreates.push(path);
  } else if (remoteSha !== undefined) {
    plan.pullDownloads.push(path);
  } else if (localHash !== undefined) {
    plan.pushCreates.push(path);
  }
}

function classifyTrackedPath(
  path: string,
  base: SyncedFileEntry,
  remoteSha: string | undefined,
  localHash: string | undefined,
  plan: SyncPlan,
): void {
  const remoteChanged = remoteSha !== base.blobSha;
  const localChanged = localHash !== base.contentHash;

  if (!remoteChanged && !localChanged) {
    return;
  }

  if (remoteChanged && !localChanged) {
    if (remoteSha !== undefined) {
      plan.pullDownloads.push(path);
    } else {
      plan.pullDeletes.push(path);
    }
    return;
  }

  if (!remoteChanged && localChanged) {
    if (localHash !== undefined) {
      plan.pushUpdates.push(path);
    } else {
      plan.pushDeletes.push(path);
    }
    return;
  }

  // Both sides changed: if both deleted, they converged; otherwise preserve local edits as a conflict.
  if (remoteSha === undefined && localHash === undefined) {
    return;
  }

  plan.conflicts.push(path);
  if (localHash !== undefined) {
    plan.pushUpdates.push(path);
  } else {
    plan.pushDeletes.push(path);
  }
}

function resolveTargetPushBranch(
  activeConflictBranch: string | null,
  hasConflict: boolean,
): TargetPushBranch {
  if (activeConflictBranch) {
    return 'active-conflict';
  }
  return hasConflict ? 'conflict' : 'target';
}

/**
 * Computes a deterministic 3-way sync plan comparing the last synced baseline (`state.files`),
 * the current remote tree (`remoteTextFiles`), and local vault hashes (`localHashes`).
 *
 * Locally modified files are never overwritten by pull operations, and when
 * `state.activeConflictBranch` is open, pushes remain targeted at `'active-conflict'`.
 */
export function computeSyncPlan(params: ComputeSyncPlanParams): SyncPlan {
  const { state, remoteTextFiles, localHashes } = params;

  const plan: SyncPlan = {
    pullDownloads: [],
    pullDeletes: [],
    pushCreates: [],
    pushUpdates: [],
    pushDeletes: [],
    conflicts: [],
    hasConflict: false,
    targetPushBranch: 'target',
  };

  if (state.lastSyncedCommitSha === null) {
    if (Object.keys(localHashes).length > 0) {
      throw new Error(
        'Initial sync requires an empty vault; existing local text files detected.',
      );
    }
    plan.pullDownloads = Object.keys(remoteTextFiles).sort();
    plan.targetPushBranch = resolveTargetPushBranch(state.activeConflictBranch, false);
    return plan;
  }

  const allPaths = Array.from(
    new Set([
      ...Object.keys(state.files),
      ...Object.keys(remoteTextFiles),
      ...Object.keys(localHashes),
    ]),
  ).sort();

  for (const path of allPaths) {
    const base = state.files[path];
    const remoteSha = remoteTextFiles[path];
    const localHash = localHashes[path];

    if (!base) {
      classifyUntrackedPath(path, remoteSha, localHash, plan);
    } else {
      classifyTrackedPath(path, base, remoteSha, localHash, plan);
    }
  }

  plan.hasConflict = plan.conflicts.length > 0;
  plan.targetPushBranch = resolveTargetPushBranch(
    state.activeConflictBranch,
    plan.hasConflict,
  );

  return plan;
}
