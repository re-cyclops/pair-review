// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { GitHubClient, GitHubApiError } = require('../../src/github/client');

describe('GitHubClient', () => {
  describe('request deadline', () => {
    it.each([
      ['rest', 'headers'], ['graphql', 'headers'],
      ['rest', 'body'], ['graphql', 'body']
    ])('aborts an unresponsive %s response %s without retrying', async (kind, stage) => {
      vi.useFakeTimers();
      // Node's native AbortSignal.timeout uses internal timers, so drive its
      // clock explicitly while retaining real signals and Octokit's fetch path.
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
        return controller.signal;
      });
      let dispatched;
      const started = new Promise(resolve => { dispatched = resolve; });
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
        const pending = () => {
          dispatched();
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        };
        return stage === 'headers' ? pending() : Promise.resolve({
          status: 200, url: 'https://api.github.com/test',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: pending
        });
      });
      try {
        const client = new GitHubClient('test-token');
        const request = kind === 'rest'
          ? client.octokit.rest.pulls.submitReview({ owner: 'owner', repo: 'repo', pull_number: 1, review_id: 2, event: 'APPROVE' })
          : client.octokit.graphql('mutation { test }');
        const result = request.then(() => ({ settled: true }), error => ({ settled: true, error }));
        let settled = false;
        result.then(() => { settled = true; });
        await started;
        await vi.advanceTimersByTimeAsync(59999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect((await result).error.message).toContain('Request timed out');
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        fetch.mockRestore();
        timeout.mockRestore();
        vi.useRealTimers();
      }
    });

    it('gives a read-only auth retry a fresh deadline after slow token refresh', async () => {
      vi.useFakeTimers();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
        return controller.signal;
      });
      let refreshStarted;
      const refreshing = new Promise(resolve => { refreshStarted = resolve; });
      let releaseRefresh;
      const freshToken = new Promise(resolve => { releaseRefresh = resolve; });
      let retryStarted;
      const retrying = new Promise(resolve => { retryStarted = resolve; });
      const fetch = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{"message":"Bad credentials"}', {
          status: 401, headers: { 'content-type': 'application/json' }
        }))
        .mockImplementationOnce((_url, options) => {
          retryStarted();
          return new Promise((_resolve, reject) => {
            if (options.signal.aborted) reject(options.signal.reason);
            else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        });
      try {
        const caller = new AbortController();
        const client = new GitHubClient({
          token: 'old-token',
          refresh: () => { refreshStarted(); return freshToken; }
        });
        const result = client.octokit.request('GET /user', { request: { signal: caller.signal } })
          .then(() => null, error => error);
        let settled = false;
        result.then(() => { settled = true; });
        await refreshing;
        await vi.advanceTimersByTimeAsync(60001);
        releaseRefresh('new-token');
        await retrying;
        await vi.advanceTimersByTimeAsync(59999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect((await result).message).toContain('Request timed out');
        expect(caller.signal.aborted).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        fetch.mockRestore();
        timeout.mockRestore();
        vi.useRealTimers();
      }
    });

    it.each(['headers', 'body'])('preserves caller cancellation while waiting for response %s', async (stage) => {
      const caller = new AbortController();
      let boundaryStarted;
      const started = new Promise(resolve => { boundaryStarted = resolve; });
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
        const pending = () => {
          boundaryStarted();
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        };
        return stage === 'headers' ? pending() : Promise.resolve({
          status: 200, url: 'https://api.github.com/user',
          headers: new Headers({ 'content-type': 'application/json' }),
          json: pending
        });
      });
      try {
        const client = new GitHubClient('test-token');
        const result = client.octokit.request('GET /user', { request: { signal: caller.signal } })
          .then(() => null, error => error);
        await started;
        caller.abort(new DOMException('Caller cancelled', 'AbortError'));
        expect((await result).message).toBe('Caller cancelled');
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        fetch.mockRestore();
      }
    });
  });

  describe('getPendingReviewForUser', () => {
    it('should return the pending review authored by the viewer', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  id: 'PR_R_abc123',
                  databaseId: 12345,
                  body: 'My draft review',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345',
                  state: 'PENDING',
                  createdAt: '2024-01-15T10:00:00Z',
                  viewerDidAuthor: true,
                  comments: { totalCount: 3 }
                }
              ],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result).toEqual({
        id: 'PR_R_abc123',
        databaseId: 12345,
        body: 'My draft review',
        url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345',
        state: 'PENDING',
        createdAt: '2024-01-15T10:00:00Z',
        comments: { totalCount: 3 }
      });

    });

    it('should return null when no pending review exists', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result).toBeNull();
    });

    it('should filter out pending reviews not authored by the viewer', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  id: 'PR_R_other123',
                  databaseId: 99999,
                  body: 'Someone else draft',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-99999',
                  state: 'PENDING',
                  createdAt: '2024-01-14T10:00:00Z',
                  viewerDidAuthor: false,
                  comments: { totalCount: 1 }
                }
              ],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result).toBeNull();
    });

    it('should find the viewer pending review among multiple reviews', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  id: 'PR_R_other1',
                  databaseId: 11111,
                  body: 'Other user 1 draft',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-11111',
                  state: 'PENDING',
                  createdAt: '2024-01-13T10:00:00Z',
                  viewerDidAuthor: false,
                  comments: { totalCount: 0 }
                },
                {
                  id: 'PR_R_mine',
                  databaseId: 22222,
                  body: 'My draft',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-22222',
                  state: 'PENDING',
                  createdAt: '2024-01-14T10:00:00Z',
                  viewerDidAuthor: true,
                  comments: { totalCount: 5 }
                },
                {
                  id: 'PR_R_other2',
                  databaseId: 33333,
                  body: 'Other user 2 draft',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-33333',
                  state: 'PENDING',
                  createdAt: '2024-01-15T10:00:00Z',
                  viewerDidAuthor: false,
                  comments: { totalCount: 2 }
                }
              ],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result.id).toBe('PR_R_mine');
      expect(result.databaseId).toBe(22222);
    });

    it('should throw GitHubApiError with status 401 on authentication failure', async () => {
      const client = new GitHubClient('test-token');
      const authError = new Error('Bad credentials');
      authError.status = 401;
      const mockGraphql = vi.fn().mockRejectedValue(authError);
      client.octokit.graphql = mockGraphql;

      await expect(client.getPendingReviewForUser('owner', 'repo', 42))
        .rejects.toThrow('GitHub authentication failed');

      try {
        await client.getPendingReviewForUser('owner', 'repo', 42);
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(401);
      }
    });

    it('should throw GitHubApiError with status 404 when PR is not found', async () => {
      const client = new GitHubClient('test-token');
      const notFoundError = new Error('Not found');
      notFoundError.status = 404;
      const mockGraphql = vi.fn().mockRejectedValue(notFoundError);
      client.octokit.graphql = mockGraphql;

      await expect(client.getPendingReviewForUser('owner', 'repo', 999))
        .rejects.toThrow('Pull request #999 not found');

      try {
        await client.getPendingReviewForUser('owner', 'repo', 999);
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(404);
      }
    });

    it('should throw error on GraphQL errors', async () => {
      const client = new GitHubClient('test-token');
      const graphqlError = new Error('GraphQL error');
      graphqlError.errors = [{ message: 'Field X is invalid' }];
      const mockGraphql = vi.fn().mockRejectedValue(graphqlError);
      client.octokit.graphql = mockGraphql;

      await expect(client.getPendingReviewForUser('owner', 'repo', 42))
        .rejects.toThrow('GitHub GraphQL error: Field X is invalid');
    });

    it('does not present an unavailable PR as having no pending review', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: null
        }
      });
      client.octokit.graphql = mockGraphql;

      await expect(client.getPendingReviewForUser('owner', 'repo', 42)).rejects.toBeInstanceOf(Error);
    });
  });

  describe('getReviewById', () => {

    it('should return null when review is not found', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        node: null
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_nonexistent');

      expect(result).toBeNull();
    });

    it('rejects an incomplete review instead of reporting it absent', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        node: { state: 'PENDING' }  // Missing id
      });
      client.octokit.graphql = mockGraphql;

      await expect(client.getReviewById('PRR_invalid')).rejects.toBeInstanceOf(Error);
    });

    it('should return null on NOT_FOUND GraphQL error', async () => {
      const client = new GitHubClient('test-token');
      const notFoundError = new Error('Not found');
      notFoundError.errors = [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }];
      const mockGraphql = vi.fn().mockRejectedValue(notFoundError);
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_deleted');

      expect(result).toBeNull();
    });

    it('preserves network failure instead of reporting the review absent', async () => {
      const client = new GitHubClient('test-token');
      const networkError = new Error('Network timeout');
      const mockGraphql = vi.fn().mockRejectedValue(networkError);
      client.octokit.graphql = mockGraphql;

      await expect(client.getReviewById('PRR_network_error')).rejects.toBe(networkError);
    });


  });

  describe('fetchPullRequest', () => {
    // Minimal REST `pulls.get` payload. `base.repo` is present here; the
    // absent-`base.repo` case is covered separately below.
    const restPayload = (overrides = {}) => ({
      number: 7,
      node_id: 'PR_kwDO123',
      title: 'A title',
      body: 'A body',
      user: { login: 'octocat' },
      state: 'open',
      merged: false,
      base: {
        ref: 'main',
        sha: 'basesha',
        repo: {
          full_name: 'owner/repo',
          clone_url: 'https://github.com/owner/repo.git',
          ssh_url: 'git@github.com:owner/repo.git',
          default_branch: 'main'
        }
      },
      head: { ref: 'feature', sha: 'headsha' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      additions: 1,
      deletions: 0,
      changed_files: 1,
      mergeable: true,
      mergeable_state: 'clean',
      html_url: 'https://github.com/owner/repo/pull/7',
      ...overrides
    });

    /** Stub `octokit.rest.pulls.get` on a client with the supplied payload. */
    function stubPullsGet(client, data) {
      const get = vi.fn().mockResolvedValue({ data });
      // Replace the whole `rest` namespace: the real one is a lazy proxy that
      // throws when spread.
      client.octokit.rest = { pulls: { get } };
      return get;
    }

    const ALT_BINDING = {
      token: 'alt-token',
      apiHost: 'https://althost.example/api/v3',
      cloneUrl: 'https://althost.example/owner/repo.git'
    };

    it('leaves the API clone_url untouched for a plain-token client', async () => {
      const client = new GitHubClient('test-token');
      stubPullsGet(client, restPayload());

      const result = await client.fetchPullRequest('owner', 'repo', 7);

      expect(client.cloneUrl).toBeNull();
      expect(result.repository).toEqual({
        full_name: 'owner/repo',
        clone_url: 'https://github.com/owner/repo.git',
        ssh_url: 'git@github.com:owner/repo.git',
        default_branch: 'main'
      });
    });

    it('lets a configured cloneUrl override the API value', async () => {
      const client = new GitHubClient(ALT_BINDING);
      stubPullsGet(client, restPayload());

      const result = await client.fetchPullRequest('owner', 'repo', 7);

      expect(result.repository.clone_url).toBe('https://althost.example/owner/repo.git');
      // Other repository fields still come from the API.
      expect(result.repository.ssh_url).toBe('git@github.com:owner/repo.git');
      expect(result.repository.default_branch).toBe('main');
    });

    it('fills in clone_url when the host omits base.repo.clone_url', async () => {
      const client = new GitHubClient(ALT_BINDING);
      stubPullsGet(client, restPayload({
        base: {
          ref: 'main',
          sha: 'basesha',
          repo: { full_name: 'owner/repo', ssh_url: '', default_branch: 'trunk' }
        }
      }));

      const result = await client.fetchPullRequest('owner', 'repo', 7);

      expect(result.repository.clone_url).toBe('https://althost.example/owner/repo.git');
      expect(result.repository.default_branch).toBe('trunk');
    });

    it('does not throw when the host omits base.repo entirely', async () => {
      const client = new GitHubClient(ALT_BINDING);
      stubPullsGet(client, restPayload({ base: { ref: 'main', sha: 'basesha' } }));

      const result = await client.fetchPullRequest('owner', 'repo', 7);

      expect(result.repository).toEqual({
        full_name: 'owner/repo',
        clone_url: 'https://althost.example/owner/repo.git',
        ssh_url: undefined,
        default_branch: undefined
      });
      expect(result.base_branch).toBe('main');
    });

    it('falls back to owner/repo for full_name and leaves clone_url undefined with no binding value', async () => {
      const client = new GitHubClient('test-token');
      stubPullsGet(client, restPayload({ base: { ref: 'main', sha: 'basesha' } }));

      const result = await client.fetchPullRequest('acme', 'widget', 7);

      expect(result.repository.full_name).toBe('acme/widget');
      expect(result.repository.clone_url).toBeUndefined();
    });
  });

  describe('fetchPullRequestFiles', () => {
    it('should return mapped file objects from paginated API response', async () => {
      const client = new GitHubClient('test-token');
      const mockPaginate = vi.fn().mockResolvedValue([
        { filename: 'src/index.js', status: 'modified', additions: 10, deletions: 2, changes: 12, patch: '@@...' },
        { filename: 'src/utils.js', status: 'added', additions: 50, deletions: 0, changes: 50, patch: '@@...' }
      ]);
      client.octokit.paginate = mockPaginate;

      const result = await client.fetchPullRequestFiles('owner', 'repo', 42);

      expect(result).toEqual([
        { filename: 'src/index.js', status: 'modified', additions: 10, deletions: 2, changes: 12 },
        { filename: 'src/utils.js', status: 'added', additions: 50, deletions: 0, changes: 50 }
      ]);
      // Verify paginate was called with correct arguments
      expect(mockPaginate).toHaveBeenCalledWith(
        expect.any(Function),
        { owner: 'owner', repo: 'repo', pull_number: 42, per_page: 100 }
      );
    });

    it('should return empty array for PR with no changed files', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([]);

      const result = await client.fetchPullRequestFiles('owner', 'repo', 1);

      expect(result).toEqual([]);
    });

    it('should strip extra fields and only return filename, status, additions, deletions, changes', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([
        {
          sha: 'abc123',
          filename: 'README.md',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          blob_url: 'https://github.com/...',
          raw_url: 'https://github.com/...',
          contents_url: 'https://api.github.com/...',
          patch: '@@ -1 +1 @@\n-old\n+new'
        }
      ]);

      const result = await client.fetchPullRequestFiles('owner', 'repo', 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filename: 'README.md',
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2
      });
      // Ensure extra fields are NOT present
      expect(result[0]).not.toHaveProperty('sha');
      expect(result[0]).not.toHaveProperty('patch');
      expect(result[0]).not.toHaveProperty('blob_url');
    });

    it('should delegate to handleApiError on API failure', async () => {
      const client = new GitHubClient('test-token');
      const apiError = new Error('Not Found');
      apiError.status = 404;
      client.octokit.paginate = vi.fn().mockRejectedValue(apiError);

      await expect(client.fetchPullRequestFiles('owner', 'repo', 999))
        .rejects.toThrow('Pull request #999 not found');
    });
  });

  describe('listReviewComments', () => {
    it('should return raw paginated comment array for a PR', async () => {
      const client = new GitHubClient('test-token');
      const apiComments = [
        {
          id: 101,
          pull_request_review_id: 9001,
          in_reply_to_id: undefined,
          body: 'First comment',
          user: { login: 'alice', html_url: 'https://github.com/alice' },
          path: 'src/index.js',
          commit_id: 'abc123',
          original_commit_id: 'abc123',
          position: 5,
          original_position: 5,
          line: 42,
          start_line: null,
          original_line: 42,
          original_start_line: null,
          side: 'RIGHT',
          start_side: null,
          html_url: 'https://github.com/owner/repo/pull/42#discussion_r101',
          created_at: '2026-05-10T12:00:00Z',
          updated_at: '2026-05-10T12:00:00Z'
        },
        {
          id: 102,
          pull_request_review_id: 9002,
          in_reply_to_id: 101,
          body: 'Reply to first',
          user: { login: 'bob', html_url: 'https://github.com/bob' },
          path: 'src/index.js',
          commit_id: 'abc123',
          original_commit_id: 'abc123',
          position: null,
          original_position: 5,
          line: null,
          start_line: null,
          original_line: 42,
          original_start_line: null,
          side: 'RIGHT',
          start_side: null,
          html_url: 'https://github.com/owner/repo/pull/42#discussion_r102',
          created_at: '2026-05-11T09:00:00Z',
          updated_at: '2026-05-11T09:00:00Z'
        }
      ];
      const mockPaginate = vi.fn().mockResolvedValue(apiComments);
      client.octokit.paginate = mockPaginate;

      const result = await client.listReviewComments({
        owner: 'owner',
        repo: 'repo',
        pull_number: 42
      });

      // Returned raw, unchanged
      expect(result).toBe(apiComments);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(101);
      expect(result[1].in_reply_to_id).toBe(101);

      // paginate called with the rest endpoint and correct params
      expect(mockPaginate).toHaveBeenCalledTimes(1);
      expect(mockPaginate).toHaveBeenCalledWith(
        expect.any(Function),
        { owner: 'owner', repo: 'repo', pull_number: 42, per_page: 100 }
      );
      // The first arg should be the listReviewComments endpoint reference
      expect(mockPaginate.mock.calls[0][0]).toBe(client.octokit.rest.pulls.listReviewComments);
    });

    it('should return empty array for a PR with no review comments', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([]);

      const result = await client.listReviewComments({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1
      });

      expect(result).toEqual([]);
    });

    it('should throw GitHubApiError with status 404 when PR is not found', async () => {
      const client = new GitHubClient('test-token');
      const notFoundError = new Error('Not Found');
      notFoundError.status = 404;
      client.octokit.paginate = vi.fn().mockRejectedValue(notFoundError);

      try {
        await client.listReviewComments({ owner: 'owner', repo: 'repo', pull_number: 999 });
        throw new Error('Expected listReviewComments to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(404);
        expect(error.message).toContain('Pull request #999 not found');
      }
    });

    it('should throw GitHubApiError with status 429 on rate limit (403 + zero remaining)', async () => {
      const client = new GitHubClient('test-token');
      const rateLimitError = new Error('API rate limit exceeded');
      rateLimitError.status = 403;
      rateLimitError.response = {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60)
        }
      };
      client.octokit.paginate = vi.fn().mockRejectedValue(rateLimitError);

      try {
        await client.listReviewComments({ owner: 'owner', repo: 'repo', pull_number: 7 });
        throw new Error('Expected listReviewComments to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(429);
        expect(error.message).toContain('rate limit');
      }
    });

    it('should propagate network errors as GitHubApiError with status 503', async () => {
      const client = new GitHubClient('test-token');
      const networkError = new Error('getaddrinfo ENOTFOUND api.github.com');
      networkError.code = 'ENOTFOUND';
      client.octokit.paginate = vi.fn().mockRejectedValue(networkError);

      try {
        await client.listReviewComments({ owner: 'owner', repo: 'repo', pull_number: 3 });
        throw new Error('Expected listReviewComments to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(503);
        expect(error.message).toContain('Network error');
      }
    });
  });

  describe('GitHubApiError', () => {
    it('should be an instance of Error', () => {
      const error = new GitHubApiError('test message', 401);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(GitHubApiError);
    });

    it('should preserve the HTTP status code', () => {
      const error = new GitHubApiError('auth failed', 401);
      expect(error.status).toBe(401);
      expect(error.message).toBe('auth failed');
      expect(error.name).toBe('GitHubApiError');
    });

    it('should work with different status codes', () => {
      const codes = [401, 403, 404, 429, 503];
      for (const code of codes) {
        const error = new GitHubApiError(`error ${code}`, code);
        expect(error.status).toBe(code);
      }
    });
  });

  describe('handleApiError', () => {
    it('should throw GitHubApiError with status 401 for authentication errors', async () => {
      const client = new GitHubClient('test-token');
      const octokitError = new Error('Bad credentials');
      octokitError.status = 401;

      try {
        await client.handleApiError(octokitError, 'owner', 'repo', 1);
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(401);
        expect(error.message).toContain('authentication failed');
      }
    });

    it('should throw GitHubApiError with status 429 for rate limit errors', async () => {
      const client = new GitHubClient('test-token');
      const rateLimitError = new Error('Rate limit exceeded');
      rateLimitError.status = 403;
      rateLimitError.response = {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60)
        }
      };

      try {
        await client.handleApiError(rateLimitError, 'owner', 'repo', 1);
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(429);
        expect(error.message).toContain('rate limit');
      }
    });

    it('should throw GitHubApiError with status 403 for permission errors (non-rate-limit)', async () => {
      // Regression: a 403 with empty rate-limit headers (real permission /
      // scope failure) used to fall through to the generic `new Error()`
      // branch and route handlers mapped it to 500, hiding the real cause.
      // Now it surfaces as a typed GitHubApiError(status=403).
      const client = new GitHubClient('test-token');
      const permError = new Error('Forbidden');
      permError.status = 403;
      // No x-ratelimit-remaining header — this is NOT a rate-limit failure.
      permError.response = { headers: {} };

      let captured = null;
      try {
        await client.handleApiError(permError, 'owner', 'repo', 7);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(GitHubApiError);
      expect(captured.status).toBe(403);
      expect(captured.message).toMatch(/permissions|scopes/i);
      expect(captured.message).toContain('owner/repo');
    });

    it('should throw GitHubApiError with status 403 when response is missing entirely', async () => {
      // Defensive: some Octokit error paths don't attach `.response` at all.
      const client = new GitHubClient('test-token');
      const permError = new Error('Forbidden');
      permError.status = 403;

      let captured = null;
      try {
        await client.handleApiError(permError, 'owner', 'repo', 1);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(GitHubApiError);
      expect(captured.status).toBe(403);
    });

    it('should map 403 with retry-after header to a 429 rate-limit error (secondary rate limit)', async () => {
      // Regression: secondary rate limits / abuse detection return 403
      // WITHOUT the standard rate-limit headers but WITH a `retry-after`
      // header. Without this branch they were misclassified as permission
      // failures.
      const client = new GitHubClient('test-token');
      const secondaryRateLimitError = new Error('You have exceeded a secondary rate limit.');
      secondaryRateLimitError.status = 403;
      secondaryRateLimitError.response = { headers: { 'retry-after': '30' } };

      let captured = null;
      try {
        await client.handleApiError(secondaryRateLimitError, 'owner', 'repo', 1);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(GitHubApiError);
      expect(captured.status).toBe(429);
      expect(captured.message).toMatch(/rate limit/i);
      expect(captured.message).toContain('30');
    });

    it('should map 403 with "secondary rate limit" in the message to a 429 rate-limit error', async () => {
      const client = new GitHubClient('test-token');
      const secondary = new Error('Secondary rate limit triggered. Try again later.');
      secondary.status = 403;
      secondary.response = { headers: {} };

      let captured = null;
      try {
        await client.handleApiError(secondary, 'owner', 'repo', 1);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(GitHubApiError);
      expect(captured.status).toBe(429);
      expect(captured.message).toMatch(/rate limit/i);
    });

    it('should map 403 with "abuse" in the message to a 429 rate-limit error', async () => {
      const client = new GitHubClient('test-token');
      const abuse = new Error('You have triggered an abuse detection mechanism.');
      abuse.status = 403;
      abuse.response = { headers: {} };

      let captured = null;
      try {
        await client.handleApiError(abuse, 'owner', 'repo', 1);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(GitHubApiError);
      expect(captured.status).toBe(429);
      expect(captured.message).toMatch(/rate limit/i);
    });

    it('should still classify a plain "Forbidden" 403 as a permission error (regression)', async () => {
      // Make sure ITEM 9 didn't accidentally swallow legitimate permission
      // failures into the rate-limit branch.
      const client = new GitHubClient('test-token');
      const permError = new Error('Forbidden');
      permError.status = 403;
      permError.response = { headers: {} };

      let captured = null;
      try {
        await client.handleApiError(permError, 'owner', 'repo', 1);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(GitHubApiError);
      expect(captured.status).toBe(403);
      expect(captured.message).toMatch(/permissions|scopes/i);
    });

    it('should throw GitHubApiError with status 404 for not found errors', async () => {
      const client = new GitHubClient('test-token');
      const notFoundError = new Error('Not Found');
      notFoundError.status = 404;

      try {
        await client.handleApiError(notFoundError, 'owner', 'repo', 42);
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(404);
        expect(error.message).toContain('Pull request #42 not found');
      }
    });

    it('should throw GitHubApiError with status 503 for network errors', async () => {
      const client = new GitHubClient('test-token');
      const networkError = new Error('getaddrinfo ENOTFOUND api.github.com');
      networkError.code = 'ENOTFOUND';

      try {
        await client.handleApiError(networkError, 'owner', 'repo', 1);
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(503);
        expect(error.message).toContain('Network error');
      }
    });

    it('should throw plain Error for unknown errors', async () => {
      const client = new GitHubClient('test-token');
      const unknownError = new Error('Something unexpected');
      unknownError.status = 500;

      try {
        await client.handleApiError(unknownError, 'owner', 'repo', 1);
      } catch (error) {
        expect(error).not.toBeInstanceOf(GitHubApiError);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('GitHub API error');
      }
    });
  });

  describe('repositoryExists', () => {
    it('should throw GitHubApiError with status on auth failure', async () => {
      const client = new GitHubClient('test-token');
      const authError = new Error('Bad credentials');
      authError.status = 401;
      client.octokit.rest = { repos: { get: vi.fn().mockRejectedValue(authError) } };

      try {
        await client.repositoryExists('owner', 'repo');
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(401);
        expect(error.message).toContain('authentication failed');
      }
    });

    it('should throw GitHubApiError with status 403 on forbidden', async () => {
      const client = new GitHubClient('test-token');
      const forbiddenError = new Error('Forbidden');
      forbiddenError.status = 403;
      client.octokit.rest = { repos: { get: vi.fn().mockRejectedValue(forbiddenError) } };

      try {
        await client.repositoryExists('owner', 'repo');
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubApiError);
        expect(error.status).toBe(403);
      }
    });

    it('should return false for 404 (not throw)', async () => {
      const client = new GitHubClient('test-token');
      const notFoundError = new Error('Not Found');
      notFoundError.status = 404;
      client.octokit.rest = { repos: { get: vi.fn().mockRejectedValue(notFoundError) } };

      const result = await client.repositoryExists('owner', 'repo');
      expect(result).toBe(false);
    });
  });

  describe('searchPullRequests', () => {
    it('should call octokit.paginate with search.issuesAndPullRequests and the query', async () => {
      const client = new GitHubClient('test-token');
      const mockPaginate = vi.fn().mockResolvedValue([]);
      client.octokit.paginate = mockPaginate;

      await client.searchPullRequests('is:pr is:open review-requested:testuser');

      expect(mockPaginate).toHaveBeenCalledWith(
        client.octokit.rest.search.issuesAndPullRequests,
        { q: 'is:pr is:open review-requested:testuser', per_page: 100 }
      );
    });

    it('should correctly parse owner/repo from repository_url', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([
        {
          repository_url: 'https://api.github.com/repos/my-org/my-repo',
          number: 42,
          title: 'Fix bug',
          user: { login: 'alice' },
          updated_at: '2025-03-01T10:00:00Z',
          html_url: 'https://github.com/my-org/my-repo/pull/42',
          state: 'open'
        }
      ]);

      const result = await client.searchPullRequests('is:pr is:open');

      expect(result).toHaveLength(1);
      expect(result[0].owner).toBe('my-org');
      expect(result[0].repo).toBe('my-repo');
    });

    it('should map response items to the expected shape', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([
        {
          repository_url: 'https://api.github.com/repos/owner/repo',
          number: 10,
          title: 'Add feature',
          user: { login: 'bob' },
          updated_at: '2025-02-20T08:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/10',
          state: 'open'
        },
        {
          repository_url: 'https://api.github.com/repos/other/project',
          number: 5,
          title: 'Fix typo',
          user: { login: 'carol' },
          updated_at: '2025-02-21T09:00:00Z',
          html_url: 'https://github.com/other/project/pull/5',
          state: 'closed'
        }
      ]);

      const result = await client.searchPullRequests('is:pr');

      expect(result).toEqual([
        {
          owner: 'owner',
          repo: 'repo',
          number: 10,
          title: 'Add feature',
          author: 'bob',
          updated_at: '2025-02-20T08:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/10',
          state: 'open'
        },
        {
          owner: 'other',
          repo: 'project',
          number: 5,
          title: 'Fix typo',
          author: 'carol',
          updated_at: '2025-02-21T09:00:00Z',
          html_url: 'https://github.com/other/project/pull/5',
          state: 'closed'
        }
      ]);
    });

    it('should handle item.user being null (return author: null)', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([
        {
          repository_url: 'https://api.github.com/repos/owner/repo',
          number: 7,
          title: 'Ghost PR',
          user: null,
          updated_at: '2025-01-01T00:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/7',
          state: 'open'
        }
      ]);

      const result = await client.searchPullRequests('is:pr');

      expect(result).toHaveLength(1);
      expect(result[0].author).toBeNull();
    });

    it('should handle items with missing repository_url gracefully', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([
        {
          repository_url: undefined,
          number: 1,
          title: 'Bad item',
          user: { login: 'alice' },
          updated_at: '2025-01-01T00:00:00Z',
          html_url: 'https://github.com/unknown/pull/1',
          state: 'open'
        }
      ]);

      // The code does parts.pop() on undefined.split('/'), so it should throw
      await expect(client.searchPullRequests('is:pr')).rejects.toThrow();
    });

    it('should propagate API errors', async () => {
      const client = new GitHubClient('test-token');
      const apiError = new Error('API rate limit exceeded');
      apiError.status = 403;
      client.octokit.paginate = vi.fn().mockRejectedValue(apiError);

      await expect(client.searchPullRequests('is:pr'))
        .rejects.toThrow('API rate limit exceeded');
    });
  });

  describe('listOpenPullRequests', () => {
    it('should paginate rest.pulls.list for open PRs with owner/repo', async () => {
      const client = new GitHubClient('test-token');
      const mockPaginate = vi.fn().mockResolvedValue([]);
      client.octokit.paginate = mockPaginate;

      await client.listOpenPullRequests('acme', 'widget');

      expect(mockPaginate).toHaveBeenCalledWith(
        client.octokit.rest.pulls.list,
        { owner: 'acme', repo: 'widget', state: 'open', per_page: 100 }
      );
    });

    it('should map PR items to display + classification fields', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([
        {
          number: 12,
          title: 'Add feature',
          user: { login: 'alice' },
          updated_at: '2025-04-01T10:00:00Z',
          html_url: 'https://althost.example/acme/widget/pull/12',
          state: 'open',
          requested_reviewers: [{ login: 'bob' }, { login: 'carol' }],
          requested_teams: [{ slug: 'platform' }, { slug: 'infra' }]
        }
      ]);

      const result = await client.listOpenPullRequests('acme', 'widget');

      expect(result).toEqual([
        {
          owner: 'acme',
          repo: 'widget',
          number: 12,
          title: 'Add feature',
          author: 'alice',
          updated_at: '2025-04-01T10:00:00Z',
          html_url: 'https://althost.example/acme/widget/pull/12',
          state: 'open',
          requested_reviewers: ['bob', 'carol'],
          requested_teams: ['platform', 'infra']
        }
      ]);
    });

    it('should tolerate null user and missing reviewer/team arrays', async () => {
      const client = new GitHubClient('test-token');
      client.octokit.paginate = vi.fn().mockResolvedValue([
        {
          number: 3,
          title: 'Ghost PR',
          user: null,
          updated_at: '2025-01-01T00:00:00Z',
          html_url: 'https://althost.example/acme/widget/pull/3',
          state: 'open'
          // requested_reviewers / requested_teams absent
        }
      ]);

      const result = await client.listOpenPullRequests('acme', 'widget');

      expect(result[0].author).toBeNull();
      expect(result[0].requested_reviewers).toEqual([]);
      expect(result[0].requested_teams).toEqual([]);
    });

    it('should propagate API errors', async () => {
      const client = new GitHubClient('test-token');
      const apiError = new Error('Not Implemented');
      apiError.status = 501;
      client.octokit.paginate = vi.fn().mockRejectedValue(apiError);

      await expect(client.listOpenPullRequests('acme', 'widget'))
        .rejects.toThrow('Not Implemented');
    });
  });

  describe('getAuthenticatedUser', () => {

    it('should propagate errors', async () => {
      const client = new GitHubClient('test-token');
      const authError = new Error('Bad credentials');
      authError.status = 401;
      client.octokit.rest.users = { getAuthenticated: vi.fn().mockRejectedValue(authError) };

      await expect(client.getAuthenticatedUser())
        .rejects.toThrow('Bad credentials');
    });
  });

  describe('normaliseBinding refresh preservation', () => {
    const { normaliseBinding } = require('../../src/github/client');

    it('preserves a refresh function from an object binding', () => {
      const refresh = () => 'fresh';
      const result = normaliseBinding({ token: 't', apiHost: null, refresh });
      expect(result.refresh).toBe(refresh);
    });

    it('sets refresh to null for the legacy bare-token path', () => {
      const result = normaliseBinding('bare-token');
      expect(result.refresh).toBeNull();
    });

    it('sets refresh to null when an object binding has no refresh', () => {
      const result = normaliseBinding({ token: 't' });
      expect(result.refresh).toBeNull();
    });
  });

  describe('refresh-on-401 retry', () => {
    let originalFetch;
    let infoSpy;
    let warnSpy;

    // Build a minimal fetch Response octokit's request layer can parse.
    // Captures the outgoing Authorization header so tests can assert which
    // token was used on each attempt. `extraHeaders` (e.g. a `link` header)
    // lets pagination tests drive octokit's "next page" detection.
    function makeResponse(status, bodyObj, extraHeaders = {}) {
      const bodyText = JSON.stringify(bodyObj ?? {});
      const headerEntries = [
        ['content-type', 'application/json; charset=utf-8'],
        ...Object.entries(extraHeaders)
      ];
      const headers = {
        get: (name) => {
          const found = headerEntries.find(([k]) => k.toLowerCase() === name.toLowerCase());
          return found ? found[1] : null;
        },
        [Symbol.iterator]: function* () { yield* headerEntries; }
      };
      return {
        url: 'https://api.github.com/test',
        status,
        headers,
        json: async () => JSON.parse(bodyText),
        text: async () => bodyText
      };
    }

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      const logger = require('../../src/utils/logger');
      infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('refreshes the token and retries once on a 401, returning the success result', async () => {
      const authHeaders = [];
      const refresh = vi.fn(() => 'fresh-token');
      globalThis.fetch = vi.fn(async (url, opts) => {
        authHeaders.push(opts.headers.authorization);
        if (authHeaders.length === 1) {
          return makeResponse(401, { message: 'Bad credentials' });
        }
        return makeResponse(200, { login: 'octocat', name: 'Octo', avatar_url: 'x' });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      const user = await client.getAuthenticatedUser();
      expect(user.login).toBe('octocat');

      // refresh called once; two HTTP attempts.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(authHeaders).toHaveLength(2);
      // First attempt used the stale token, retry used the fresh token.
      expect(authHeaders[0]).toBe('token stale-token');
      expect(authHeaders[1]).toBe('token fresh-token');
      // Client now carries the fresh token for future calls.
      expect(client.token).toBe('fresh-token');
      expect(infoSpy).toHaveBeenCalled();
    });

    it('uses the refreshed instance for all future calls (no second refresh)', async () => {
      const refresh = vi.fn(() => 'fresh-token');
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call += 1;
        if (call === 1) return makeResponse(401, { message: 'Bad credentials' });
        return makeResponse(200, { login: 'octocat', name: 'Octo', avatar_url: 'x' });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });
      await client.getAuthenticatedUser(); // triggers refresh
      await client.getAuthenticatedUser(); // should NOT refresh again

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(call).toBe(3); // 401, retry-success, second-call-success
    });

    it('does NOT retry when no refresh capability is available (bare token)', async () => {
      let attempts = 0;
      globalThis.fetch = vi.fn(async () => {
        attempts += 1;
        return makeResponse(401, { message: 'Bad credentials' });
      });

      const client = new GitHubClient('bare-token'); // no refresh

      await expect(client.getAuthenticatedUser()).rejects.toThrow();
      expect(attempts).toBe(1);
    });

    it('retries at most once even when the fresh token is also rejected', async () => {
      const refresh = vi.fn(() => 'fresh-token');
      let attempts = 0;
      globalThis.fetch = vi.fn(async () => {
        attempts += 1;
        return makeResponse(401, { message: 'Bad credentials' });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      await expect(client.getAuthenticatedUser()).rejects.toThrow();
      // Exactly two attempts (original + one retry); refresh called once.
      expect(attempts).toBe(2);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does NOT refresh-and-retry when refresh returns an unchanged token', async () => {
      const refresh = vi.fn(() => 'stale-token'); // same as current
      let attempts = 0;
      globalThis.fetch = vi.fn(async () => {
        attempts += 1;
        return makeResponse(401, { message: 'Bad credentials' });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      await expect(client.getAuthenticatedUser()).rejects.toThrow();
      expect(refresh).toHaveBeenCalledTimes(1);
      // No retry because the token did not change.
      expect(attempts).toBe(1);
    });

    it('does NOT refresh-and-retry when refresh returns an empty token', async () => {
      const refresh = vi.fn(() => '');
      let attempts = 0;
      globalThis.fetch = vi.fn(async () => {
        attempts += 1;
        return makeResponse(401, { message: 'Bad credentials' });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      await expect(client.getAuthenticatedUser()).rejects.toThrow();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(attempts).toBe(1);
    });

    it('does NOT retry on a 403 error', async () => {
      const refresh = vi.fn(() => 'fresh-token');
      let attempts = 0;
      globalThis.fetch = vi.fn(async () => {
        attempts += 1;
        return makeResponse(403, { message: 'Forbidden' });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      await expect(client.getAuthenticatedUser()).rejects.toThrow();
      expect(refresh).not.toHaveBeenCalled();
      expect(attempts).toBe(1);
    });

    it('does NOT retry on a 404 error', async () => {
      const refresh = vi.fn(() => 'fresh-token');
      let attempts = 0;
      globalThis.fetch = vi.fn(async () => {
        attempts += 1;
        return makeResponse(404, { message: 'Not Found' });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      await expect(client.repositoryExists('o', 'r')).resolves.toBe(false);
      expect(refresh).not.toHaveBeenCalled();
      expect(attempts).toBe(1);
    });

    it('covers GraphQL calls (401 on a graphql request triggers refresh-and-retry)', async () => {
      const authHeaders = [];
      const refresh = vi.fn(() => 'fresh-token');
      globalThis.fetch = vi.fn(async (url, opts) => {
        authHeaders.push(opts.headers.authorization);
        if (authHeaders.length === 1) {
          return makeResponse(401, { message: 'Bad credentials' });
        }
        return makeResponse(200, { data: { viewer: { login: 'octocat' } } });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      const result = await client.octokit.graphql('query { viewer { login } }');
      expect(result.viewer.login).toBe('octocat');
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(authHeaders).toEqual(['token stale-token', 'token fresh-token']);
    });

    // Regression: a token that expires mid-`octokit.paginate` must recover on
    // EVERY page. This reproduces the old instance-swap bug: page 1's 401
    // refreshes the token, and under the old design the paginate loop stayed
    // bound to the stale instance, so page 2's 401 hit the `fresh === this.token`
    // short-circuit and re-threw. With one long-lived instance reading
    // `this.token` per request, page 2 simply dispatches with the fresh token.
    it('recovers across pages when the token expires mid-paginate', async () => {
      const refresh = vi.fn(async () => 'fresh-token');
      globalThis.fetch = vi.fn(async (url, opts) => {
        const auth = opts.headers.authorization;
        // The stale token is rejected everywhere; only the fresh token works.
        if (auth === 'token stale-token') {
          return makeResponse(401, { message: 'Bad credentials' });
        }
        const isPage2 = String(url).includes('page=2');
        if (!isPage2) {
          return makeResponse(
            200,
            [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
            { link: '<https://api.github.com/repos/o/r/pulls/1/files?per_page=100&page=2>; rel="next"' }
          );
        }
        return makeResponse(
          200,
          [{ filename: 'b.js', status: 'added', additions: 2, deletions: 0, changes: 2 }]
        );
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      const files = await client.fetchPullRequestFiles('o', 'r', 1);

      // Both pages came back: the paginate loop survived the mid-flight refresh.
      expect(files.map((f) => f.filename)).toEqual(['a.js', 'b.js']);
      // Page 1's 401 refreshes once; page 2 then dispatches with the fresh
      // token and never 401s, so no second refresh.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(client.token).toBe('fresh-token');
    });

    // Regression: a burst of concurrent requests that all 401 on the now-stale
    // token must trigger exactly ONE refresh (coalesced via the shared
    // `_refreshing` promise) and all recover — not each refresh independently
    // and trip the old `fresh === this.token` short-circuit.
    it('coalesces concurrent 401s into a single refresh and recovers all', async () => {
      const refresh = vi.fn(async () => 'fresh-token');
      const seen = [];
      globalThis.fetch = vi.fn(async (url, opts) => {
        const auth = opts.headers.authorization;
        seen.push(auth);
        if (auth === 'token stale-token') {
          return makeResponse(401, { message: 'Bad credentials' });
        }
        return makeResponse(200, { login: 'octocat', name: 'Octo', avatar_url: 'x' });
      });

      const client = new GitHubClient({ token: 'stale-token', apiHost: null, refresh });

      const [a, b, c] = await Promise.all([
        client.getAuthenticatedUser(),
        client.getAuthenticatedUser(),
        client.getAuthenticatedUser()
      ]);

      expect(a.login).toBe('octocat');
      expect(b.login).toBe('octocat');
      expect(c.login).toBe('octocat');
      // Exactly one refresh despite three simultaneous 401s.
      expect(refresh).toHaveBeenCalledTimes(1);
      // Three initial attempts on the stale token, three retries on the fresh.
      expect(seen.filter((h) => h === 'token stale-token')).toHaveLength(3);
      expect(seen.filter((h) => h === 'token fresh-token')).toHaveLength(3);
    });
  });
});
