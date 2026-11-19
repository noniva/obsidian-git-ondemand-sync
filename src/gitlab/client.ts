import { requestUrl } from 'obsidian';
import type { GitLabCommitAction, GitLabTreeEntry } from '../types';

export interface RequestUrlResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  headers: Record<string, string>;
}

export type RequestUrlFn = (req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}) => Promise<RequestUrlResponse>;

export interface GitLabClientConfig {
  baseUrl: string;
  projectId: string;
  token: string;
  timeoutMs?: number;
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onRateLimitWait?: (info: { waitMs: number; attempt: number; maxAttempts: number }) => void;
}

export interface CreateCommitParams {
  branch: string;
  commitMessage: string;
  actions: GitLabCommitAction[];
  startSha?: string;
}

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

function getHeaderCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

/**
 * Minimal GitLab REST & GraphQL API client backed by an injectable Obsidian `requestUrl`-compatible function.
 */
export class GitLabClient {
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
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  /** Fetches all tree entries recursively for a ref, following GitLab `x-next-page` pagination. */
  async getTreeRecursive(
    ref: string,
    onPage?: (info: { page: number; totalPages?: number; entries: number }) => void,
  ): Promise<GitLabTreeEntry[]> {
    const entries: GitLabTreeEntry[] = [];
    const encodedRef = encodeURIComponent(ref);
    const seenPages = new Set<string>(['1']);
    let page = '1';

    while (page) {
      const res = await this.request(
        `/repository/tree?recursive=true&per_page=100&ref=${encodedRef}&page=${encodeURIComponent(page)}`
      );
      if (!Array.isArray(res.json)) {
        throw new Error('GitLab API returned unexpected non-array response for repository tree');
      }
      entries.push(...(res.json as GitLabTreeEntry[]));

      const rawTotalPages = getHeaderCaseInsensitive(res.headers, 'x-total-pages')?.trim();
      const parsedTotal = rawTotalPages ? Number(rawTotalPages) : Number.NaN;
      const totalPages = Number.isInteger(parsedTotal) && parsedTotal > 0 ? parsedTotal : undefined;
      onPage?.({
        page: Number(page) || seenPages.size,
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
      actions: GitLabCommitAction[];
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

  private parseRateLimitDelayMs(headers: Record<string, string>, attempt: number): number {
    let delayMs: number | undefined;

    const rawRetryAfter = getHeaderCaseInsensitive(headers, 'retry-after')?.trim();
    if (rawRetryAfter) {
      const seconds = Number(rawRetryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        delayMs = Math.ceil(seconds * 1000) + 250;
      } else {
        const parsedDate = Date.parse(rawRetryAfter);
        if (Number.isFinite(parsedDate)) {
          delayMs = parsedDate - Date.now() + 250;
        }
      }
    }

    if (delayMs === undefined) {
      const rawReset = getHeaderCaseInsensitive(headers, 'ratelimit-reset')?.trim();
      if (rawReset) {
        const epochSec = Number(rawReset);
        if (Number.isFinite(epochSec)) {
          delayMs = Math.ceil(epochSec * 1000 - Date.now()) + 500;
        }
      }
    }

    if (delayMs !== undefined && Number.isFinite(delayMs)) {
      return Math.min(65_000, Math.max(1_000, delayMs));
    }

    return Math.min(60_000, 5_000 * 2 ** (attempt - 1));
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

  private async sendRequest(
    url: string,
    label: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<RequestUrlResponse> {
    const method = options.method ?? 'GET';

    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let res: RequestUrlResponse;
      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`GitLab API ${method} ${label} timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
        });
        res = await Promise.race([
          this.requestFn({
            url,
            method,
            headers: {
              'PRIVATE-TOKEN': this.token,
              ...options.headers,
            },
            ...(options.body !== undefined ? { body: options.body } : {}),
            throw: false,
          }),
          timeoutPromise,
        ]);
      } catch (err) {
        if (timedOut) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`GitLab API ${method} ${label} request failed: ${message}`, { cause: err });
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }

      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        const waitMs = this.parseRateLimitDelayMs(res.headers ?? {}, attempt + 1);
        this.onRateLimitWait?.({
          waitMs,
          attempt: attempt + 1,
          maxAttempts: this.maxRateLimitRetries,
        });
        await this.sleep(waitMs);
        continue;
      }

      return res;
    }

    throw new Error(`GitLab API ${method} ${label} exceeded max rate-limit retries`);
  }
}
