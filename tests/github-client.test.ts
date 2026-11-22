import { describe, it, expect, vi } from 'vitest';
import { GitHubClient } from '../src/github/client';
import type { RequestUrlResponse } from '../src/remote/http';

function makeResponse(overrides: Partial<RequestUrlResponse> = {}): RequestUrlResponse {
  return {
    status: 200,
    text: '',
    arrayBuffer: new ArrayBuffer(0),
    json: {},
    headers: {},
    ...overrides,
  };
}

describe('GitHubClient', () => {
  const cfg = {
    baseUrl: 'https://github.com',
    projectId: 'octocat/my-vault',
    token: 'ghp_test123',
  };

  it('does not throw in constructor when projectId is empty, and throws on request when invalid', async () => {
    const req = vi.fn();
    const emptyClient = new GitHubClient({ baseUrl: '', projectId: '', token: 't' }, req);
    await expect(emptyClient.getBranchHead('main')).rejects.toThrow(
      'Invalid GitHub repository format; expected "owner/repo"',
    );

    const badClient = new GitHubClient({ baseUrl: '', projectId: 'only-owner', token: 't' }, req);
    await expect(badClient.getBranchHead('main')).rejects.toThrow(
      'Invalid GitHub repository format; expected "owner/repo"',
    );

    const tooManyClient = new GitHubClient({ baseUrl: '', projectId: 'a/b/c', token: 't' }, req);
    await expect(tooManyClient.getBranchHead('main')).rejects.toThrow(
      'Invalid GitHub repository format; expected "owner/repo"',
    );

    expect(req).not.toHaveBeenCalled();
  });

  it('normalizes baseUrl and projectId (.git and slashes) and sends required GitHub headers', async () => {
    const req = vi.fn().mockResolvedValue(
      makeResponse({ json: { commit: { sha: 'abc123' } } }),
    );
    const client = new GitHubClient(
      { baseUrl: 'HTTP://GITHUB.COM///', projectId: '/octocat/my-vault.git/', token: 'ghp_abc' },
      req,
    );

    const sha = await client.getBranchHead('feature/test');
    expect(sha).toBe('abc123');
    expect(req).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.github.com/repos/octocat/my-vault/branches/feature%2Ftest',
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_abc',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
        throw: false,
      }),
    );
  });

  it('preserves custom GitHub Enterprise baseUrl', async () => {
    const req = vi.fn().mockResolvedValue(
      makeResponse({ json: { commit: { sha: 'ghe999' } } }),
    );
    const client = new GitHubClient(
      { baseUrl: 'https://git.corp.local/api/v3/', projectId: 'org/repo', token: 't' },
      req,
    );

    await client.getBranchHead('main');
    expect(req).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://git.corp.local/api/v3/repos/org/repo/branches/main',
      }),
    );
  });

  it('retries on 429 and 403 rate-limit responses, but does not retry plain 403', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRateLimitWait = vi.fn();
    const req = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({ status: 403, headers: { 'X-RateLimit-Remaining': '0', 'Retry-After': '1' } }),
      )
      .mockResolvedValueOnce(makeResponse({ status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(makeResponse({ json: { commit: { sha: 'ok-sha' } } }));

    const client = new GitHubClient(
      { ...cfg, sleep, onRateLimitWait, maxRateLimitRetries: 3 },
      req,
    );
    const sha = await client.getBranchHead('main');
    expect(sha).toBe('ok-sha');
    expect(req).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRateLimitWait).toHaveBeenCalledTimes(2);

    const plain403Req = vi.fn().mockResolvedValue(makeResponse({ status: 403, text: 'Forbidden' }));
    const plainClient = new GitHubClient({ ...cfg, sleep, maxRateLimitRetries: 2 }, plain403Req);
    await expect(plainClient.getBranchHead('main')).rejects.toThrow('(403)');
    expect(plain403Req).toHaveBeenCalledTimes(1);
  });

  it('fetches non-truncated recursive tree and invokes onPage', async () => {
    const req = vi.fn().mockResolvedValue(
      makeResponse({
        json: {
          sha: 'root-sha',
          truncated: false,
          tree: [
            { path: 'notes', sha: 't1', type: 'tree', mode: '040000' },
            { path: 'notes/hello.md', sha: 'b1', type: 'blob' },
            { path: 'submod', sha: 'c1', type: 'commit', mode: '160000' },
          ],
        },
      }),
    );
    const onPage = vi.fn();
    const client = new GitHubClient(cfg, req);
    const entries = await client.getTreeRecursive('main', onPage);

    expect(entries).toEqual([
      { id: 't1', name: 'notes', type: 'tree', path: 'notes', mode: '040000' },
      { id: 'b1', name: 'hello.md', type: 'blob', path: 'notes/hello.md', mode: '100644' },
    ]);
    expect(onPage).toHaveBeenCalledWith({ page: 1, totalPages: 1, entries: 2 });
    expect(req).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.github.com/repos/octocat/my-vault/git/trees/main?recursive=1',
      }),
    );
  });

  it('falls back to recursive subtree walk when getTreeRecursive returns truncated=true', async () => {
    const req = vi.fn(async ({ url }: { url: string }) => {
      if (url.endsWith('/git/trees/main?recursive=1')) {
        return makeResponse({
          json: {
            sha: 'root-tree-sha',
            truncated: true,
            tree: [{ path: 'partial.md', sha: 'p1', type: 'blob' }],
          },
        });
      }
      if (url.endsWith('/git/trees/root-tree-sha')) {
        return makeResponse({
          json: {
            sha: 'root-tree-sha',
            tree: [
              { path: 'README.md', sha: 'b-readme', type: 'blob', mode: '100644' },
              { path: 'folder', sha: 'sub-tree-sha', type: 'tree', mode: '040000' },
            ],
          },
        });
      }
      if (url.endsWith('/git/trees/sub-tree-sha')) {
        return makeResponse({
          json: {
            sha: 'sub-tree-sha',
            tree: [{ path: 'nested.md', sha: 'b-nested', type: 'blob', mode: '100644' }],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const onPage = vi.fn();
    const client = new GitHubClient(cfg, req);
    const entries = await client.getTreeRecursive('main', onPage);

    expect(entries).toEqual([
      { id: 'b-readme', name: 'README.md', type: 'blob', path: 'README.md', mode: '100644' },
      { id: 'sub-tree-sha', name: 'folder', type: 'tree', path: 'folder', mode: '040000' },
      { id: 'b-nested', name: 'nested.md', type: 'blob', path: 'folder/nested.md', mode: '100644' },
    ]);
    expect(onPage).toHaveBeenCalledWith({ page: 1, totalPages: 1, entries: 3 });
  });

  it('fetches raw text and raw binary with encoded path segments and raw accept header', async () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const req = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ text: '# Hello' }))
      .mockResolvedValueOnce(makeResponse({ arrayBuffer: buf }));

    const client = new GitHubClient(cfg, req);
    const text = await client.getRawText('notes/my file (1).md', 'feat/a');
    expect(text).toBe('# Hello');
    expect(req).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'https://api.github.com/repos/octocat/my-vault/contents/notes/my%20file%20(1).md?ref=feat%2Fa',
        headers: expect.objectContaining({
          Accept: 'application/vnd.github.raw+json',
        }),
      }),
    );

    const bin = await client.getRawBinary('attachments/pic.png', 'main');
    expect(bin).toBe(buf);
    expect(req).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'https://api.github.com/repos/octocat/my-vault/contents/attachments/pic.png?ref=main',
        headers: expect.objectContaining({
          Accept: 'application/vnd.github.raw+json',
        }),
      }),
    );
  });

  it('batches raw text fetches via GraphQL, filters binary/truncated, and resolves GHE GraphQL URL', async () => {
    const req = vi.fn().mockResolvedValue(
      makeResponse({
        json: {
          data: {
            repository: {
              f0: { isBinary: false, isTruncated: false, text: 'hello' },
              f1: { isBinary: true, isTruncated: false, text: null },
              f2: { isBinary: false, isTruncated: true, text: 'cut' },
              f3: null,
            },
          },
        },
      }),
    );

    const client = new GitHubClient(cfg, req);
    expect((await client.getRawTextsBatch([], 'main')).size).toBe(0);
    expect(req).not.toHaveBeenCalled();

    const map = await client.getRawTextsBatch(
      ['a.md', 'img.png', 'huge.md', 'missing.md'],
      'main',
    );
    expect(Array.from(map.entries())).toEqual([['a.md', 'hello']]);

    const call = req.mock.calls[0][0];
    expect(call.url).toBe('https://api.github.com/graphql');
    expect(call.method).toBe('POST');
    const body = JSON.parse(call.body);
    expect(body.variables).toEqual({
      owner: 'octocat',
      repo: 'my-vault',
      e0: 'main:a.md',
      e1: 'main:img.png',
      e2: 'main:huge.md',
      e3: 'main:missing.md',
    });
    expect(body.query).toContain('f0: object(expression: $e0)');

    // GHE /api/v3 -> /api/graphql
    const gheReq = vi.fn().mockResolvedValue(makeResponse({ json: { data: { repository: {} } } }));
    const gheClient = new GitHubClient(
      { baseUrl: 'https://git.corp.local/api/v3', projectId: 'o/r', token: 't' },
      gheReq,
    );
    await gheClient.getRawTextsBatch(['a.md'], 'main');
    expect(gheReq.mock.calls[0][0].url).toBe('https://git.corp.local/api/graphql');
  });

  it('throws on 401/403-ratelimit/429 in getRawTextsBatch and returns empty Map on 404 or GraphQL errors', async () => {
    const req401 = vi.fn().mockResolvedValue(makeResponse({ status: 401, text: 'Bad creds' }));
    await expect(new GitHubClient(cfg, req401).getRawTextsBatch(['a.md'], 'main')).rejects.toThrow(
      '(401)',
    );

    const req403Rl = vi.fn().mockResolvedValue(
      makeResponse({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );
    await expect(
      new GitHubClient({ ...cfg, maxRateLimitRetries: 0 }, req403Rl).getRawTextsBatch(
        ['a.md'],
        'main',
      ),
    ).rejects.toThrow('(403)');

    const req429 = vi.fn().mockResolvedValue(makeResponse({ status: 429 }));
    await expect(
      new GitHubClient({ ...cfg, maxRateLimitRetries: 0 }, req429).getRawTextsBatch(
        ['a.md'],
        'main',
      ),
    ).rejects.toThrow('(429)');

    const req404 = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));
    expect((await new GitHubClient(cfg, req404).getRawTextsBatch(['a.md'], 'main')).size).toBe(0);

    const reqGqlErr = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, json: { errors: [{ message: 'fail' }] } }),
    );
    expect((await new GitHubClient(cfg, reqGqlErr).getRawTextsBatch(['a.md'], 'main')).size).toBe(
      0,
    );
  });

  it('creates a commit on existing branch with bounded blob concurrency (4) and PATCHes ref', async () => {
    let activeBlobs = 0;
    let maxActiveBlobs = 0;
    let blobSeq = 0;
    const treeBodies: unknown[] = [];
    const commitBodies: unknown[] = [];
    const patchCalls: Array<{ url: string; body: unknown }> = [];

    const req = vi.fn(async ({ url, method, body }: { url: string; method?: string; body?: string }) => {
      if (method === 'GET' && url.endsWith('/branches/feat%2Fone')) {
        return makeResponse({
          json: { commit: { sha: 'head-sha', commit: { tree: { sha: 'base-tree-sha' } } } },
        });
      }
      if (method === 'POST' && url.endsWith('/git/blobs')) {
        activeBlobs++;
        maxActiveBlobs = Math.max(maxActiveBlobs, activeBlobs);
        await new Promise((r) => setTimeout(r, 5));
        activeBlobs--;
        blobSeq++;
        return makeResponse({ status: 201, json: { sha: `blob-${blobSeq}` } });
      }
      if (method === 'POST' && url.endsWith('/git/trees')) {
        treeBodies.push(JSON.parse(body!));
        return makeResponse({ status: 201, json: { sha: 'new-tree-sha' } });
      }
      if (method === 'POST' && url.endsWith('/git/commits')) {
        commitBodies.push(JSON.parse(body!));
        return makeResponse({ status: 201, json: { sha: 'new-commit-sha' } });
      }
      if (method === 'PATCH' && url.endsWith('/git/refs/heads/feat/one')) {
        patchCalls.push({ url, body: JSON.parse(body!) });
        return makeResponse({ status: 200, json: {} });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });

    const client = new GitHubClient(cfg, req);
    const sha = await client.createCommit({
      branch: 'feat/one',
      commitMessage: 'sync',
      actions: [
        { action: 'create', file_path: 'a.md', content: 'A' },
        { action: 'update', file_path: 'b.md', content: 'B' },
        { action: 'create', file_path: 'c.md', content: 'C' },
        { action: 'create', file_path: 'd.md', content: 'D' },
        { action: 'create', file_path: 'e.md', content: 'E', encoding: 'base64' },
        { action: 'delete', file_path: 'old.md' },
      ],
    });

    expect(sha).toBe('new-commit-sha');
    expect(maxActiveBlobs).toBeLessThanOrEqual(4);
    expect(treeBodies[0]).toEqual({
      base_tree: 'base-tree-sha',
      tree: [
        { path: 'a.md', mode: '100644', type: 'blob', sha: expect.stringMatching(/^blob-/) },
        { path: 'b.md', mode: '100644', type: 'blob', sha: expect.stringMatching(/^blob-/) },
        { path: 'c.md', mode: '100644', type: 'blob', sha: expect.stringMatching(/^blob-/) },
        { path: 'd.md', mode: '100644', type: 'blob', sha: expect.stringMatching(/^blob-/) },
        { path: 'e.md', mode: '100644', type: 'blob', sha: expect.stringMatching(/^blob-/) },
        { path: 'old.md', mode: '100644', type: 'blob', sha: null },
      ],
    });
    expect(commitBodies[0]).toEqual({
      message: 'sync',
      tree: 'new-tree-sha',
      parents: ['head-sha'],
    });
    expect(patchCalls).toEqual([
      {
        url: 'https://api.github.com/repos/octocat/my-vault/git/refs/heads/feat/one',
        body: { sha: 'new-commit-sha', force: false },
      },
    ]);
  });

  it('creates a commit on a new branch when startSha is provided and POSTs /git/refs', async () => {
    const postRefsCalls: unknown[] = [];
    const req = vi.fn(async ({ url, method, body }: { url: string; method?: string; body?: string }) => {
      if (method === 'GET' && url.endsWith('/git/commits/start-123')) {
        return makeResponse({ json: { tree: { sha: 'start-tree-sha' } } });
      }
      if (method === 'POST' && url.endsWith('/git/blobs')) {
        return makeResponse({ status: 201, json: { sha: 'blob-1' } });
      }
      if (method === 'POST' && url.endsWith('/git/trees')) {
        return makeResponse({ status: 201, json: { sha: 'new-tree-sha' } });
      }
      if (method === 'POST' && url.endsWith('/git/commits')) {
        return makeResponse({ status: 201, json: { sha: 'new-commit-sha' } });
      }
      if (method === 'POST' && url.endsWith('/git/refs')) {
        postRefsCalls.push(JSON.parse(body!));
        return makeResponse({ status: 201, json: {} });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });

    const client = new GitHubClient(cfg, req);
    const sha = await client.createCommit({
      branch: 'conflict/branch',
      commitMessage: 'conflict commit',
      startSha: 'start-123',
      actions: [{ action: 'create', file_path: 'x.md', content: 'hi' }],
    });

    expect(sha).toBe('new-commit-sha');
    expect(postRefsCalls).toEqual([{ ref: 'refs/heads/conflict/branch', sha: 'new-commit-sha' }]);
  });

  it('compares commits via GitHub /compare/:base...:head and returns null on 404', async () => {
    const req = vi.fn().mockResolvedValue(
      makeResponse({
        json: {
          files: [
            { filename: 'a.md', status: 'modified', sha: 'sha-a' },
            { filename: 'new.md', previous_filename: 'old.md', status: 'renamed', sha: 'sha-new' },
            { filename: 'gone.md', status: 'removed' },
          ],
        },
      }),
    );
    const client = new GitHubClient(cfg, req);
    expect(await client.compareCommits('c1', 'c2')).toEqual([
      { path: 'a.md', status: 'modified', blobSha: 'sha-a' },
      { path: 'new.md', previousPath: 'old.md', status: 'renamed', blobSha: 'sha-new' },
      { path: 'gone.md', status: 'deleted' },
    ]);

    const req404 = vi.fn().mockResolvedValue(makeResponse({ status: 404, text: 'Not Found' }));
    expect(await new GitHubClient(cfg, req404).compareCommits('c1', 'c2')).toBeNull();
  });
});
