import { createHash } from 'node:crypto';
import type { RequestUrlFn, RequestUrlResponse } from '../../src/remote/http';
import type { RemoteCommitAction } from '../../src/types';

export interface FakeGitHubServerOptions {
  expectedToken?: string;
}

export interface GitHubMergeBranchOptions {
  resolvedFiles?: Record<string, string | Uint8Array | ArrayBuffer | null>;
}

interface StoredBlob {
  id: string;
  bytes: Uint8Array;
}

interface CommitRecord {
  id: string;
  treeSha: string;
  parentIds: string[];
  files: Map<string, StoredBlob>;
}

class GitHubHttpError extends Error {
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

function computeTreeSha(files: Map<string, StoredBlob>): string {
  const hash = createHash('sha1');
  const sorted = Array.from(files.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, blob] of sorted) {
    hash.update(`${path}:${blob.id}\0`);
  }
  return hash.digest('hex');
}

function normalizeRepoPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    throw new GitHubHttpError(400, 'file_path cannot be empty');
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

/**
 * Stateful in-memory GitHub REST API simulator for end-to-end sync integration tests.
 */
export class FakeGitHubServer {
  private readonly expectedToken?: string;
  private readonly branches = new Map<string, string>();
  private readonly commits = new Map<string, CommitRecord>();
  private readonly blobs = new Map<string, StoredBlob>();
  private readonly trees = new Map<string, Map<string, StoredBlob>>();
  private commitSeq = 0;

  constructor(options: FakeGitHubServerOptions = {}) {
    this.expectedToken = options.expectedToken;
  }

  readonly requestFn: RequestUrlFn = async (req) => {
    try {
      const auth = getHeaderCaseInsensitive(req.headers, 'Authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : undefined;
      if (!token || (this.expectedToken !== undefined && token !== this.expectedToken)) {
        return jsonResponse(401, { message: 'Bad credentials' });
      }

      const url = new URL(req.url);
      const match = /^\/repos\/[^/]+\/[^/]+\/(.*)$/.exec(url.pathname);
      if (!match) {
        return jsonResponse(404, { message: 'Not Found' });
      }

      const repoPath = match[1];
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET') {
        const branchMatch = /^branches\/(.+)$/.exec(repoPath);
        if (branchMatch) {
          const branch = decodeURIComponent(branchMatch[1]);
          const headSha = this.branches.get(branch);
          if (!headSha) {
            return jsonResponse(404, { message: 'Branch not found' });
          }
          const commit = this.commits.get(headSha)!;
          return jsonResponse(200, {
            name: branch,
            commit: { sha: headSha, commit: { tree: { sha: commit.treeSha } } },
          });
        }

        const treeMatch = /^git\/trees\/(.+)$/.exec(repoPath);
        if (treeMatch) {
          const ref = decodeURIComponent(treeMatch[1]);
          const files = this.resolveTreeFiles(ref);
          if (!files) {
            return jsonResponse(404, { message: 'Not Found' });
          }
          const treeSha = computeTreeSha(files);
          const tree = Array.from(files.entries())
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([path, blob]) => ({
              path,
              sha: blob.id,
              type: 'blob',
              mode: '100644',
            }));
          return jsonResponse(200, { sha: treeSha, truncated: false, tree });
        }

        const contentsMatch = /^contents\/(.+)$/.exec(repoPath);
        if (contentsMatch) {
          const filePath = normalizeRepoPath(
            contentsMatch[1].split('/').map(decodeURIComponent).join('/'),
          );
          const ref = url.searchParams.get('ref') ?? '';
          const commit = this.resolveRef(ref);
          if (!commit) {
            return jsonResponse(404, { message: 'No commit found for the ref' });
          }
          const blob = commit.files.get(filePath);
          if (!blob) {
            return jsonResponse(404, { message: 'Not Found' });
          }
          return rawResponse(200, blob.bytes);
        }

        const commitMatch = /^git\/commits\/(.+)$/.exec(repoPath);
        if (commitMatch) {
          const sha = decodeURIComponent(commitMatch[1]);
          const commit = this.commits.get(sha);
          if (!commit) {
            return jsonResponse(404, { message: 'Not Found' });
          }
          return jsonResponse(200, {
            sha: commit.id,
            tree: { sha: commit.treeSha },
            parents: commit.parentIds.map((p) => ({ sha: p })),
          });
        }

        return jsonResponse(404, { message: 'Not Found' });
      }

      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};

      if (method === 'POST' && repoPath === 'git/blobs') {
        const content = typeof body.content === 'string' ? body.content : '';
        const encoding = body.encoding === 'base64' ? 'base64' : 'utf-8';
        const bytes =
          encoding === 'base64'
            ? new Uint8Array(Buffer.from(content, 'base64'))
            : new TextEncoder().encode(content);
        const blob = makeBlob(bytes);
        this.blobs.set(blob.id, blob);
        return jsonResponse(201, { sha: blob.id });
      }

      if (method === 'POST' && repoPath === 'git/trees') {
        const baseTreeSha = typeof body.base_tree === 'string' ? body.base_tree : undefined;
        const baseFiles = baseTreeSha ? this.trees.get(baseTreeSha) : new Map<string, StoredBlob>();
        if (baseTreeSha && !baseFiles) {
          return jsonResponse(422, { message: `base_tree ${baseTreeSha} not found` });
        }
        const nextFiles = new Map(baseFiles);
        const entries = Array.isArray(body.tree)
          ? (body.tree as Array<{ path?: string; sha?: string | null }>)
          : [];
        for (const entry of entries) {
          const filePath = normalizeRepoPath(String(entry.path ?? ''));
          if (entry.sha === null) {
            nextFiles.delete(filePath);
          } else if (typeof entry.sha === 'string') {
            const blob = this.blobs.get(entry.sha);
            if (!blob) {
              return jsonResponse(422, { message: `blob ${entry.sha} not found` });
            }
            nextFiles.set(filePath, blob);
          }
        }
        const treeSha = computeTreeSha(nextFiles);
        this.trees.set(treeSha, nextFiles);
        return jsonResponse(201, { sha: treeSha });
      }

      if (method === 'POST' && repoPath === 'git/commits') {
        const treeSha = typeof body.tree === 'string' ? body.tree : '';
        const files = this.trees.get(treeSha);
        if (!files) {
          return jsonResponse(422, { message: `tree ${treeSha} not found` });
        }
        const parents = Array.isArray(body.parents)
          ? body.parents.filter((p): p is string => typeof p === 'string')
          : [];
        const commitId = this.createCommitRecord(new Map(files), parents, treeSha);
        return jsonResponse(201, { sha: commitId, tree: { sha: treeSha } });
      }

      if (method === 'POST' && repoPath === 'git/refs') {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        const branch = ref.replace(/^refs\/heads\//, '');
        if (!branch || !this.commits.has(sha)) {
          return jsonResponse(422, { message: 'Invalid ref or sha' });
        }
        if (this.branches.has(branch)) {
          return jsonResponse(422, { message: 'Reference already exists' });
        }
        this.branches.set(branch, sha);
        return jsonResponse(201, { ref: `refs/heads/${branch}`, object: { sha } });
      }

      if (method === 'PATCH' && repoPath.startsWith('git/refs/heads/')) {
        const encodedBranch = repoPath.slice('git/refs/heads/'.length);
        const branch = encodedBranch.split('/').map(decodeURIComponent).join('/');
        const currentSha = this.branches.get(branch);
        if (!currentSha) {
          return jsonResponse(404, { message: 'Reference not found' });
        }
        const sha = typeof body.sha === 'string' ? body.sha : '';
        const force = body.force === true;
        const nextCommit = this.commits.get(sha);
        if (!nextCommit) {
          return jsonResponse(422, { message: 'Commit not found' });
        }
        if (!force && !nextCommit.parentIds.includes(currentSha)) {
          return jsonResponse(422, { message: 'Update is not a fast forward' });
        }
        this.branches.set(branch, sha);
        return jsonResponse(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }

      return jsonResponse(404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof GitHubHttpError) {
        return jsonResponse(err.status, { message: err.message });
      }
      return jsonResponse(500, { message: err instanceof Error ? err.message : String(err) });
    }
  };

  seedBranch(branch: string, files: Record<string, string | Uint8Array | ArrayBuffer>): string {
    const fileMap = new Map<string, StoredBlob>();
    for (const [rawPath, content] of Object.entries(files)) {
      const path = normalizeRepoPath(rawPath);
      const blob = makeBlob(toBytes(content));
      this.blobs.set(blob.id, blob);
      fileMap.set(path, blob);
    }
    const commitId = this.createCommitRecord(fileMap, []);
    this.branches.set(branch, commitId);
    return commitId;
  }

  commitOnBranch(branch: string, _commitMessage: string, actions: RemoteCommitAction[]): string {
    const parentSha = this.branches.get(branch);
    if (!parentSha) {
      throw new Error(`Branch not found: ${branch}`);
    }
    const parentCommit = this.commits.get(parentSha)!;
    const nextFiles = this.applyActions(parentCommit.files, actions);
    const commitId = this.createCommitRecord(nextFiles, [parentSha]);
    this.branches.set(branch, commitId);
    return commitId;
  }

  mergeBranch(
    sourceBranch: string,
    targetBranch: string,
    options: GitHubMergeBranchOptions = {},
  ): string {
    const sourceSha = this.branches.get(sourceBranch);
    const targetSha = this.branches.get(targetBranch);
    if (!sourceSha) {
      throw new Error(`Source branch not found: ${sourceBranch}`);
    }
    if (!targetSha) {
      throw new Error(`Target branch not found: ${targetBranch}`);
    }

    const sourceFiles = this.commits.get(sourceSha)!.files;
    const targetFiles = this.commits.get(targetSha)!.files;
    const merged = new Map<string, StoredBlob>(targetFiles);

    for (const [path, blob] of sourceFiles.entries()) {
      if (!merged.has(path)) {
        merged.set(path, blob);
      }
    }

    if (options.resolvedFiles) {
      for (const [rawPath, content] of Object.entries(options.resolvedFiles)) {
        const path = normalizeRepoPath(rawPath);
        if (content === null) {
          merged.delete(path);
        } else {
          const blob = makeBlob(toBytes(content));
          this.blobs.set(blob.id, blob);
          merged.set(path, blob);
        }
      }
    }

    const mergeCommitId = this.createCommitRecord(merged, [targetSha, sourceSha]);
    this.branches.set(targetBranch, mergeCommitId);
    return mergeCommitId;
  }

  deleteBranch(branch: string): void {
    if (!this.branches.delete(branch)) {
      throw new Error(`Branch not found: ${branch}`);
    }
  }

  getBranchFiles(branch: string): Record<string, Uint8Array> {
    const headSha = this.branches.get(branch);
    if (!headSha) {
      throw new Error(`Branch not found: ${branch}`);
    }
    const commit = this.commits.get(headSha)!;
    const result: Record<string, Uint8Array> = {};
    for (const [path, blob] of commit.files.entries()) {
      result[path] = new Uint8Array(blob.bytes);
    }
    return result;
  }

  private resolveRef(ref: string): CommitRecord | undefined {
    const branchHead = this.branches.get(ref);
    if (branchHead) {
      return this.commits.get(branchHead);
    }
    return this.commits.get(ref);
  }

  private resolveTreeFiles(ref: string): Map<string, StoredBlob> | undefined {
    const commit = this.resolveRef(ref);
    if (commit) {
      return commit.files;
    }
    return this.trees.get(ref);
  }

  private applyActions(
    baseFiles: Map<string, StoredBlob>,
    actions: RemoteCommitAction[],
  ): Map<string, StoredBlob> {
    const nextFiles = new Map(baseFiles);
    for (const action of actions) {
      const path = normalizeRepoPath(action.file_path);
      if (action.action === 'create') {
        if (nextFiles.has(path)) {
          throw new GitHubHttpError(422, `A file with this name already exists: ${path}`);
        }
        const bytes =
          action.encoding === 'base64'
            ? new Uint8Array(Buffer.from(action.content ?? '', 'base64'))
            : toBytes(action.content ?? '');
        const blob = makeBlob(bytes);
        this.blobs.set(blob.id, blob);
        nextFiles.set(path, blob);
      } else if (action.action === 'update') {
        if (!nextFiles.has(path)) {
          throw new GitHubHttpError(422, `A file with this name doesn't exist: ${path}`);
        }
        const bytes =
          action.encoding === 'base64'
            ? new Uint8Array(Buffer.from(action.content ?? '', 'base64'))
            : toBytes(action.content ?? '');
        const blob = makeBlob(bytes);
        this.blobs.set(blob.id, blob);
        nextFiles.set(path, blob);
      } else if (action.action === 'delete') {
        if (!nextFiles.has(path)) {
          throw new GitHubHttpError(422, `A file with this name doesn't exist: ${path}`);
        }
        nextFiles.delete(path);
      }
    }
    return nextFiles;
  }

  private createCommitRecord(
    files: Map<string, StoredBlob>,
    parentIds: string[],
    explicitTreeSha?: string,
  ): string {
    const seq = ++this.commitSeq;
    const id = createHash('sha1').update(`gh-commit-${seq}`).digest('hex');
    const treeSha = explicitTreeSha ?? computeTreeSha(files);
    this.trees.set(treeSha, new Map(files));
    this.commits.set(id, { id, treeSha, parentIds, files });
    return id;
  }
}
