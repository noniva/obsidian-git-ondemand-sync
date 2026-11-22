import { requestUrl } from 'obsidian';
import {
  getHeaderCaseInsensitive,
  sendRemoteRequest,
  type RemoteClientConfig,
  type RequestUrlFn,
  type RequestUrlResponse,
} from '../remote/http';
import type {
  CreateCommitParams,
  RemoteCommitAction,
  RemoteCompareEntry,
  RemoteGitClient,
  RemoteTreeEntry,
} from '../types';

export type { CreateCommitParams, RequestUrlFn, RequestUrlResponse };
export type GitLabClientConfig = RemoteClientConfig;

const GRAPHQL_RAW_TEXTS_QUERY = `
  query($fullPath: ID!, $ref: String!, $paths: [String!]!) {
    project(fullPath: $fullPath) {
      repository {
        blobs(ref: $ref, paths: $paths) {
          nodes {
            path
            rawTextBlob
          }
        }
      }
    }
  }
`;

/**
 * Minimal GitLab REST & GraphQL API client backed by an injectable Obsidian `requestUrl`-compatible function.
 */
export class GitLabClient implements RemoteGitClient {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly encodedProjectId: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRateLimitWait?: (info: {
    waitMs: number;
    attempt: number;
    maxAttempts: number;
  }) => void;
  private readonly requestFn: RequestUrlFn;
  private resolvedFullPath: string | null = null;

  constructor(config: GitLabClientConfig, requestFn: RequestUrlFn = requestUrl) {
    this.baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
    this.projectId = config.projectId.trim();
    this.encodedProjectId = encodeURIComponent(this.projectId);
    this.token = config.token.trim();
    this.timeoutMs =
      config.timeoutMs !== undefined && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : 30_000;
    this.maxRateLimitRetries =
      config.maxRateLimitRetries !== undefined &&
      Number.isFinite(config.maxRateLimitRetries) &&
      config.maxRateLimitRetries >= 0
        ? Math.floor(config.maxRateLimitRetries)
        : 3;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
    this.onRateLimitWait = config.onRateLimitWait;
    this.requestFn = requestFn;
  }

  /** Fetches the head commit SHA of the given branch. */
  async getBranchHead(branch: string): Promise<string> {
    const res = await this.request(`/repository/branches/${encodeURIComponent(branch)}`);
    const data = res.json as { commit?: { id?: string } } | null;
    const sha = data?.commit?.id;
    if (!sha) {
      throw new Error(`GitLab API returned branch "${branch}" without a commit.id`);
    }
    return sha;
  }

  /** Fetches all tree entries recursively for a ref, parallelizing pages when `x-total-pages` is known. */
  async getTreeRecursive(
    ref: string,
    onPage?: (info: { page: number; totalPages?: number; entries: number }) => void,
  ): Promise<RemoteTreeEntry[]> {
    const encodedRef = encodeURIComponent(ref);
    const fetchPage = async (pageNum: string): Promise<RequestUrlResponse> => {
      const res = await this.request(
        `/repository/tree?recursive=true&per_page=100&ref=${encodedRef}&page=${encodeURIComponent(pageNum)}`,
      );
      if (!Array.isArray(res.json)) {
        throw new Error('GitLab API returned unexpected non-array response for repository tree');
      }
      return res;
    };

    const firstRes = await fetchPage('1');
    const firstEntries = firstRes.json as RemoteTreeEntry[];
    const rawTotalPages = getHeaderCaseInsensitive(firstRes.headers, 'x-total-pages')?.trim();
    const parsedTotal = rawTotalPages ? Number(rawTotalPages) : Number.NaN;
    const totalPages = Number.isInteger(parsedTotal) && parsedTotal > 0 ? parsedTotal : undefined;

    const entries: RemoteTreeEntry[] = [...firstEntries];
    onPage?.({
      page: 1,
      totalPages,
      entries: entries.length,
    });

    if (totalPages && totalPages > 1) {
      const pageResults = new Array<RemoteTreeEntry[]>(totalPages - 1);
      const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      let nextIdx = 0;
      let completedPages = 1;
      const workerCount = Math.min(6, remainingPages.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextIdx < remainingPages.length) {
          const pageNum = remainingPages[nextIdx++];
          const res = await fetchPage(String(pageNum));
          const pageEntries = res.json as RemoteTreeEntry[];
          pageResults[pageNum - 2] = pageEntries;
          completedPages++;
          onPage?.({
            page: completedPages,
            totalPages,
            entries: entries.length + pageEntries.length,
          });
        }
      });
      await Promise.all(workers);
      for (const pageEntries of pageResults) {
        entries.push(...pageEntries);
      }
      return entries;
    }

    const seenPages = new Set<string>(['1']);
    let page = getHeaderCaseInsensitive(firstRes.headers, 'x-next-page')?.trim() ?? '';
    if (page) {
      seenPages.add(page);
    }

    while (page) {
      const res = await fetchPage(page);
      entries.push(...(res.json as RemoteTreeEntry[]));
      onPage?.({
        page: seenPages.size,
        totalPages,
        entries: entries.length,
      });

      const nextPage = getHeaderCaseInsensitive(res.headers, 'x-next-page')?.trim() ?? '';
      if (nextPage) {
        if (seenPages.has(nextPage)) {
          throw new Error(`GitLab API pagination loop detected at page "${nextPage}"`);
        }
        seenPages.add(nextPage);
      }
      page = nextPage;
    }

    return entries;
  }

  /**
   * Compares two refs via GitLab `/repository/compare` and resolves `blobSha` for changed files.
   * Returns `null` on 404, timeout, or >= 100 diffs so callers can fall back to `getTreeRecursive`.
   */
  async compareCommits(fromRef: string, toRef: string): Promise<RemoteCompareEntry[] | null> {
    let res: RequestUrlResponse;
    try {
      res = await this.request(
        `/repository/compare?from=${encodeURIComponent(fromRef)}&to=${encodeURIComponent(toRef)}`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes('(404)')) {
        return null;
      }
      throw err;
    }

    const data = res.json as {
      compare_timeout?: boolean;
      diffs?: Array<{
        old_path?: string;
        new_path?: string;
        new_file?: boolean;
        renamed_file?: boolean;
        deleted_file?: boolean;
      }>;
    } | null;

    if (!data || data.compare_timeout === true || !Array.isArray(data.diffs)) {
      return null;
    }
    if (data.diffs.length >= 100) {
      return null;
    }

    const entries: RemoteCompareEntry[] = [];
    for (const d of data.diffs) {
      const newPath = d.new_path ?? d.old_path;
      if (!newPath) {
        continue;
      }
      if (d.deleted_file) {
        entries.push({ path: d.old_path ?? newPath, status: 'deleted' });
      } else if (d.renamed_file && d.old_path && d.old_path !== newPath) {
        entries.push({ path: newPath, previousPath: d.old_path, status: 'renamed' });
      } else if (d.new_file) {
        entries.push({ path: newPath, status: 'added' });
      } else {
        entries.push({ path: newPath, status: 'modified' });
      }
    }

    const needBlob = entries.filter((e) => e.status !== 'deleted');
    if (needBlob.length > 0) {
      let nextIdx = 0;
      let missingBlob = false;
      const encodedToRef = encodeURIComponent(toRef);
      const workerCount = Math.min(6, needBlob.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (!missingBlob && nextIdx < needBlob.length) {
          const entry = needBlob[nextIdx++];
          try {
            const meta = await this.request(
              `/repository/files/${encodeURIComponent(entry.path)}?ref=${encodedToRef}`,
            );
            const blobId = (meta.json as { blob_id?: string } | null)?.blob_id;
            if (!blobId) {
              missingBlob = true;
              return;
            }
            entry.blobSha = blobId;
          } catch (err) {
            if (err instanceof Error && err.message.includes('(404)')) {
              missingBlob = true;
              return;
            }
            throw err;
          }
        }
      });
      await Promise.all(workers);
      if (missingBlob) {
        return null;
      }
    }

    return entries;
  }

  /** Fetches raw UTF-8 text content of a file at the given ref. */
  async getRawText(filePath: string, ref: string): Promise<string> {
    const res = await this.fetchRawFile(filePath, ref);
    return res.text;
  }

  /**
   * Fetches raw UTF-8 text content for a batch of paths via GitLab GraphQL (`repository.blobs`).
   * Throws on 401/403/429 and returns an empty map when GraphQL is unavailable or errors so callers can fall back to REST.
   */
  async getRawTextsBatch(filePaths: string[], ref: string): Promise<Map<string, string>> {
    if (filePaths.length === 0) {
      return new Map();
    }

    const fullPath = await this.resolveProjectFullPath();
    if (!fullPath) {
      return new Map();
    }

    const res = await this.sendRequest(`${this.baseUrl}/api/graphql`, '/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: GRAPHQL_RAW_TEXTS_QUERY,
        variables: { fullPath, ref, paths: filePaths },
      }),
    });

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const detail = res.text ? `: ${res.text.slice(0, 300)}` : '';
      throw new Error(`GitLab API POST /api/graphql failed (${res.status})${detail}`);
    }
    if (res.status < 200 || res.status >= 300) {
      return new Map();
    }

    let parsed: unknown;
    try {
      parsed = res.json;
    } catch {
      return new Map();
    }
    if (!parsed || typeof parsed !== 'object') {
      return new Map();
    }

    const payload = parsed as {
      errors?: unknown;
      data?: {
        project?: {
          repository?: {
            blobs?: {
              nodes?: Array<{ path?: unknown; rawTextBlob?: unknown } | null> | null;
            } | null;
          } | null;
        } | null;
      } | null;
    };

    const nodes = payload.data?.project?.repository?.blobs?.nodes;
    const hasErrors = Array.isArray(payload.errors) && payload.errors.length > 0;
    if (!Array.isArray(nodes) || (hasErrors && nodes.length === 0)) {
      return new Map();
    }

    const result = new Map<string, string>();
    for (const node of nodes) {
      if (node && typeof node.path === 'string' && typeof node.rawTextBlob === 'string') {
        result.set(node.path, node.rawTextBlob);
      }
    }
    return result;
  }

  /** Fetches raw binary content of a file at the given ref. */
  async getRawBinary(filePath: string, ref: string): Promise<ArrayBuffer> {
    const res = await this.fetchRawFile(filePath, ref);
    return res.arrayBuffer;
  }

  /** Creates a multi-action commit on `branch` (optionally branching from `startSha`) and returns its SHA. */
  async createCommit(params: CreateCommitParams): Promise<string> {
    const payload: {
      branch: string;
      commit_message: string;
      actions: RemoteCommitAction[];
      start_sha?: string;
    } = {
      branch: params.branch,
      commit_message: params.commitMessage,
      actions: params.actions,
    };

    if (params.startSha !== undefined) {
      payload.start_sha = params.startSha;
    }

    const res = await this.request('/repository/commits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = res.json as { id?: string } | null;
    if (!data?.id) {
      throw new Error('GitLab API createCommit response did not contain a commit id');
    }
    return data.id;
  }

  private async resolveProjectFullPath(): Promise<string | null> {
    if (this.resolvedFullPath) {
      return this.resolvedFullPath;
    }

    if (this.projectId.includes('/')) {
      const trimmed = this.projectId.replace(/^\/+|\/+$/g, '');
      if (trimmed) {
        this.resolvedFullPath = trimmed;
        return trimmed;
      }
    }

    const res = await this.sendRequest(
      `${this.baseUrl}/api/v4/projects/${this.encodedProjectId}`,
      '/projects/:id',
    );
    if (res.status < 200 || res.status >= 300) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = res.json;
    } catch {
      return null;
    }

    const fullPath =
      parsed && typeof parsed === 'object'
        ? (parsed as { path_with_namespace?: unknown }).path_with_namespace
        : undefined;
    if (typeof fullPath === 'string' && fullPath.trim()) {
      this.resolvedFullPath = fullPath.trim();
      return this.resolvedFullPath;
    }
    return null;
  }

  private fetchRawFile(filePath: string, ref: string): Promise<RequestUrlResponse> {
    const encodedPath = encodeURIComponent(filePath);
    const encodedRef = encodeURIComponent(ref);
    return this.request(`/repository/files/${encodedPath}/raw?ref=${encodedRef}`);
  }

  private async request(
    projectRelativePath: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<RequestUrlResponse> {
    const method = options.method ?? 'GET';
    const url = `${this.baseUrl}/api/v4/projects/${this.encodedProjectId}${projectRelativePath}`;
    const res = await this.sendRequest(url, projectRelativePath, options);

    if (res.status < 200 || res.status >= 300) {
      const detail = res.text ? `: ${res.text.slice(0, 300)}` : '';
      throw new Error(`GitLab API ${method} ${projectRelativePath} failed (${res.status})${detail}`);
    }

    return res;
  }

  private sendRequest(
    url: string,
    label: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<RequestUrlResponse> {
    const method = options.method ?? 'GET';
    return sendRemoteRequest({
      requestFn: this.requestFn,
      url,
      label: `GitLab API ${method} ${label}`,
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        ...options.headers,
      },
      body: options.body,
      timeoutMs: this.timeoutMs,
      maxRateLimitRetries: this.maxRateLimitRetries,
      sleep: this.sleep,
      onRateLimitWait: this.onRateLimitWait,
    });
  }
}
