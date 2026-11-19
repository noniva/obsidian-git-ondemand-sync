import { requestUrl } from 'obsidian';
import {
  getHeaderCaseInsensitive,
  sendRemoteRequest,
  type RemoteClientConfig,
  type RequestUrlFn,
  type RequestUrlResponse,
} from '../remote/http';
import type { CreateCommitParams, RemoteGitClient, RemoteTreeEntry } from '../types';

const GITHUB_API_VERSION = '2022-11-28';
const BLOB_CREATE_CONCURRENCY = 4;

interface GitHubTreeItem {
  path?: string;
  sha?: string;
  type?: string;
  mode?: string;
}

interface GitHubTreeResponse {
  sha?: string;
  truncated?: boolean;
  tree?: GitHubTreeItem[];
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed || /^https?:\/\/github\.com$/i.test(trimmed)) {
    return 'https://api.github.com';
  }
  return trimmed;
}

function parseOwnerRepo(projectId: string): { owner: string; repo: string } {
  const cleaned = projectId
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '');
  const parts = cleaned.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid GitHub repository format; expected "owner/repo"');
  }
  return { owner: parts[0], repo: parts[1] };
}

function encodePathSegments(filePath: string): string {
  return filePath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function basename(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

function isRateLimitResponse(res: RequestUrlResponse): boolean {
  if (res.status === 429) {
    return true;
  }
  if (res.status === 403) {
    const remaining = getHeaderCaseInsensitive(res.headers, 'x-ratelimit-remaining')?.trim();
    const retryAfter = getHeaderCaseInsensitive(res.headers, 'retry-after')?.trim();
    return remaining === '0' || Boolean(retryAfter);
  }
  return false;
}

/**
 * GitHub REST & GraphQL API client backed by an injectable Obsidian `requestUrl`-compatible function.
 */
export class GitHubClient implements RemoteGitClient {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRateLimitWait?: RemoteClientConfig['onRateLimitWait'];
  private readonly requestFn: RequestUrlFn;

  constructor(config: RemoteClientConfig, requestFn: RequestUrlFn = requestUrl) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.projectId = config.projectId;
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
    const res = await this.repoRequest(`/branches/${encodeURIComponent(branch)}`);
    const data = res.json as { commit?: { sha?: string } } | null;
    const sha = data?.commit?.sha;
    if (!sha) {
      throw new Error(`GitHub API returned branch "${branch}" without a commit.sha`);
    }
    return sha;
  }

  /** Fetches all tree entries recursively for a ref, walking subtrees if GitHub truncates the response. */
  async getTreeRecursive(
    ref: string,
    onPage?: (info: { page: number; totalPages?: number; entries: number }) => void,
  ): Promise<RemoteTreeEntry[]> {
    const res = await this.repoRequest(`/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    const data = res.json as GitHubTreeResponse | null;
    if (!data || !Array.isArray(data.tree)) {
      throw new Error('GitHub API returned unexpected response for repository tree');
    }

    let entries: RemoteTreeEntry[];
    if (data.truncated === true) {
      let rootTreeSha = data.sha;
      if (!rootTreeSha) {
        const commitRes = await this.repoRequest(`/git/commits/${encodeURIComponent(ref)}`);
        rootTreeSha = (commitRes.json as { tree?: { sha?: string } } | null)?.tree?.sha;
      }
      if (!rootTreeSha) {
        throw new Error(`GitHub API could not resolve root tree SHA for truncated ref "${ref}"`);
      }
      entries = await this.walkSubtrees(rootTreeSha, '');
    } else {
      entries = [];
      for (const item of data.tree) {
        const mapped = this.mapTreeItem(item, item.path ?? '');
        if (mapped) {
          entries.push(mapped);
        }
      }
    }

    onPage?.({ page: 1, totalPages: 1, entries: entries.length });
    return entries;
  }

  /** Fetches raw UTF-8 text content of a file at the given ref. */
  async getRawText(filePath: string, ref: string): Promise<string> {
    const res = await this.fetchRawFile(filePath, ref);
    return res.text;
  }

  /**
   * Fetches raw UTF-8 text content for a batch of paths via GitHub GraphQL (`repository.object`).
   * Throws on 401, 403 rate-limit, and 429; returns an empty map on other errors so callers can fall back to REST.
   */
  async getRawTextsBatch(filePaths: string[], ref: string): Promise<Map<string, string>> {
    if (filePaths.length === 0) {
      return new Map();
    }

    const { owner, repo } = parseOwnerRepo(this.projectId);
    const varDecls = ['$owner: String!', '$repo: String!'];
    const variables: Record<string, string> = { owner, repo };
    const selections: string[] = [];

    for (let i = 0; i < filePaths.length; i++) {
      varDecls.push(`$e${i}: String!`);
      variables[`e${i}`] = `${ref}:${filePaths[i]}`;
      selections.push(
        `f${i}: object(expression: $e${i}) { ... on Blob { isBinary isTruncated text } }`,
      );
    }

    const query = `query(${varDecls.join(', ')}) { repository(owner: $owner, name: $repo) { ${selections.join(' ')} } }`;
    const res = await this.sendRequest(this.resolveGraphqlUrl(), 'POST /graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 || res.status === 429 || (res.status === 403 && isRateLimitResponse(res))) {
      const detail = res.text ? `: ${res.text.slice(0, 300)}` : '';
      throw new Error(`GitHub API POST /graphql failed (${res.status})${detail}`);
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
        repository?: Record<
          string,
          { isBinary?: unknown; isTruncated?: unknown; text?: unknown } | null
        > | null;
      } | null;
    };

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      return new Map();
    }
    const repoObj = payload.data?.repository;
    if (!repoObj || typeof repoObj !== 'object') {
      return new Map();
    }

    const result = new Map<string, string>();
    for (let i = 0; i < filePaths.length; i++) {
      const obj = repoObj[`f${i}`];
      if (obj && !obj.isBinary && !obj.isTruncated && typeof obj.text === 'string') {
        result.set(filePaths[i], obj.text);
      }
    }
    return result;
  }

  /** Fetches raw binary content of a file at the given ref. */
  async getRawBinary(filePath: string, ref: string): Promise<ArrayBuffer> {
    const res = await this.fetchRawFile(filePath, ref);
    return res.arrayBuffer;
  }

  /** Creates a multi-action commit via GitHub Git Data API and updates or creates the target branch ref. */
  async createCommit(params: CreateCommitParams): Promise<string> {
    const { branch, commitMessage, actions, startSha } = params;

    let baseCommitSha: string;
    let baseTreeSha: string;
    if (startSha !== undefined) {
      baseCommitSha = startSha;
      const commitRes = await this.repoRequest(`/git/commits/${encodeURIComponent(startSha)}`);
      const treeSha = (commitRes.json as { tree?: { sha?: string } } | null)?.tree?.sha;
      if (!treeSha) {
        throw new Error(`GitHub API commit "${startSha}" did not contain tree.sha`);
      }
      baseTreeSha = treeSha;
    } else {
      const branchRes = await this.repoRequest(`/branches/${encodeURIComponent(branch)}`);
      const branchData = branchRes.json as {
        commit?: { sha?: string; commit?: { tree?: { sha?: string } } };
      } | null;
      const commitSha = branchData?.commit?.sha;
      const treeSha = branchData?.commit?.commit?.tree?.sha;
      if (!commitSha || !treeSha) {
        throw new Error(`GitHub API branch "${branch}" did not contain commit/tree SHA`);
      }
      baseCommitSha = commitSha;
      baseTreeSha = treeSha;
    }

    const blobActions = actions.filter((a) => a.action === 'create' || a.action === 'update');
    const blobShas = new Map<number, string>();
    let nextIdx = 0;
    const workerCount = Math.min(BLOB_CREATE_CONCURRENCY, blobActions.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIdx < blobActions.length) {
          const idx = nextIdx++;
          const action = blobActions[idx];
          const res = await this.repoRequest('/git/blobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: action.content ?? '',
              encoding: action.encoding === 'base64' ? 'base64' : 'utf-8',
            }),
          });
          const sha = (res.json as { sha?: string } | null)?.sha;
          if (!sha) {
            throw new Error(`GitHub API create blob for "${action.file_path}" did not return sha`);
          }
          blobShas.set(actions.indexOf(action), sha);
        }
      }),
    );

    const tree = actions.map((action, idx) => {
      if (action.action === 'delete') {
        return { path: action.file_path, mode: '100644', type: 'blob', sha: null };
      }
      return { path: action.file_path, mode: '100644', type: 'blob', sha: blobShas.get(idx)! };
    });

    const treeRes = await this.repoRequest('/git/trees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree }),
    });
    const newTreeSha = (treeRes.json as { sha?: string } | null)?.sha;
    if (!newTreeSha) {
      throw new Error('GitHub API create tree did not return sha');
    }

    const commitRes = await this.repoRequest('/git/commits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        tree: newTreeSha,
        parents: [baseCommitSha],
      }),
    });
    const newCommitSha = (commitRes.json as { sha?: string } | null)?.sha;
    if (!newCommitSha) {
      throw new Error('GitHub API create commit did not return sha');
    }

    if (startSha !== undefined) {
      await this.repoRequest('/git/refs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommitSha }),
      });
    } else {
      await this.repoRequest(`/git/refs/heads/${encodePathSegments(branch)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: newCommitSha, force: false }),
      });
    }

    return newCommitSha;
  }

  private async walkSubtrees(treeSha: string, prefix: string): Promise<RemoteTreeEntry[]> {
    const res = await this.repoRequest(`/git/trees/${encodeURIComponent(treeSha)}`);
    const data = res.json as GitHubTreeResponse | null;
    if (!data || !Array.isArray(data.tree)) {
      throw new Error(`GitHub API returned unexpected subtree response for "${treeSha}"`);
    }

    const entries: RemoteTreeEntry[] = [];
    for (const item of data.tree) {
      if (!item.path) {
        continue;
      }
      const fullPath = prefix ? `${prefix}/${item.path}` : item.path;
      const mapped = this.mapTreeItem(item, fullPath);
      if (!mapped) {
        continue;
      }
      entries.push(mapped);
      if (mapped.type === 'tree') {
        entries.push(...(await this.walkSubtrees(mapped.id, fullPath)));
      }
    }
    return entries;
  }

  private mapTreeItem(item: GitHubTreeItem, fullPath: string): RemoteTreeEntry | null {
    if ((item.type !== 'blob' && item.type !== 'tree') || !item.sha || !fullPath) {
      return null;
    }
    return {
      id: item.sha,
      name: basename(fullPath),
      type: item.type,
      path: fullPath,
      mode: item.mode ?? (item.type === 'tree' ? '040000' : '100644'),
    };
  }

  private resolveGraphqlUrl(): string {
    if (this.baseUrl === 'https://api.github.com') {
      return 'https://api.github.com/graphql';
    }
    if (this.baseUrl.endsWith('/api/v3')) {
      return `${this.baseUrl.slice(0, -'/api/v3'.length)}/api/graphql`;
    }
    return `${this.baseUrl}/graphql`;
  }

  private fetchRawFile(filePath: string, ref: string): Promise<RequestUrlResponse> {
    const encodedPath = encodePathSegments(filePath);
    return this.repoRequest(`/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
  }

  private async repoRequest(
    repoRelativePath: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<RequestUrlResponse> {
    const { owner, repo } = parseOwnerRepo(this.projectId);
    const method = options.method ?? 'GET';
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${repoRelativePath}`;
    const res = await this.sendRequest(url, `${method} ${repoRelativePath}`, options);

    if (res.status < 200 || res.status >= 300) {
      const detail = res.text ? `: ${res.text.slice(0, 300)}` : '';
      throw new Error(`GitHub API ${method} ${repoRelativePath} failed (${res.status})${detail}`);
    }

    return res;
  }

  private sendRequest(
    url: string,
    label: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<RequestUrlResponse> {
    const method = options.method ?? 'GET';
    return sendRemoteRequest({
      requestFn: this.requestFn,
      url,
      label: `GitHub API ${label}`,
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...options.headers,
      },
      body: options.body,
      timeoutMs: this.timeoutMs,
      maxRateLimitRetries: this.maxRateLimitRetries,
      sleep: this.sleep,
      shouldRetryRateLimit: isRateLimitResponse,
      onRateLimitWait: this.onRateLimitWait,
    });
  }
}
