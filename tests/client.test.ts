import { describe, it, expect, vi } from 'vitest';
import { GitLabClient } from '../src/gitlab/client';

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
});
