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
}

export interface CreateCommitParams {
  branch: string;
  commitMessage: string;
  actions: GitLabCommitAction[];
  startSha?: string;
}

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
 * Minimal GitLab REST API v4 client backed by an injectable Obsidian `requestUrl`-compatible function.
 */
export class GitLabClient {
  private readonly baseUrl: string;
  private readonly encodedProjectId: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly requestFn: RequestUrlFn;

  constructor(config: GitLabClientConfig, requestFn: RequestUrlFn = requestUrl) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.encodedProjectId = encodeURIComponent(config.projectId);
    this.token = config.token;
    this.timeoutMs =
      config.timeoutMs !== undefined && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
        ? config.timeoutMs
        : 30_000;
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
  async getTreeRecursive(ref: string): Promise<GitLabTreeEntry[]> {
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let res: RequestUrlResponse;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`GitLab API ${method} ${projectRelativePath} timed out after ${this.timeoutMs}ms`));
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
          body: options.body,
          throw: false,
        }),
        timeoutPromise,
      ]);
    } catch (err) {
      if (timedOut) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`GitLab API ${method} ${projectRelativePath} request failed: ${message}`, { cause: err });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (res.status < 200 || res.status >= 300) {
      const detail = res.text ? `: ${res.text.slice(0, 300)}` : '';
      throw new Error(`GitLab API ${method} ${projectRelativePath} failed (${res.status})${detail}`);
    }

    return res;
  }
}
