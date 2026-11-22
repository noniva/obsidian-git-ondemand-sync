import { describe, it, expect, vi } from 'vitest';
import { GitLabClient } from '../src/gitlab/client';
import { sendRemoteRequest } from '../src/remote/http';

describe('GitLabClient', () => {
  const cfg = { baseUrl: 'https://gitlab.com/', projectId: 'user/my-vault', token: 'glpat-123' };

  it('encodes nested Unicode file paths for raw fetch and passes PRIVATE-TOKEN', async () => {
    const req = vi.fn().mockResolvedValue({
      status: 200,
      text: '# Note',
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      headers: {},
    });
    const client = new GitLabClient(cfg, req);
    const text = await client.getRawText('notes/บันทึก (1).md', 'main');
    expect(text).toBe('# Note');
    expect(req).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://gitlab.com/api/v4/projects/user%2Fmy-vault/repository/files/notes%2F%E0%B8%9A%E0%B8%B1%E0%B8%99%E0%B8%97%E0%B8%B6%E0%B8%81%20(1).md/raw?ref=main',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'glpat-123' }),
      })
    );
  });

  it('fetches binary raw files as ArrayBuffer', async () => {
    const buf = new Uint8Array([137, 80, 78, 71]).buffer;
    const req = vi.fn().mockResolvedValue({
      status: 200,
      text: '',
      arrayBuffer: buf,
      json: {},
      headers: {},
    });
    const client = new GitLabClient({ ...cfg, baseUrl: 'https://gitlab.com///' }, req);
    const res = await client.getRawBinary('attachments/pic 1.png', 'main');
    expect(res).toBe(buf);
    expect(req).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://gitlab.com/api/v4/projects/user%2Fmy-vault/repository/files/attachments%2Fpic%201.png/raw?ref=main',
        method: 'GET',
        throw: false,
      })
    );
  });

  it('fetches branch head commit SHA', async () => {
    const req = vi.fn().mockResolvedValue({
      status: 200,
      text: '',
      arrayBuffer: new ArrayBuffer(0),
      json: { commit: { id: 'deadbeef123' } },
      headers: {},
    });
    const client = new GitLabClient(cfg, req);
    const sha = await client.getBranchHead('feature/test');
    expect(sha).toBe('deadbeef123');
    expect(req).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://gitlab.com/api/v4/projects/user%2Fmy-vault/repository/branches/feature%2Ftest',
        method: 'GET',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'glpat-123' }),
        throw: false,
      })
    );
  });

  it('paginates recursive tree using x-next-page header (case-insensitive)', async () => {
    const req = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: [{ id: '1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }],
        headers: { 'X-Next-Page': '2' },
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: [{ id: '2', name: 'b.md', type: 'blob', path: 'b.md', mode: '100644' }],
        headers: { 'x-next-page': '' },
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });
    const client = new GitLabClient(cfg, req);
    const entries = await client.getTreeRecursive('abc123');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.path)).toEqual(['a.md', 'b.md']);
    expect(req).toHaveBeenCalledTimes(2);
    expect(req.mock.calls[0][0].url).toContain('page=1');
    expect(req.mock.calls[1][0].url).toContain('page=2');
  });

  it('sends start_sha and unencoded file_path in createCommit', async () => {
    const req = vi.fn().mockResolvedValue({
      status: 201,
      json: { id: 'newsha' },
      headers: {},
      text: '',
      arrayBuffer: new ArrayBuffer(0),
    });
    const client = new GitLabClient(cfg, req);
    const sha = await client.createCommit({
      branch: 'mobile-conflict/20261119-040000',
      commitMessage: 'Mobile conflict',
      startSha: 'base123',
      actions: [{ action: 'update', file_path: 'notes/บันทึก (1).md', content: 'hi', encoding: 'text' }],
    });
    expect(sha).toBe('newsha');
    expect(req).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://gitlab.com/api/v4/projects/user%2Fmy-vault/repository/commits',
        method: 'POST',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'glpat-123',
          'Content-Type': 'application/json',
        }),
        throw: false,
      })
    );
    const body = JSON.parse(req.mock.calls[0][0].body);
    expect(body.branch).toBe('mobile-conflict/20261119-040000');
    expect(body.commit_message).toBe('Mobile conflict');
    expect(body.start_sha).toBe('base123');
    expect(body.actions[0].file_path).toBe('notes/บันทึก (1).md');
  });

  it('omits start_sha when not provided in createCommit', async () => {
    const req = vi.fn().mockResolvedValue({
      status: 201,
      json: { id: 'newsha2' },
      headers: {},
      text: '',
      arrayBuffer: new ArrayBuffer(0),
    });
    const client = new GitLabClient(cfg, req);
    const sha = await client.createCommit({
      branch: 'main',
      commitMessage: 'Direct commit',
      actions: [{ action: 'create', file_path: 'a.md', content: 'hello', encoding: 'text' }],
    });
    expect(sha).toBe('newsha2');
    const body = JSON.parse(req.mock.calls[0][0].body);
    expect('start_sha' in body).toBe(false);
  });

  it('throws a descriptive Error on non-2xx responses', async () => {
    const req = vi.fn().mockResolvedValue({
      status: 404,
      text: '{"message":"404 File Not Found"}',
      arrayBuffer: new ArrayBuffer(0),
      json: { message: '404 File Not Found' },
      headers: {},
    });
    const client = new GitLabClient(cfg, req);
    await expect(client.getRawText('missing.md', 'main')).rejects.toThrow(/404/);
  });

  it('throws on repeated x-next-page pagination headers and enforces request timeout with cause', async () => {
    const loopReq = vi.fn().mockResolvedValue({
      status: 200,
      json: [],
      headers: { 'x-next-page': '1' },
      text: '',
      arrayBuffer: new ArrayBuffer(0),
    });
    const loopClient = new GitLabClient(cfg, loopReq);
    await expect(loopClient.getTreeRecursive('abc')).rejects.toThrow(/pagination loop/i);

    const slowReq = vi.fn(() => new Promise<never>(() => {}));
    const timeoutClient = new GitLabClient({ ...cfg, timeoutMs: 15 }, slowReq);
    await expect(timeoutClient.getBranchHead('main')).rejects.toThrow(/timed out/i);

    const rootCause = new Error('ECONNRESET');
    const failReq = vi.fn().mockRejectedValue(rootCause);
    const causeClient = new GitLabClient(cfg, failReq);
    try {
      await causeClient.getBranchHead('main');
      expect.unreachable();
    } catch (err) {
      expect((err as Error & { cause?: unknown }).cause).toBe(rootCause);
    }
  });

  it('invokes onPage callback with page, totalPages, and running entries count during getTreeRecursive', async () => {
    const req = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: [{ id: '1', name: 'a.md', type: 'blob', path: 'a.md', mode: '100644' }],
        headers: { 'x-next-page': '2', 'X-Total-Pages': '2' },
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: [
          { id: '2', name: 'b.md', type: 'blob', path: 'b.md', mode: '100644' },
          { id: '3', name: 'c.md', type: 'blob', path: 'c.md', mode: '100644' },
        ],
        headers: { 'x-next-page': '', 'x-total-pages': '2' },
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });
    const client = new GitLabClient(cfg, req);
    const pages: Array<{ page: number; totalPages?: number; entries: number }> = [];
    const entries = await client.getTreeRecursive('abc123', (info) => pages.push(info));

    expect(entries).toHaveLength(3);
    expect(pages).toEqual([
      { page: 1, totalPages: 2, entries: 1 },
      { page: 2, totalPages: 2, entries: 3 },
    ]);
  });

  it('fetches batch text blobs via GraphQL and skips null rawTextBlob entries', async () => {
    const req = vi.fn().mockResolvedValue({
      status: 200,
      text: '',
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
      json: {
        data: {
          project: {
            repository: {
              blobs: {
                nodes: [
                  { path: 'a.md', rawTextBlob: '# A' },
                  { path: 'b.md', rawTextBlob: null },
                  { path: 'notes/c.md', rawTextBlob: '# C' },
                ],
              },
            },
          },
        },
      },
    });

    const client = new GitLabClient(cfg, req);
    const map = await client.getRawTextsBatch(['a.md', 'b.md', 'notes/c.md'], 'sha123');

    expect(Array.from(map.entries())).toEqual([
      ['a.md', '# A'],
      ['notes/c.md', '# C'],
    ]);
    expect(req).toHaveBeenCalledTimes(1);
    expect(req.mock.calls[0][0].url).toBe('https://gitlab.com/api/graphql');
    expect(req.mock.calls[0][0].method).toBe('POST');
    const body = JSON.parse(req.mock.calls[0][0].body);
    expect(body.variables).toEqual({
      fullPath: 'user/my-vault',
      ref: 'sha123',
      paths: ['a.md', 'b.md', 'notes/c.md'],
    });
  });

  it('resolves numeric projectId once via /projects/:id and caches fullPath across batch calls', async () => {
    const req = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
        json: { path_with_namespace: 'group/sub/vault' },
      })
      .mockResolvedValueOnce({
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
        json: {
          data: {
            project: {
              repository: {
                blobs: { nodes: [{ path: 'a.md', rawTextBlob: '1' }] },
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
        json: {
          data: {
            project: {
              repository: {
                blobs: { nodes: [{ path: 'b.md', rawTextBlob: '2' }] },
              },
            },
          },
        },
      });

    const client = new GitLabClient({ ...cfg, projectId: '42' }, req);
    const first = await client.getRawTextsBatch(['a.md'], 'sha1');
    const second = await client.getRawTextsBatch(['b.md'], 'sha1');

    expect(first.get('a.md')).toBe('1');
    expect(second.get('b.md')).toBe('2');
    expect(req).toHaveBeenCalledTimes(3);
    expect(req.mock.calls[0][0].url).toBe('https://gitlab.com/api/v4/projects/42');
    expect(JSON.parse(req.mock.calls[1][0].body).variables.fullPath).toBe('group/sub/vault');
    expect(JSON.parse(req.mock.calls[2][0].body).variables.fullPath).toBe('group/sub/vault');
  });

  it('returns empty Map on GraphQL 404 or malformed/error payloads and throws on 401 or exhausted 429', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);

    const notFoundClient = new GitLabClient(
      cfg,
      vi.fn().mockResolvedValue({
        status: 404,
        text: 'Not Found',
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        headers: {},
      }),
    );
    expect((await notFoundClient.getRawTextsBatch(['a.md'], 'sha1')).size).toBe(0);

    const gqlErrorClient = new GitLabClient(
      cfg,
      vi.fn().mockResolvedValue({
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        json: { errors: [{ message: 'Variable invalid' }], data: null },
        headers: {},
      }),
    );
    expect((await gqlErrorClient.getRawTextsBatch(['a.md'], 'sha1')).size).toBe(0);

    const badJsonClient = new GitLabClient(
      cfg,
      vi.fn().mockResolvedValue({
        status: 200,
        text: '<html>bad</html>',
        arrayBuffer: new ArrayBuffer(0),
        get json(): unknown {
          throw new SyntaxError('Unexpected token <');
        },
        headers: {},
      }),
    );
    expect((await badJsonClient.getRawTextsBatch(['a.md'], 'sha1')).size).toBe(0);

    const unauthClient = new GitLabClient(
      cfg,
      vi.fn().mockResolvedValue({
        status: 401,
        text: 'Unauthorized',
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        headers: {},
      }),
    );
    await expect(unauthClient.getRawTextsBatch(['a.md'], 'sha1')).rejects.toThrow(/401/);

    const rateLimitClient = new GitLabClient(
      { ...cfg, maxRateLimitRetries: 1, sleep },
      vi.fn().mockResolvedValue({
        status: 429,
        text: 'Rate limit exceeded',
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        headers: { 'Retry-After': '1' },
      }),
    );
    await expect(rateLimitClient.getRawTextsBatch(['a.md'], 'sha1')).rejects.toThrow(/429/);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries HTTP 429 using Retry-After seconds and invokes onRateLimitWait', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const waits: Array<{ waitMs: number; attempt: number; maxAttempts: number }> = [];
    const req = vi
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        text: 'Rate limit exceeded',
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        headers: { 'Retry-After': '3' },
      })
      .mockResolvedValueOnce({
        status: 200,
        text: '# Recovered',
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        headers: {},
      });

    const client = new GitLabClient(
      {
        ...cfg,
        maxRateLimitRetries: 2,
        sleep,
        onRateLimitWait: (info) => waits.push(info),
      },
      req,
    );

    const text = await client.getRawText('note.md', 'main');
    expect(text).toBe('# Recovered');
    expect(req).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3250);
    expect(waits).toEqual([{ waitMs: 3250, attempt: 1, maxAttempts: 2 }]);
  });

  it('retries HTTP 429 using RateLimit-Reset timestamp when Retry-After is absent and throws when retries exhausted', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const futureResetSec = Math.floor(Date.now() / 1000) + 4;
    const reqReset = vi
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        text: 'Rate limit exceeded',
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        headers: { 'RateLimit-Reset': String(futureResetSec) },
      })
      .mockResolvedValueOnce({
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        json: { commit: { id: 'sha-ok' } },
        headers: {},
      });

    const resetClient = new GitLabClient({ ...cfg, maxRateLimitRetries: 2, sleep }, reqReset);
    await expect(resetClient.getBranchHead('main')).resolves.toBe('sha-ok');
    expect(sleep).toHaveBeenCalledTimes(1);
    const delayMs = sleep.mock.calls[0][0];
    expect(delayMs).toBeGreaterThanOrEqual(1000);
    expect(delayMs).toBeLessThanOrEqual(65000);

    const exhaustedSleep = vi.fn().mockResolvedValue(undefined);
    const exhaustedReq = vi.fn().mockResolvedValue({
      status: 429,
      text: 'Rate limit exceeded',
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      headers: {},
    });
    const exhaustedClient = new GitLabClient(
      { ...cfg, maxRateLimitRetries: 2, sleep: exhaustedSleep },
      exhaustedReq,
    );

    await expect(exhaustedClient.getBranchHead('main')).rejects.toThrow(/429/);
    expect(exhaustedReq).toHaveBeenCalledTimes(3);
    expect(exhaustedSleep).toHaveBeenCalledTimes(2);
  });
});

describe('sendRemoteRequest', () => {
  it('retries 403 rate limits only when shouldRetryRateLimit returns true and does not retry non-rate-limit 403', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const waits: Array<{ waitMs: number; attempt: number; maxAttempts: number }> = [];

    const rateLimitReq = vi
      .fn()
      .mockResolvedValueOnce({
        status: 403,
        text: 'API rate limit exceeded',
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '2' },
      })
      .mockResolvedValueOnce({
        status: 200,
        text: 'ok',
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        headers: {},
      });

    const retriedRes = await sendRemoteRequest({
      requestFn: rateLimitReq,
      url: 'https://api.github.com/repos/owner/repo',
      label: 'GET /repos/owner/repo',
      headers: { Authorization: 'Bearer tok' },
      timeoutMs: 5000,
      maxRateLimitRetries: 2,
      sleep,
      shouldRetryRateLimit: (res) =>
        res.status === 429 ||
        (res.status === 403 && res.headers['x-ratelimit-remaining'] === '0'),
      onRateLimitWait: (info) => waits.push(info),
    });

    expect(retriedRes.status).toBe(200);
    expect(rateLimitReq).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2250);
    expect(waits).toEqual([{ waitMs: 2250, attempt: 1, maxAttempts: 2 }]);

    const nonRateLimitSleep = vi.fn().mockResolvedValue(undefined);
    const nonRateLimitReq = vi.fn().mockResolvedValue({
      status: 403,
      text: 'Forbidden: bad credentials',
      arrayBuffer: new ArrayBuffer(0),
      json: {},
      headers: { 'x-ratelimit-remaining': '59' },
    });

    const nonRetriedRes = await sendRemoteRequest({
      requestFn: nonRateLimitReq,
      url: 'https://api.github.com/repos/owner/repo',
      label: 'GET /repos/owner/repo',
      headers: { Authorization: 'Bearer tok' },
      timeoutMs: 5000,
      maxRateLimitRetries: 2,
      sleep: nonRateLimitSleep,
      shouldRetryRateLimit: (res) =>
        res.status === 429 ||
        (res.status === 403 && res.headers['x-ratelimit-remaining'] === '0'),
    });

    expect(nonRetriedRes.status).toBe(403);
    expect(nonRateLimitReq).toHaveBeenCalledTimes(1);
    expect(nonRateLimitSleep).not.toHaveBeenCalled();
  });

  it('fetches GitLab tree pages 2..N concurrently when x-total-pages > 1', async () => {
    const clientCfg = { baseUrl: 'https://gitlab.com', projectId: 'user/repo', token: 'tok' };
    const req = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes('&page=1')) {
        return {
          status: 200,
          text: '',
          arrayBuffer: new ArrayBuffer(0),
          headers: { 'x-total-pages': '3', 'x-next-page': '2' },
          json: [{ id: 'b1', name: '1.md', type: 'blob', path: '1.md', mode: '100644' }],
        };
      }
      if (url.includes('&page=2')) {
        return {
          status: 200,
          text: '',
          arrayBuffer: new ArrayBuffer(0),
          headers: { 'x-total-pages': '3', 'x-next-page': '3' },
          json: [{ id: 'b2', name: '2.md', type: 'blob', path: '2.md', mode: '100644' }],
        };
      }
      return {
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: { 'x-total-pages': '3', 'x-next-page': '' },
        json: [{ id: 'b3', name: '3.md', type: 'blob', path: '3.md', mode: '100644' }],
      };
    });

    const client = new GitLabClient(clientCfg, req);
    const entries = await client.getTreeRecursive('head1');
    expect(entries.map((e) => e.path)).toEqual(['1.md', '2.md', '3.md']);
    expect(req).toHaveBeenCalledTimes(3);
  });

  it('compares commits via GitLab /repository/compare and returns null on timeout or 404', async () => {
    const clientCfg = { baseUrl: 'https://gitlab.com', projectId: 'user/repo', token: 'tok' };
    const req = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes('/repository/compare')) {
        return {
          status: 200,
          text: '',
          arrayBuffer: new ArrayBuffer(0),
          headers: {},
          json: {
            compare_timeout: false,
            diffs: [
              { old_path: 'a.md', new_path: 'a.md', new_file: false, renamed_file: false, deleted_file: false },
              { old_path: 'old.md', new_path: 'new.md', new_file: false, renamed_file: true, deleted_file: false },
              { old_path: 'gone.md', new_path: 'gone.md', new_file: false, renamed_file: false, deleted_file: true },
            ],
          },
        };
      }
      if (url.includes('/repository/files/a.md?ref=c2')) {
        return { status: 200, text: '', arrayBuffer: new ArrayBuffer(0), headers: {}, json: { blob_id: 'sha-a' } };
      }
      return { status: 200, text: '', arrayBuffer: new ArrayBuffer(0), headers: {}, json: { blob_id: 'sha-new' } };
    });

    const client = new GitLabClient(clientCfg, req);
    const changes = await client.compareCommits('c1', 'c2');
    expect(changes).toEqual([
      { path: 'a.md', status: 'modified', blobSha: 'sha-a' },
      { path: 'new.md', previousPath: 'old.md', status: 'renamed', blobSha: 'sha-new' },
      { path: 'gone.md', status: 'deleted' },
    ]);

    const timeoutClient = new GitLabClient(
      clientCfg,
      vi.fn().mockResolvedValue({
        status: 200,
        text: '',
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
        json: { compare_timeout: true, diffs: [] },
      }),
    );
    expect(await timeoutClient.compareCommits('c1', 'c2')).toBeNull();
  });
});
