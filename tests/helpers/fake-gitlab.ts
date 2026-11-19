import { createHash } from 'node:crypto';
import type { RequestUrlFn, RequestUrlResponse } from '../../src/gitlab/client';
import type { GitLabCommitAction, GitLabTreeEntry } from '../../src/types';

export interface FakeGitLabServerOptions {
  pageSize?: number;
  expectedToken?: string;
}

export interface MergeBranchOptions {
  resolvedFiles?: Record<string, string | Uint8Array | ArrayBuffer | null>;
}

export interface BeforeCommitInfo {
  branch: string;
  commitMessage: string;
  actions: GitLabCommitAction[];
  startSha?: string;
}

export type BeforeCommitHook = (commit: BeforeCommitInfo) => void | Promise<void>;

interface StoredBlob {
  id: string;
  bytes: Uint8Array;
}

interface CommitRecord {
  id: string;
  parentIds: string[];
  files: Map<string, StoredBlob>;
}

class GitLabHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function toBytes(content: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return new Uint8Array(content);
  }
  return new Uint8Array(content.slice(0));
}

function makeBlob(bytes: Uint8Array): StoredBlob {
  const id = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
  return { id, bytes };
}

function decodeBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function normalizeRepoPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    throw new GitLabHttpError(400, 'file_path cannot be empty');
  }
  return normalized;
}

function getHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): RequestUrlResponse {
  const text = JSON.stringify(body);
  const encoded = new TextEncoder().encode(text);
  return {
    status,
    text,
    arrayBuffer: encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
    json: body,
    headers,
  };
}

function rawResponse(status: number, bytes: Uint8Array): RequestUrlResponse {
  const copy = new Uint8Array(bytes);
  return {
    status,
    text: new TextDecoder().decode(copy),
    arrayBuffer: copy.buffer,
    json: null,
    headers: {},
  };
}

function baseNameOf(repoPath: string): string {
  const idx = repoPath.lastIndexOf('/');
  return idx >= 0 ? repoPath.slice(idx + 1) : repoPath;
}

/**
 * Stateful in-memory GitLab REST API v4 simulator for end-to-end sync integration tests.
 */
export class FakeGitLabServer {
  private readonly pageSize?: number;
  private readonly expectedToken?: string;
  private readonly branches = new Map<string, string>();
  private readonly commits = new Map<string, CommitRecord>();
  private commitSeq = 0;
  private pendingRawFailurePath: string | null | undefined = undefined;
  private beforeCommitHook: BeforeCommitHook | null = null;

  constructor(options: FakeGitLabServerOptions = {}) {
    this.pageSize = options.pageSize;
    this.expectedToken = options.expectedToken;
  }

  readonly requestFn: RequestUrlFn = async (req) => {
    try {
      const token = getHeaderCaseInsensitive(req.headers, 'PRIVATE-TOKEN');
      if (!token || (this.expectedToken !== undefined && token !== this.expectedToken)) {
        return jsonResponse(401, { message: '401 Unauthorized' });
      }

      const url = new URL(req.url);
      const match = /^\/api\/v4\/projects\/[^/]+\/repository\/(.*)$/.exec(url.pathname);
      if (!match) {
        return jsonResponse(404, { message: '404 Not Found' });
      }

      const repoPath = match[1];
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET') {
        const branchMatch = /^branches\/(.+)$/.exec(repoPath);
        if (branchMatch) {
          const branch = decodeURIComponent(branchMatch[1]);
          const headSha = this.branches.get(branch);
          if (!headSha) {
            return jsonResponse(404, { message: '404 Branch Not Found' });
          }
          return jsonResponse(200, { name: branch, commit: { id: headSha } });
        }

        if (repoPath === 'tree') {
          const ref = url.searchParams.get('ref') ?? '';
          const commit = this.resolveRef(ref);
          if (!commit) {
            return jsonResponse(404, { message: '404 Tree Not Found' });
          }
          const entries: GitLabTreeEntry[] = Array.from(commit.files.entries())
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([path, blob]) => ({
              id: blob.id,
              name: baseNameOf(path),
              type: 'blob',
              path,
              mode: '100644',
            }));

          const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
          const queryPerPage = Math.max(
            1,
            Number.parseInt(url.searchParams.get('per_page') ?? '100', 10) || 100,
          );
          const perPage = this.pageSize ?? queryPerPage;
          const start = (page - 1) * perPage;
          const slice = entries.slice(start, start + perPage);
          const hasNext = start + perPage < entries.length;
          return jsonResponse(200, slice, {
            'x-next-page': hasNext ? String(page + 1) : '',
          });
        }

        const rawMatch = /^files\/(.+)\/raw$/.exec(repoPath);
        if (rawMatch) {
          const filePath = normalizeRepoPath(decodeURIComponent(rawMatch[1]));
          if (this.consumeRawFailure(filePath)) {
            return jsonResponse(500, { message: 'Injected raw fetch failure' });
          }

          const ref = url.searchParams.get('ref') ?? '';
          const commit = this.resolveRef(ref);
          const blob = commit?.files.get(filePath);
          if (!blob) {
            return jsonResponse(404, { message: '404 File Not Found' });
          }
          return rawResponse(200, blob.bytes);
        }
      }

      if (method === 'POST' && repoPath === 'commits') {
        const parsed = JSON.parse(req.body ?? '{}') as {
          branch?: string;
          commit_message?: string;
          actions?: GitLabCommitAction[];
          start_sha?: string;
        };
        if (!parsed.branch || !Array.isArray(parsed.actions)) {
          return jsonResponse(400, { message: 'branch and actions are required' });
        }

        const commitInfo: BeforeCommitInfo = {
          branch: parsed.branch,
          commitMessage: parsed.commit_message ?? '',
          actions: parsed.actions,
          startSha: parsed.start_sha,
        };
        if (this.beforeCommitHook) {
          await this.beforeCommitHook(commitInfo);
        }

        const commitId = this.commitOnBranch(
          commitInfo.branch,
          commitInfo.commitMessage,
          commitInfo.actions,
          commitInfo.startSha,
        );
        return jsonResponse(201, { id: commitId });
      }

      return jsonResponse(404, { message: `404 Unknown route: ${method} ${repoPath}` });
    } catch (err) {
      if (err instanceof GitLabHttpError) {
        return jsonResponse(err.status, { message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { message });
    }
  };

  seedBranch(
    branch: string,
    files: Record<string, string | Uint8Array | ArrayBuffer>,
  ): string {
    if (this.branches.has(branch)) {
      throw new Error(`Branch "${branch}" already exists`);
    }
    const storedFiles = new Map<string, StoredBlob>();
    for (const [rawPath, content] of Object.entries(files)) {
      storedFiles.set(normalizeRepoPath(rawPath), makeBlob(toBytes(content)));
    }
    const commitId = this.recordCommit([], 'Initial commit', storedFiles);
    this.branches.set(branch, commitId);
    return commitId;
  }

  commitOnBranch(
    branch: string,
    message: string,
    actions: GitLabCommitAction[],
    startSha?: string,
  ): string {
    if (actions.length === 0) {
      throw new GitLabHttpError(400, 'Provide at least one action, or set allow_empty');
    }

    let parentId: string;
    let baseFiles: Map<string, StoredBlob>;

    if (startSha !== undefined) {
      if (this.branches.has(branch)) {
        throw new GitLabHttpError(400, `Branch "${branch}" already exists`);
      }
      const startCommit = this.commits.get(startSha);
      if (!startCommit) {
        throw new GitLabHttpError(400, `Invalid start_sha "${startSha}"`);
      }
      parentId = startSha;
      baseFiles = new Map(startCommit.files);
    } else {
      const headSha = this.branches.get(branch);
      if (!headSha) {
        throw new GitLabHttpError(404, `404 Branch Not Found: ${branch}`);
      }
      const headCommit = this.commits.get(headSha)!;
      parentId = headSha;
      baseFiles = new Map(headCommit.files);
    }

    const nextFiles = new Map(baseFiles);
    for (const action of actions) {
      const filePath = normalizeRepoPath(action.file_path);
      if (action.action === 'create') {
        if (nextFiles.has(filePath)) {
          throw new GitLabHttpError(400, `A file with this name already exists: ${filePath}`);
        }
        if (action.content === undefined) {
          throw new GitLabHttpError(400, `Missing content for create: ${filePath}`);
        }
        const bytes =
          action.encoding === 'base64' ? decodeBase64(action.content) : toBytes(action.content);
        nextFiles.set(filePath, makeBlob(bytes));
      } else if (action.action === 'update') {
        if (!nextFiles.has(filePath)) {
          throw new GitLabHttpError(400, `A file with this name doesn't exist: ${filePath}`);
        }
        if (action.content === undefined) {
          throw new GitLabHttpError(400, `Missing content for update: ${filePath}`);
        }
        const bytes =
          action.encoding === 'base64' ? decodeBase64(action.content) : toBytes(action.content);
        nextFiles.set(filePath, makeBlob(bytes));
      } else if (action.action === 'delete') {
        if (!nextFiles.has(filePath)) {
          throw new GitLabHttpError(400, `A file with this name doesn't exist: ${filePath}`);
        }
        nextFiles.delete(filePath);
      } else {
        throw new GitLabHttpError(400, `Unsupported commit action: ${String(action.action)}`);
      }
    }

    const commitId = this.recordCommit([parentId], message, nextFiles);
    this.branches.set(branch, commitId);
    return commitId;
  }

  /**
   * Performs a 3-way merge of `sourceBranch` into `targetBranch` using their lowest common ancestor,
   * applying optional `resolvedFiles` overrides (or `null` to delete a path in the merge commit).
   */
  mergeBranch(
    sourceBranch: string,
    targetBranch: string,
    options: MergeBranchOptions = {},
  ): string {
    const sourceHead = this.branches.get(sourceBranch);
    if (!sourceHead) {
      throw new Error(`Source branch "${sourceBranch}" does not exist`);
    }
    const targetHead = this.branches.get(targetBranch);
    if (!targetHead) {
      throw new Error(`Target branch "${targetBranch}" does not exist`);
    }

    const sourceCommit = this.commits.get(sourceHead)!;
    const targetCommit = this.commits.get(targetHead)!;
    const baseCommit = this.findLowestCommonAncestor(sourceHead, targetHead);
    const baseFiles = baseCommit?.files ?? new Map<string, StoredBlob>();

    const resolvedOverrides = new Map<string, string | Uint8Array | ArrayBuffer | null>();
    for (const [rawPath, content] of Object.entries(options.resolvedFiles ?? {})) {
      resolvedOverrides.set(normalizeRepoPath(rawPath), content);
    }

    const allPaths = new Set<string>([
      ...baseFiles.keys(),
      ...targetCommit.files.keys(),
      ...sourceCommit.files.keys(),
      ...resolvedOverrides.keys(),
    ]);

    const mergedFiles = new Map<string, StoredBlob>();
    for (const path of allPaths) {
      if (resolvedOverrides.has(path)) {
        const override = resolvedOverrides.get(path)!;
        if (override !== null) {
          mergedFiles.set(path, makeBlob(toBytes(override)));
        }
        continue;
      }

      const baseBlob = baseFiles.get(path);
      const targetBlob = targetCommit.files.get(path);
      const sourceBlob = sourceCommit.files.get(path);

      if (targetBlob?.id === sourceBlob?.id) {
        if (targetBlob) {
          mergedFiles.set(path, targetBlob);
        }
      } else if (sourceBlob?.id === baseBlob?.id) {
        if (targetBlob) {
          mergedFiles.set(path, targetBlob);
        }
      } else if (targetBlob?.id === baseBlob?.id) {
        if (sourceBlob) {
          mergedFiles.set(path, sourceBlob);
        }
      } else {
        throw new Error(
          `3-way merge conflict on "${path}"; provide resolvedFiles["${path}"]`,
        );
      }
    }

    const mergeCommitId = this.recordCommit(
      [targetHead, sourceHead],
      `Merge branch '${sourceBranch}' into '${targetBranch}'`,
      mergedFiles,
    );
    this.branches.set(targetBranch, mergeCommitId);
    return mergeCommitId;
  }

  deleteBranch(branch: string): void {
    if (!this.branches.delete(branch)) {
      throw new Error(`Branch "${branch}" does not exist`);
    }
  }

  failNextRawFetch(path?: string): void {
    this.pendingRawFailurePath = path ? normalizeRepoPath(path) : null;
  }

  onBeforeCommit(hook: BeforeCommitHook | null): void {
    this.beforeCommitHook = hook;
  }

  getBranchFiles(branch: string): Record<string, Uint8Array> {
    const headSha = this.branches.get(branch);
    if (!headSha) {
      throw new Error(`Branch "${branch}" does not exist`);
    }
    const commit = this.commits.get(headSha)!;
    const out: Record<string, Uint8Array> = {};
    for (const [path, blob] of commit.files.entries()) {
      out[path] = new Uint8Array(blob.bytes);
    }
    return out;
  }

  private resolveRef(ref: string): CommitRecord | undefined {
    const branchHead = this.branches.get(ref);
    if (branchHead) {
      return this.commits.get(branchHead);
    }
    return this.commits.get(ref);
  }

  private consumeRawFailure(filePath: string): boolean {
    if (this.pendingRawFailurePath === undefined) {
      return false;
    }
    if (this.pendingRawFailurePath !== null && this.pendingRawFailurePath !== filePath) {
      return false;
    }
    this.pendingRawFailurePath = undefined;
    return true;
  }

  private findLowestCommonAncestor(commitA: string, commitB: string): CommitRecord | undefined {
    const collectDistances = (start: string): Map<string, number> => {
      const dist = new Map<string, number>([[start, 0]]);
      const queue: string[] = [start];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const curDist = dist.get(cur)!;
        const record = this.commits.get(cur);
        if (!record) {
          continue;
        }
        for (const parent of record.parentIds) {
          if (!dist.has(parent)) {
            dist.set(parent, curDist + 1);
            queue.push(parent);
          }
        }
      }
      return dist;
    };

    const distA = collectDistances(commitA);
    const distB = collectDistances(commitB);
    let bestId: string | undefined;
    let bestScore = Infinity;
    for (const [id, dA] of distA) {
      const dB = distB.get(id);
      if (dB !== undefined && dA + dB < bestScore) {
        bestScore = dA + dB;
        bestId = id;
      }
    }
    return bestId ? this.commits.get(bestId) : undefined;
  }

  private recordCommit(
    parentIds: string[],
    message: string,
    files: Map<string, StoredBlob>,
  ): string {
    this.commitSeq++;
    const hash = createHash('sha1');
    hash.update(`${this.commitSeq}:${parentIds.join(',')}:${message}\n`);
    const sorted = Array.from(files.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [path, blob] of sorted) {
      hash.update(`${path}:${blob.id}\n`);
    }
    const id = hash.digest('hex');
    this.commits.set(id, { id, parentIds, files });
    return id;
  }
}
