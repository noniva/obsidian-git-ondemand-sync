import { describe, it, expect } from 'vitest';
import { computeSyncPlan } from '../src/sync/diff';
import type { SyncState } from '../src/types';

const emptyState: SyncState = {
  lastSyncedCommitSha: null,
  activeConflictBranch: null,
  files: {},
  remoteImagePaths: [],
};

describe('computeSyncPlan', () => {
  it('pulls all remote text files on empty initial vault', () => {
    const plan = computeSyncPlan({
      state: emptyState,
      remoteTextFiles: { 'a.md': 'sha1', 'sub/b.md': 'sha2' },
      localHashes: {},
    });
    expect(plan.pullDownloads).toEqual(['a.md', 'sub/b.md']);
    expect(plan.pullDeletes).toEqual([]);
    expect(plan.pushCreates).toEqual([]);
    expect(plan.pushUpdates).toEqual([]);
    expect(plan.pushDeletes).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.hasConflict).toBe(false);
    expect(plan.targetPushBranch).toBe('target');
  });

  it('throws if initial sync has existing local files', () => {
    expect(() =>
      computeSyncPlan({
        state: emptyState,
        remoteTextFiles: { 'a.md': 'sha1' },
        localHashes: { 'existing.md': 'h1' },
      }),
    ).toThrow(/empty vault/i);
  });

  it('handles remote create, update, and delete when local is unchanged', () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {
        'updated.md': { blobSha: 'r0', contentHash: 'h0' },
        'deleted.md': { blobSha: 'rd0', contentHash: 'hd0' },
        'same.md': { blobSha: 'rs0', contentHash: 'hs0' },
      },
      remoteImagePaths: [],
    };
    const plan = computeSyncPlan({
      state,
      remoteTextFiles: {
        'created.md': 'rc1',
        'updated.md': 'r1',
        'same.md': 'rs0',
      },
      localHashes: {
        'updated.md': 'h0',
        'deleted.md': 'hd0',
        'same.md': 'hs0',
      },
    });
    expect(plan.pullDownloads).toEqual(['created.md', 'updated.md']);
    expect(plan.pullDeletes).toEqual(['deleted.md']);
    expect(plan.pushCreates).toEqual([]);
    expect(plan.pushUpdates).toEqual([]);
    expect(plan.pushDeletes).toEqual([]);
    expect(plan.hasConflict).toBe(false);
    expect(plan.targetPushBranch).toBe('target');
  });

  it('handles local create, update, and delete when remote is unchanged', () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {
        'updated.md': { blobSha: 'r0', contentHash: 'h0' },
        'deleted.md': { blobSha: 'rd0', contentHash: 'hd0' },
        'same.md': { blobSha: 'rs0', contentHash: 'hs0' },
      },
      remoteImagePaths: [],
    };
    const plan = computeSyncPlan({
      state,
      remoteTextFiles: {
        'updated.md': 'r0',
        'deleted.md': 'rd0',
        'same.md': 'rs0',
      },
      localHashes: {
        'created.md': 'hc1',
        'updated.md': 'h1',
        'same.md': 'hs0',
      },
    });
    expect(plan.pullDownloads).toEqual([]);
    expect(plan.pullDeletes).toEqual([]);
    expect(plan.pushCreates).toEqual(['created.md']);
    expect(plan.pushUpdates).toEqual(['updated.md']);
    expect(plan.pushDeletes).toEqual(['deleted.md']);
    expect(plan.hasConflict).toBe(false);
    expect(plan.targetPushBranch).toBe('target');
  });

  it('detects conflict when both remote blobSha and local contentHash changed', () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {
        'a.md': { blobSha: 'r0', contentHash: 'h0' },
        'b.md': { blobSha: 'rb0', contentHash: 'hb0' },
      },
      remoteImagePaths: [],
    };
    const plan = computeSyncPlan({
      state,
      remoteTextFiles: { 'a.md': 'r1', 'b.md': 'rb0' },
      localHashes: { 'a.md': 'h1', 'b.md': 'hb1' },
    });
    expect(plan.hasConflict).toBe(true);
    expect(plan.conflicts).toEqual(['a.md']);
    expect(plan.targetPushBranch).toBe('conflict');
    expect(plan.pushUpdates).toEqual(['a.md', 'b.md']);
    expect(plan.pullDownloads).toEqual([]);
  });

  it('detects conflicts on dual create, remote delete vs local edit, and remote edit vs local delete', () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: null,
      files: {
        'remote-del-local-edit.md': { blobSha: 'r0', contentHash: 'h0' },
        'remote-edit-local-del.md': { blobSha: 'r1', contentHash: 'h1' },
        'both-deleted.md': { blobSha: 'r2', contentHash: 'h2' },
      },
      remoteImagePaths: [],
    };
    const plan = computeSyncPlan({
      state,
      remoteTextFiles: {
        'both-created.md': 'rbc',
        'remote-edit-local-del.md': 'r1-new',
      },
      localHashes: {
        'both-created.md': 'hbc',
        'remote-del-local-edit.md': 'h0-new',
      },
    });
    expect(plan.hasConflict).toBe(true);
    expect(plan.conflicts).toEqual([
      'both-created.md',
      'remote-del-local-edit.md',
      'remote-edit-local-del.md',
    ]);
    expect(plan.pushCreates).toEqual(['both-created.md']);
    expect(plan.pushUpdates).toEqual(['remote-del-local-edit.md']);
    expect(plan.pushDeletes).toEqual(['remote-edit-local-del.md']);
    expect(plan.pullDownloads).toEqual([]);
    expect(plan.pullDeletes).toEqual([]);
    expect(plan.targetPushBranch).toBe('conflict');
  });

  it('pulls non-conflicting remote changes and pushes to activeConflictBranch when one is open', () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261119-040000',
      files: {
        'a.md': { blobSha: 'r0', contentHash: 'h0' },
        'clean.md': { blobSha: 'rc0', contentHash: 'hc0' },
      },
      remoteImagePaths: [],
    };
    const plan = computeSyncPlan({
      state,
      remoteTextFiles: { 'a.md': 'r1', 'clean.md': 'rc1' },
      localHashes: { 'a.md': 'h1', 'clean.md': 'hc0' },
    });
    expect(plan.pullDownloads).toEqual(['clean.md']);
    expect(plan.targetPushBranch).toBe('active-conflict');
    expect(plan.pushUpdates).toEqual(['a.md']);
    expect(plan.hasConflict).toBe(true);
    expect(plan.conflicts).toEqual(['a.md']);
  });

  it('routes non-conflicting local edits to active-conflict when activeConflictBranch is open', () => {
    const state: SyncState = {
      lastSyncedCommitSha: 'c0',
      activeConflictBranch: 'mobile-conflict/20261119-040000',
      files: {
        'a.md': { blobSha: 'r0', contentHash: 'h0' },
        'removed.md': { blobSha: 'rr0', contentHash: 'hr0' },
      },
      remoteImagePaths: [],
    };
    const plan = computeSyncPlan({
      state,
      remoteTextFiles: { 'a.md': 'r0' },
      localHashes: { 'a.md': 'h1', 'removed.md': 'hr0', 'new.md': 'hn1' },
    });
    expect(plan.pullDeletes).toEqual(['removed.md']);
    expect(plan.pushCreates).toEqual(['new.md']);
    expect(plan.pushUpdates).toEqual(['a.md']);
    expect(plan.hasConflict).toBe(false);
    expect(plan.targetPushBranch).toBe('active-conflict');
  });
});
