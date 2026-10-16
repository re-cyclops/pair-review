// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const { GitHubClient } = require('../../src/github/client');
const configModule = require('../../src/config');
const { run, query } = require('../../src/database');
const logger = require('../../src/utils/logger');

// Capture the real getAuthenticatedUser before spying. The alt-host sweep and
// the github.com search share the same prototype, so alt-host tests mock this
// with an implementation that delegates the alt client (apiHost set) to the
// REAL octokit call — hitting a loopback alt host — while the github.com client
// (apiHost null) stays mocked. `listOpenPullRequests` is intentionally NOT
// spied so the alt client exercises the real REST path against the loopback.
const realGetAuthenticatedUser = GitHubClient.prototype.getAuthenticatedUser;

// Spy on config module to prevent writing to user's real config
vi.spyOn(configModule, 'getGitHubToken');

// Spy on GitHubClient prototype methods used by the collections routes
vi.spyOn(GitHubClient.prototype, 'getAuthenticatedUser');
vi.spyOn(GitHubClient.prototype, 'searchPullRequests');

// Load the route module (will use the mocked modules)
const githubCollectionsRoutes = require('../../src/routes/github-collections');

/**
 * Create a test Express app with the github-collections route
 */
function createTestApp(db, config = {}) {
  const app = express();
  app.use(express.json());

  app.set('db', db);
  app.set('config', config);

  app.use('/', githubCollectionsRoutes);

  return app;
}


// ============================================================================
// GitHub Collections Route Tests
// ============================================================================

describe('GitHub Collections Routes', () => {
  let db;
  let app;
  let server;

  // Populate ownership through the real refresh route before seeding rows used
  // by cache ordering/link tests. Legacy rows without an observation are unsafe.
  async function insertCachedPR(db, pr) {
    if (!db.prepare('SELECT 1 FROM github_collection_observations WHERE collection = ?').get(pr.collection)) {
      const identity = GitHubClient.prototype.getAuthenticatedUser.getMockImplementation();
      const search = GitHubClient.prototype.searchPullRequests.getMockImplementation();
      const list = vi.spyOn(GitHubClient.prototype, 'listOpenPullRequests').mockResolvedValue([]);
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({ login: 'fixture-reviewer' });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);
      try {
        const [collection, team] = pr.collection.split(':');
        const response = await request(server).post(`/api/github/${collection}/refresh`).query(team ? { team } : {});
        expect(response.status).toBe(200);
      } finally {
        GitHubClient.prototype.getAuthenticatedUser.mockImplementation(identity);
        GitHubClient.prototype.searchPullRequests.mockImplementation(search);
        list.mockRestore();
      }
    }
    await run(db, 'INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [pr.owner, pr.repo, pr.number, pr.title, pr.author, pr.updated_at, pr.html_url, pr.state, pr.collection]);
  }

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db, {
      github_token: 'test-token',
      port: 7247,
      theme: 'light'
    });
    server = await listenOnLoopback(app);
    vi.clearAllMocks();
    configModule.getGitHubToken.mockReturnValue('test-token');
    GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({ login: 'fixture-reviewer' });
    GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);
  });

  afterEach(async () => {
    await closeServer(server);
    if (db) {
      closeTestDatabase(db);
    }
  });

  it('keeps personal requests and effective change requests without resurrecting an already approved PR', async () => {
    configModule.getGitHubToken.mockReturnValue('test-token');
    GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({ login: 'reviewer' });
    const pr = number => ({ owner: 'example', repo: 'project', number, title: `Review ${number}`,
      author: number === 4 ? 'reviewer' : 'author', state: 'open',
      updated_at: '2026-01-01T00:00:00Z', html_url: `https://github.com/example/project/pull/${number}` });
    GitHubClient.prototype.searchPullRequests.mockImplementation(async query =>
      query.includes('reviewed-by:') ? [2, 3, 4, 5, 6].map(pr) : [pr(1)]);
    const opinion = (id, login, state) => ({ id, user: { login }, state, submitted_at: `2026-01-0${id}T00:00:00Z` });
    const histories = {
      2: [opinion(1, 'reviewer', 'CHANGES_REQUESTED'), opinion(2, 'reviewer', 'COMMENTED')],
      3: [opinion(1, 'reviewer', 'APPROVED'), opinion(2, 'someone-else', 'CHANGES_REQUESTED')],
      6: [opinion(1, 'reviewer', 'CHANGES_REQUESTED'), opinion(2, 'reviewer', 'DISMISSED')]
    };
    const transport = vi.spyOn(GitHubClient.prototype, '_buildOctokit').mockReturnValue({ rest: { pulls: {
      listReviews: async ({ pull_number }) => {
        if (pull_number === 5) throw Object.assign(new Error('Permission denied'), { status: 403 });
        return { data: histories[pull_number] || [], headers: {} };
      }
    } } });
    try {
      const response = await request(server).post('/api/github/review-requests/refresh');
      expect(response.status).toBe(200);
      expect(response.body.prs.map(pr => pr.number).sort()).toEqual([1, 2, 5]);
      expect(response.body.hosts).toContainEqual(expect.objectContaining({ repo: 'example/project#5', ok: false }));
      const cached = await request(server).get('/api/github/review-requests');
      expect(cached.body.prs.map(pr => pr.number).sort()).toEqual([1, 2, 5]);
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(Object.assign(new Error('Denied'), { status: 403 }));
      const denied = await request(server).post('/api/github/review-requests/refresh');
      expect(denied.status).toBe(403);
      expect(denied.body.availability).toBe('stale');
      expect((await request(server).get('/api/github/review-requests')).body.prs.map(pr => pr.number).sort()).toEqual([1, 2, 5]);
    } finally { transport.mockRestore(); }
  });

  it('does not return another credential context’s cached queue after an account change', async () => {
    configModule.getGitHubToken.mockReturnValue('first-fixture-credential');
    GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({ login: 'first-reviewer' });
    GitHubClient.prototype.searchPullRequests.mockResolvedValue([{
      owner: 'example', repo: 'private-project', number: 42, title: 'First account review',
      author: 'first-reviewer', updated_at: '2026-01-01T00:00:00Z',
      html_url: 'https://github.com/example/private-project/pull/42', state: 'open'
    }]);
    const refreshed = await request(server).post('/api/github/my-prs/refresh');
    expect(refreshed.status).toBe(200);
    expect((await request(server).get('/api/github/my-prs')).body.prs.map(pr => pr.number)).toEqual([42]);
    configModule.getGitHubToken.mockReturnValue('second-fixture-credential');
    const changed = await request(server).get('/api/github/my-prs');
    expect(changed.body.prs).toEqual([]);
    expect(changed.body.availability).toBe('unavailable');
    expect(GitHubClient.prototype.getAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a successfully empty queue from an unobserved cache', async () => {
    configModule.getGitHubToken.mockReturnValue('empty-fixture-credential');
    const absent = await request(server).get('/api/github/my-prs');
    expect(absent.body.availability).toBe('unavailable');
    GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({ login: 'reviewer' });
    GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);
    const refreshed = await request(server).post('/api/github/my-prs/refresh');
    expect(refreshed.status).toBe(200);
    const known = await request(server).get('/api/github/my-prs');
    expect(known.body).toMatchObject({ prs: [], availability: 'known', fetched_at: expect.any(String) });
  });

  it.each([false, true])('does not let an older account refresh replace newer rows or freshness (fails: %s)', async fails => {
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { started = resolve; });
    const pr = (number, author) => ({ owner: 'example', repo: 'project', number, title: `Review ${number}`, author,
      state: 'open', updated_at: '2026-01-01T00:00:00Z', html_url: `https://github.com/example/project/pull/${number}` });
    GitHubClient.prototype.getAuthenticatedUser.mockImplementation(function () {
      return Promise.resolve({ login: this.token === 'old-fixture' ? 'old-account' : 'new-account' });
    });
    GitHubClient.prototype.searchPullRequests.mockImplementation(async function () {
      if (this.token !== 'old-fixture') return [pr(2, 'new-account')];
      started();
      await gate;
      if (fails) throw Object.assign(new Error('Late account failure'), { status: 429 });
      return [pr(1, 'old-account')];
    });
    configModule.getGitHubToken.mockReturnValue('old-fixture');
    const older = request(server).post('/api/github/my-prs/refresh').then(response => response);
    await reading;
    let newer;
    try {
      configModule.getGitHubToken.mockReturnValue('new-fixture');
      newer = await request(server).post('/api/github/my-prs/refresh');
      expect(newer.body.prs.map(pr => pr.number)).toEqual([2]);
    } finally { release(); }
    expect((await older).body.prs).toEqual([]);
    const cached = await request(server).get('/api/github/my-prs');
    expect(cached.body.prs.map(pr => pr.number)).toEqual([2]);
    expect(cached.body.availability).toBe('known');
    expect(cached.body.fetched_at).toBe(newer.body.fetched_at);
  });

  it.each(['identity', 'queue'])('binds a native credential change to the identity actually read (%s)', async stage => {
    configModule.getGitHubToken.mockReturnValue('initial-fixture');
    const change = client => {
      client.token = 'renewed-fixture';
      configModule.getGitHubToken.mockReturnValue('renewed-fixture');
    };
    GitHubClient.prototype.getAuthenticatedUser.mockImplementation(function () {
      if (stage === 'identity') change(this);
      return Promise.resolve({ login: 'reviewer' });
    });
    GitHubClient.prototype.searchPullRequests.mockImplementation(async function () {
      if (stage === 'queue') change(this);
      return [{ owner: 'example', repo: 'project', number: 42, title: 'Account-scoped result', author: 'reviewer',
        state: 'open', updated_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/example/project/pull/42' }];
    });
    const refreshed = await request(server).post('/api/github/my-prs/refresh');
    expect(refreshed.status).toBe(stage === 'identity' ? 200 : 409);
    const cached = await request(server).get('/api/github/my-prs');
    expect(cached.body.prs.map(pr => pr.number)).toEqual(stage === 'identity' ? [42] : []);
    expect(cached.body.availability).toBe(stage === 'identity' ? 'known' : 'unavailable');
  });

  it('coalesces overlapping refreshes of the same credential context', async () => {
    let release;
    let started;
    let both;
    let requests = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { started = resolve; });
    const received = new Promise(resolve => { both = resolve; });
    const observe = req => { if (req.method === 'POST' && ++requests === 2) both(); };
    server.on('request', observe);
    GitHubClient.prototype.searchPullRequests.mockImplementation(async () => { started(); await gate; return []; });
    const first = request(server).post('/api/github/my-prs/refresh').then(response => response);
    await reading;
    const second = request(server).post('/api/github/my-prs/refresh').then(response => response);
    try { await received; } finally { release(); server.off('request', observe); }
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.body.availability)).toEqual(['known', 'known']);
    expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledTimes(1);
    expect(responses[0].body.fetched_at).toBe(responses[1].body.fetched_at);
  });

  it('does not reuse cached rows through conflicting case-aliased host credentials', async () => {
    configModule.getGitHubToken.mockReturnValue(null);
    const apiHost = 'https://host.example.invalid';
    const first = { api_host: apiHost, token: 'first-fixture' };
    app.set('config', { repos: { 'Example/Project': first } });
    const list = vi.spyOn(GitHubClient.prototype, 'listOpenPullRequests').mockResolvedValue([{
      owner: 'example', repo: 'project', number: 42, title: 'Scoped queue', author: 'fixture-reviewer',
      state: 'open', updated_at: '2026-01-01T00:00:00Z', html_url: `${apiHost}/example/project/pull/42`
    }]);
    try {
      const initial = await request(server).post('/api/github/my-prs/refresh');
      expect(initial.body.prs.map(pr => pr.number)).toEqual([42]);
      app.set('config', { repos: {
        'Example/Project': first,
        'example/project': { api_host: apiHost, token: 'second-fixture' }
      } });
      const ambiguous = await request(server).get('/api/github/my-prs');
      expect(ambiguous.body.prs).toEqual([]);
      expect(ambiguous.body.availability).toBe('unavailable');
      expect(list).toHaveBeenCalledTimes(1);
    } finally { list.mockRestore(); }
  });

  // ==========================================================================
  // GET /api/github/review-requests
  // ==========================================================================

  describe('GET /api/github/review-requests', () => {
    it('should return empty array when no cached data', async () => {
      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toEqual([]);
      expect(res.body.fetched_at).toBeNull();
    });

    it('should return cached data when present', async () => {
      await insertCachedPR(db, {
        owner: 'my-org', repo: 'my-repo', number: 42,
        title: 'Fix bug', author: 'alice',
        updated_at: '2025-03-01T10:00:00Z',
        html_url: 'https://github.com/my-org/my-repo/pull/42',
        state: 'open', collection: 'review-requests'
      });

      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0]).toMatchObject({
        owner: 'my-org',
        repo: 'my-repo',
        number: 42,
        title: 'Fix bug',
        author: 'alice',
        state: 'open'
      });
      expect(res.body.fetched_at).toBeTruthy();
    });

    it('should include host-aware repository links for cached PRs', async () => {
      const apiHost = 'https://meteorite.example/api/v3';
      app.set('config', {
        repos: {
          'shop/world': {
            api_host: apiHost,
            token: 'alt-fixture-token',
            exclusive: false,
            links: {
              external: {
                name: 'Meteorite',
                label: 'Open on Meteorite',
                url_template: 'https://meteorite.example/{owner}/{repo}/pull/{number}'
              }
            }
          }
        }
      });
      await insertCachedPR(db, {
        owner: 'shop', repo: 'world', number: 2000042,
        title: 'Meteorite PR', author: 'alice',
        updated_at: '2026-08-21T18:00:00Z',
        html_url: 'https://meteorite.example/shop/world/pull/2000042',
        state: 'open', collection: 'review-requests'
      });
      await run(db, 'UPDATE github_pr_cache SET host = ? WHERE owner = ? AND repo = ? AND number = ?', [
        apiHost,
        'shop',
        'world',
        2000042
      ]);

      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.prs[0].repo_links).toMatchObject({
        external: {
          name: 'Meteorite',
          label: 'Open on Meteorite',
          url_template: 'https://meteorite.example/{owner}/{repo}/pull/{number}'
        },
        github: false,
        graphite: false
      });
    });

    it('does not lend an exclusive alt-host repo\'s links to an authoritative github.com row', async () => {
      // resolveBindingRepositoryFromPR probes each alt entry's url_pattern
      // against a URL built from that entry's own api_host, so this anchored
      // monorepo pattern claims every owner/repo. This row came from the
      // github.com search branch, which stamps host NULL — the PR provably
      // lives on github.com, so the alt entry describes neither its API host
      // nor its checkout, and must not supply its links. Mirrors the parser
      // invariant that such an entry never binds a canonical github.com URL.
      app.set('config', {
        repos: {
          'acme/platform': {
            api_host: 'https://meteorite.example/api/v3',
            url_pattern: '^https://meteorite\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)',
            links: {
              external: {
                name: 'Meteorite',
                label: 'Open on Meteorite',
                url_template: 'https://meteorite.example/{owner}/{repo}/pull/{number}'
              },
              github: false
            }
          }
        }
      });
      await insertCachedPR(db, {
        owner: 'shop', repo: 'world', number: 7,
        title: 'A github.com PR', author: 'alice',
        updated_at: '2026-08-21T18:00:00Z',
        html_url: 'https://github.com/shop/world/pull/7',
        state: 'open', collection: 'review-requests'
      });

      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.prs[0].host).toBeNull();
      // Default github.com link set: the alt entry's `links` do not apply.
      expect(res.body.prs[0].repo_links).toEqual({
        external: null,
        github: true,
        graphite: true
      });
      // And the click must reach the same place the icon points at.
      expect(res.body.prs[0].setup_host).toBe('github');
    });

    it('emits the github sentinel only for a dual-host repo github.com row', async () => {
      app.set('config', {
        repos: {
          'shop/world': {
            api_host: 'https://meteorite.example/api/v3',
            exclusive: false,
            links: {
              external: {
                name: 'Meteorite',
                label: 'Open on Meteorite',
                url_template: 'https://meteorite.example/{owner}/{repo}/pull/{number}'
              }
            }
          }
        }
      });
      await insertCachedPR(db, {
        owner: 'shop', repo: 'world', number: 9,
        title: 'A github.com PR on a dual repo', author: 'alice',
        updated_at: '2026-08-21T18:00:00Z',
        html_url: 'https://github.com/shop/world/pull/9',
        state: 'open', collection: 'review-requests'
      });

      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.prs[0].setup_host).toBe('github');
      // A dual repo's github.com row hides the alt-host link, so the sentinel
      // and the rendered links agree: both mean github.com.
      expect(res.body.prs[0].repo_links.external).toBeNull();
      expect(res.body.prs[0].repo_links.github).toBe(true);
    });

    it('emits the api_host as setup_host for an alt-host row', async () => {
      const apiHost = 'https://meteorite.example/api/v3';
      app.set('config', {
        repos: {
          'acme/platform': {
            api_host: apiHost,
            token: 'alt-fixture-token',
            url_pattern: '^https://meteorite\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)',
            links: {
              external: {
                name: 'Meteorite',
                label: 'Open on Meteorite',
                url_template: 'https://meteorite.example/{owner}/{repo}/pull/{number}'
              },
              github: false
            }
          }
        }
      });
      await insertCachedPR(db, {
        owner: 'acme', repo: 'platform', number: 8,
        title: 'A Meteorite PR', author: 'alice',
        updated_at: '2026-08-21T18:00:00Z',
        html_url: 'https://meteorite.example/acme/platform/pull/8',
        state: 'open', collection: 'review-requests'
      });
      await run(db, 'UPDATE github_pr_cache SET host = ? WHERE number = ?', [apiHost, 8]);

      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.prs[0].setup_host).toBe(apiHost);
      expect(res.body.prs[0].repo_links.external).toMatchObject({ label: 'Open on Meteorite' });
      expect(res.body.prs[0].repo_links.github).toBe(false);
    });

    it('should return data sorted by updated_at DESC', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 1,
        title: 'Older PR', author: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open', collection: 'review-requests'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 2,
        title: 'Newer PR', author: 'bob',
        updated_at: '2025-03-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/2',
        state: 'open', collection: 'review-requests'
      });

      const res = await request(server).get('/api/github/review-requests');

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(2);
      expect(res.body.prs[0].number).toBe(2); // Newer first
      expect(res.body.prs[1].number).toBe(1);
    });

    it('should not return data from other collections', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 1,
        title: 'Review request', author: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open', collection: 'review-requests'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 2,
        title: 'My PR', author: 'bob',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/2',
        state: 'open', collection: 'my-prs'
      });

      const res = await request(server).get('/api/github/review-requests');

      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(1);
    });
  });

  // ==========================================================================
  // POST /api/github/review-requests/refresh
  // ==========================================================================

  describe('POST /api/github/review-requests/refresh', () => {
    it('should return 401 when no GitHub token configured', async () => {
      configModule.getGitHubToken.mockReturnValue(null);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should refresh cache with data from GitHub on success', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'project', number: 10,
          title: 'New feature', author: 'alice',
          updated_at: '2025-03-05T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/10',
          state: 'open'
        },
        {
          owner: 'org', repo: 'project', number: 11,
          title: 'Bug fix', author: 'bob',
          updated_at: '2025-03-04T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/11',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(2);
      expect(res.body.prs[0].number).toBe(10); // Sorted by updated_at DESC
      expect(res.body.prs[1].number).toBe(11);
      expect(res.body.fetched_at).toBeTruthy();

      // Verify the search query includes the authenticated user's login
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false user-review-requested:testuser'
      );
    });

    it('should clear old cached data before inserting new data', async () => {
      // Pre-populate cache with old data
      await insertCachedPR(db, {
        owner: 'old-org', repo: 'old-repo', number: 99,
        title: 'Stale PR', author: 'old-user',
        updated_at: '2024-01-01T00:00:00Z',
        html_url: 'https://github.com/old-org/old-repo/pull/99',
        state: 'open', collection: 'review-requests'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'new-org', repo: 'new-repo', number: 1,
          title: 'Fresh PR', author: 'new-user',
          updated_at: '2025-03-05T12:00:00Z',
          html_url: 'https://github.com/new-org/new-repo/pull/1',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].owner).toBe('new-org');
      // Old data should be gone
      const oldRows = await query(db, "SELECT * FROM github_pr_cache WHERE owner = 'old-org'", []);
      expect(oldRows).toHaveLength(0);
    });

    it('should not clear data from other collections', async () => {
      // Pre-populate my-prs cache
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 50,
        title: 'My PR', author: 'me',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/50',
        state: 'open', collection: 'my-prs'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      await request(server).post('/api/github/review-requests/refresh');

      // my-prs data should still be intact
      const myPrs = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'my-prs'", []);
      expect(myPrs).toHaveLength(1);
      expect(myPrs[0].number).toBe(50);
    });

    it('reports a host outage without certifying an empty queue', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockRejectedValue(new Error('Network timeout'));

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ success: false, prs: [], availability: 'unavailable', fetched_at: null });
    });
  });

  // ==========================================================================
  // GET /api/github/my-prs
  // ==========================================================================

  describe('GET /api/github/my-prs', () => {
    it('should return empty array when no cached data', async () => {
      const res = await request(server).get('/api/github/my-prs');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toEqual([]);
      expect(res.body.fetched_at).toBeNull();
    });

    it('should return cached data when present', async () => {
      await insertCachedPR(db, {
        owner: 'my-org', repo: 'my-repo', number: 15,
        title: 'My change', author: 'me',
        updated_at: '2025-02-15T10:00:00Z',
        html_url: 'https://github.com/my-org/my-repo/pull/15',
        state: 'open', collection: 'my-prs'
      });

      const res = await request(server).get('/api/github/my-prs');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0]).toMatchObject({
        owner: 'my-org',
        repo: 'my-repo',
        number: 15,
        title: 'My change',
        author: 'me',
        state: 'open'
      });
      expect(res.body.fetched_at).toBeTruthy();
    });

    it('should return data sorted by updated_at DESC', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 3,
        title: 'Old PR', author: 'me',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/3',
        state: 'open', collection: 'my-prs'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 4,
        title: 'Recent PR', author: 'me',
        updated_at: '2025-03-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/4',
        state: 'open', collection: 'my-prs'
      });

      const res = await request(server).get('/api/github/my-prs');

      expect(res.body.prs).toHaveLength(2);
      expect(res.body.prs[0].number).toBe(4); // Newer first
      expect(res.body.prs[1].number).toBe(3);
    });

    it('should not return data from other collections', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 20,
        title: 'My PR', author: 'me',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/20',
        state: 'open', collection: 'my-prs'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 21,
        title: 'Review request', author: 'someone',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/21',
        state: 'open', collection: 'review-requests'
      });

      const res = await request(server).get('/api/github/my-prs');

      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(20);
    });
  });

  // ==========================================================================
  // POST /api/github/my-prs/refresh
  // ==========================================================================

  describe('POST /api/github/my-prs/refresh', () => {
    it('should return 401 when no GitHub token configured', async () => {
      configModule.getGitHubToken.mockReturnValue(null);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should refresh cache with data from GitHub on success', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'myuser', name: 'My User', avatar_url: 'https://example.com/me.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'repo', number: 100,
          title: 'My big feature', author: 'myuser',
          updated_at: '2025-03-05T15:00:00Z',
          html_url: 'https://github.com/org/repo/pull/100',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(100);
      expect(res.body.fetched_at).toBeTruthy();

      // Verify the search query includes the authenticated user's login with author:
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false author:myuser'
      );
    });

    it('should clear old cached data before inserting new data', async () => {
      await insertCachedPR(db, {
        owner: 'old-org', repo: 'old-repo', number: 88,
        title: 'Old my PR', author: 'me',
        updated_at: '2024-06-01T00:00:00Z',
        html_url: 'https://github.com/old-org/old-repo/pull/88',
        state: 'open', collection: 'my-prs'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'me', name: 'Me', avatar_url: 'https://example.com/me.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'new-org', repo: 'new-repo', number: 200,
          title: 'Fresh PR', author: 'me',
          updated_at: '2025-03-05T12:00:00Z',
          html_url: 'https://github.com/new-org/new-repo/pull/200',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].owner).toBe('new-org');
      const oldRows = await query(db, "SELECT * FROM github_pr_cache WHERE owner = 'old-org'", []);
      expect(oldRows).toHaveLength(0);
    });

    it('should not clear data from other collections', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 60,
        title: 'Review request', author: 'someone',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/60',
        state: 'open', collection: 'review-requests'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'me', name: 'Me', avatar_url: 'https://example.com/me.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      await request(server).post('/api/github/my-prs/refresh');

      const reviewRequests = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'review-requests'", []);
      expect(reviewRequests).toHaveLength(1);
      expect(reviewRequests[0].number).toBe(60);
    });

  });

  // ==========================================================================
  // GET /api/github/team-reviews
  // ==========================================================================

  describe('GET /api/github/team-reviews', () => {
    it('should return empty array when no cached data', async () => {
      const res = await request(server).get('/api/github/team-reviews');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toEqual([]);
      expect(res.body.fetched_at).toBeNull();
    });

    it('should return only team-reviews cached data', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 1,
        title: 'Direct request', author: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open', collection: 'review-requests'
      });
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 2,
        title: 'Team request', author: 'bob',
        updated_at: '2025-01-02T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/2',
        state: 'open', collection: 'team-reviews'
      });

      const res = await request(server).get('/api/github/team-reviews');

      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(2);
    });
  });

  // ==========================================================================
  // POST /api/github/team-reviews/refresh
  // ==========================================================================

  describe('POST /api/github/team-reviews/refresh', () => {
    it('should return 401 when no GitHub token configured', async () => {
      configModule.getGitHubToken.mockReturnValue(null);

      const res = await request(server).post('/api/github/team-reviews/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should query for team requests excluding direct requests', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'project', number: 20,
          title: 'Team feature', author: 'carol',
          updated_at: '2025-03-05T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/20',
          state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/team-reviews/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(20);

      // Team reviews = requested via a team, excluding direct user requests
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false review-requested:testuser -user-review-requested:testuser'
      );
    });

    it('should query a specific team and omit the user exclusion when ?team is given', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'project', number: 30,
          title: 'Platform team PR', author: 'dave',
          updated_at: '2025-03-06T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/30',
          state: 'open'
        }
      ]);

      const res = await request(server)
        .post('/api/github/team-reviews/refresh')
        .query({ team: 'org/platform' });

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(30);

      // Filtered view drops the -user-review-requested exclusion.
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false team-review-requested:org/platform'
      );
    });

    it('should accept the team value from the request body', async () => {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      const res = await request(server)
        .post('/api/github/team-reviews/refresh')
        .send({ team: 'org/platform' });

      expect(res.status).toBe(200);
      expect(GitHubClient.prototype.searchPullRequests).toHaveBeenCalledWith(
        'is:pr is:open archived:false team-review-requested:org/platform'
      );
    });

    it.each(['foo', 'a/b/c', 'org/team;extra', 'org/te am', ''.padStart(3, ' ')])(
      'should return 400 and make no GitHub call for invalid team %j',
      async (team) => {
        configModule.getGitHubToken.mockReturnValue('test-token');
        GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
          login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
        });

        const res = await request(server)
          .post('/api/github/team-reviews/refresh')
          .query({ team });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/org\/team/);
        expect(GitHubClient.prototype.searchPullRequests).not.toHaveBeenCalled();
        expect(GitHubClient.prototype.getAuthenticatedUser).not.toHaveBeenCalled();
      }
    );

    it('should cache filtered results under a namespaced key without clobbering all-teams', async () => {
      // Seed the all-teams cache directly.
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 1,
        title: 'All-teams PR', author: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open', collection: 'team-reviews'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([
        {
          owner: 'org', repo: 'project', number: 30,
          title: 'Platform team PR', author: 'dave',
          updated_at: '2025-03-06T12:00:00Z',
          html_url: 'https://github.com/org/project/pull/30',
          state: 'open'
        }
      ]);

      // Refresh the filtered view.
      await request(server)
        .post('/api/github/team-reviews/refresh')
        .query({ team: 'org/platform' });

      // Filtered rows live under the namespaced collection key.
      const namespaced = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'team-reviews:org/platform'", []);
      expect(namespaced).toHaveLength(1);
      expect(namespaced[0].number).toBe(30);

      // The all-teams cache is untouched.
      const allTeams = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'team-reviews'", []);
      expect(allTeams).toHaveLength(1);
      expect(allTeams[0].number).toBe(1);

      // GET with the same ?team returns the namespaced rows.
      const getRes = await request(server)
        .get('/api/github/team-reviews')
        .query({ team: 'org/platform' });
      expect(getRes.status).toBe(200);
      expect(getRes.body.prs).toHaveLength(1);
      expect(getRes.body.prs[0].number).toBe(30);

      // GET without ?team still returns the all-teams cache.
      const getAll = await request(server).get('/api/github/team-reviews');
      expect(getAll.body.prs).toHaveLength(1);
      expect(getAll.body.prs[0].number).toBe(1);
    });

    it('should return 400 on GET with an invalid team', async () => {
      const res = await request(server)
        .get('/api/github/team-reviews')
        .query({ team: 'not-a-slug' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should not clear data from other collections', async () => {
      await insertCachedPR(db, {
        owner: 'org', repo: 'repo', number: 50,
        title: 'Direct request', author: 'me',
        updated_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/org/repo/pull/50',
        state: 'open', collection: 'review-requests'
      });

      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.getAuthenticatedUser.mockResolvedValue({
        login: 'testuser', name: 'Test User', avatar_url: 'https://example.com/avatar.png'
      });
      GitHubClient.prototype.searchPullRequests.mockResolvedValue([]);

      await request(server).post('/api/github/team-reviews/refresh');

      const reviewRequests = await query(db, "SELECT * FROM github_pr_cache WHERE collection = 'review-requests'", []);
      expect(reviewRequests).toHaveLength(1);
      expect(reviewRequests[0].number).toBe(50);
    });

  });

  // ==========================================================================
  // Alt-host sweep — refresh lists PRs from configured api_host repos too
  // ==========================================================================

  describe('alt-host sweep on refresh', () => {
    let altServer;
    let apiHost;

    // Alt-host PR fixtures (REST `pulls.list` shape). Classification:
    //   #101 authored by altuser        → my-prs
    //   #102 requests reviewer altuser   → review-requests
    //   #103 requests team platform only → team-reviews (all-teams)
    const ALT_PULLS = [
      {
        number: 101, title: 'Alt my PR', state: 'open',
        updated_at: '2025-04-01T10:00:00Z',
        html_url: 'https://althost.example/altorg/altrepo/pull/101',
        user: { login: 'altuser' }, requested_reviewers: [], requested_teams: []
      },
      {
        number: 102, title: 'Alt review request', state: 'open',
        updated_at: '2025-04-02T10:00:00Z',
        html_url: 'https://althost.example/altorg/altrepo/pull/102',
        user: { login: 'someoneelse' },
        requested_reviewers: [{ login: 'altuser' }], requested_teams: []
      },
      {
        number: 103, title: 'Alt team request', state: 'open',
        updated_at: '2025-04-03T10:00:00Z',
        html_url: 'https://althost.example/altorg/altrepo/pull/103',
        user: { login: 'other' },
        requested_reviewers: [], requested_teams: [{ slug: 'platform' }]
      }
    ];

    /**
     * Stand up a loopback HTTP server that speaks the alt-host REST subset the
     * sweep needs (`GET /user`, `GET /repos/:owner/:repo/pulls`). Handlers are
     * overridable to simulate failures.
     */
    async function startAltHost({ user, pulls, userStatus, pullsStatus } = {}) {
      const altApp = express();
      altApp.get('/user', (req, res) => {
        if (userStatus && userStatus >= 400) return res.status(userStatus).json({ message: 'alt /user failed' });
        res.json(user || { login: 'altuser' });
      });
      altApp.get('/repos/:owner/:repo/pulls', (req, res) => {
        if (pullsStatus && pullsStatus >= 400) return res.status(pullsStatus).json({ message: 'alt pulls failed' });
        res.json(pulls || ALT_PULLS);
      });
      altApp.get('/repos/:owner/:repo/pulls/:number/reviews', (req, res) => res.json([]));
      altServer = await listenOnLoopback(altApp);
      apiHost = `http://127.0.0.1:${altServer.address().port}`;
      return apiHost;
    }

    /**
     * Replace the outer no-repos app/server with one whose config has an
     * alt-host repo pointing at the loopback alt host.
     */
    async function useAltRepo(repoOverrides = {}) {
      await closeServer(server);
      const repos = {
        'altorg/altrepo': { api_host: apiHost, token: 'alt-token', exclusive: false, ...repoOverrides }
      };
      app = createTestApp(db, { github_token: 'test-token', port: 7247, theme: 'light', repos });
      server = await listenOnLoopback(app);
    }

    /** Wire the github.com client mocks (search + identity branch by apiHost). */
    function mockGithub(githubLogin, githubPrs) {
      configModule.getGitHubToken.mockReturnValue('test-token');
      GitHubClient.prototype.searchPullRequests.mockResolvedValue(githubPrs);
      GitHubClient.prototype.getAuthenticatedUser.mockImplementation(function () {
        // Alt client (apiHost set) hits the real loopback; github client is mocked.
        if (this.apiHost) return realGetAuthenticatedUser.call(this);
        return Promise.resolve({ login: githubLogin, name: 'GH User', avatar_url: '' });
      });
    }

    afterEach(async () => {
      await closeServer(altServer);
      altServer = null;
    });

    it('contributes alt-host rows (host stamped) alongside github rows (host NULL)', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', [
        {
          owner: 'gh-org', repo: 'gh-repo', number: 5,
          title: 'GitHub my PR', author: 'ghuser',
          updated_at: '2025-03-01T12:00:00Z',
          html_url: 'https://github.com/gh-org/gh-repo/pull/5', state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // github row stamped NULL, alt row #101 (authored by altuser) stamped host.
      const githubRow = res.body.prs.find(p => p.number === 5);
      const altRow = res.body.prs.find(p => p.number === 101);
      expect(githubRow).toBeTruthy();
      expect(githubRow.host).toBeNull();
      expect(altRow).toBeTruthy();
      expect(altRow.host).toBe(apiHost);
      expect(altRow.owner).toBe('altorg');
      expect(altRow.repo).toBe('altrepo');
      expect(altRow.author).toBe('altuser');

      // Only the my-prs alt PR is included; the review/team ones are not.
      expect(res.body.prs.some(p => p.number === 102 || p.number === 103)).toBe(false);

      // Per-host status reported, additive and honest.
      expect(res.body.hosts).toEqual([
        expect.objectContaining({ host: null, ok: true, availability: 'known' }),
        expect.objectContaining({ host: apiHost, repo: 'altorg/altrepo', ok: true, availability: 'known' })
      ]);

      // Persisted with host column.
      const dbRows = await query(db, "SELECT number, host FROM github_pr_cache WHERE collection = 'my-prs' ORDER BY number", []);
      expect(dbRows).toEqual([
        { number: 5, host: null },
        { number: 101, host: apiHost }
      ]);
    });

    it('classifies review-requests by requested_reviewers on the alt host', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);

      const res = await request(server).post('/api/github/review-requests/refresh');

      expect(res.status).toBe(200);
      const numbers = res.body.prs.map(p => p.number).sort();
      expect(numbers).toEqual([102]); // only the PR requesting altuser as reviewer
      expect(res.body.prs[0].host).toBe(apiHost);
    });

    it('classifies team-reviews by requested_teams (all-teams view)', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);

      const res = await request(server).post('/api/github/team-reviews/refresh');

      expect(res.status).toBe(200);
      const numbers = res.body.prs.map(p => p.number).sort();
      expect(numbers).toEqual([103]); // only the team-requested PR
    });

    it('retains the last successful host rows and freshness when that host becomes unavailable', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);
      const first = await request(server).post('/api/github/my-prs/refresh');
      expect(first.body.prs.map(pr => pr.number)).toEqual([101]);
      await run(db, "UPDATE github_pr_cache SET fetched_at = '2026-01-01T00:00:00Z' WHERE host = ?", [apiHost]);
      await closeServer(altServer);
      altServer = null;
      const unavailable = await request(server).post('/api/github/my-prs/refresh');
      expect(unavailable.status).toBe(200);
      expect(unavailable.body.prs.map(pr => pr.number)).toEqual([101]);
      expect(unavailable.body.prs[0].fetched_at).toBe('2026-01-01T00:00:00Z');
      expect(unavailable.body.hosts).toContainEqual(expect.objectContaining({ host: apiHost, ok: false }));
    });

    it('keeps github rows intact and reports the error when an alt host fails', async () => {
      await startAltHost({ pullsStatus: 500 });
      await useAltRepo();
      mockGithub('ghuser', [
        {
          owner: 'gh-org', repo: 'gh-repo', number: 7,
          title: 'GitHub PR', author: 'ghuser',
          updated_at: '2025-03-02T12:00:00Z',
          html_url: 'https://github.com/gh-org/gh-repo/pull/7', state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      // github.com refresh still succeeds with its rows.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(7);
      expect(res.body.prs[0].host).toBeNull();

      // The alt host failure is surfaced, not swallowed.
      expect(res.body.availability).toBe('partial');
      expect(res.body.hosts).toContainEqual(expect.objectContaining({ host: apiHost, repo: 'altorg/altrepo', ok: false, availability: 'unavailable' }));

      // Cache holds only the github row.
      const dbRows = await query(db, "SELECT number, host FROM github_pr_cache WHERE collection = 'my-prs'", []);
      expect(dbRows).toEqual([{ number: 7, host: null }]);
    });

    it('a failing /user on the alt host does not break the github refresh', async () => {
      await startAltHost({ userStatus: 500 });
      await useAltRepo();
      mockGithub('ghuser', []);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.hosts).toContainEqual(expect.objectContaining({ host: apiHost, ok: false, availability: 'unavailable' }));
    });

    it('retrying refresh does not duplicate alt-host rows', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);

      await request(server).post('/api/github/my-prs/refresh');
      await request(server).post('/api/github/my-prs/refresh');

      const dbRows = await query(db, "SELECT number, host FROM github_pr_cache WHERE collection = 'my-prs'", []);
      expect(dbRows).toEqual([{ number: 101, host: apiHost }]);
    });

    it('GET returns the host column for cached rows', async () => {
      await startAltHost();
      await useAltRepo();
      mockGithub('ghuser', []);

      await request(server).post('/api/github/my-prs/refresh');
      const res = await request(server).get('/api/github/my-prs');

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].host).toBe(apiHost);
    });

    it('refreshes an alt-host-only install with no github.com token (skips github branch)', async () => {
      await startAltHost();
      await useAltRepo(); // alt repo HAS a token ('alt-token')
      // No top-level github token — alt-host-only install.
      configModule.getGitHubToken.mockReturnValue(null);
      GitHubClient.prototype.getAuthenticatedUser.mockImplementation(function () {
        if (this.apiHost) return realGetAuthenticatedUser.call(this);
        return Promise.resolve({ login: 'ghuser', name: 'GH User', avatar_url: '' });
      });

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      // Alt rows still written (PR #101 authored by altuser → my-prs).
      expect(res.body.prs.some(p => p.number === 101 && p.host === apiHost)).toBe(true);
      // github.com search never ran without a token.
      expect(GitHubClient.prototype.searchPullRequests).not.toHaveBeenCalled();
      // Both sources reported: github skipped, alt host ok.
      expect(res.body.hosts).toContainEqual(expect.objectContaining({ host: null, ok: false, availability: 'unavailable' }));
      expect(res.body.hosts).toContainEqual(expect.objectContaining({ host: apiHost, repo: 'altorg/altrepo', ok: true, availability: 'known' }));

      // Persisted alt row present; no github rows.
      const dbRows = await query(db, "SELECT number, host FROM github_pr_cache WHERE collection = 'my-prs'", []);
      expect(dbRows).toEqual([{ number: 101, host: apiHost }]);
    });

    it('returns 401 when NO source can authenticate (no github token, token-less alt repo)', async () => {
      await closeServer(server);
      app = createTestApp(db, {
        port: 7247, theme: 'light',
        // Alt repo with api_host but no credentials, and no top-level github token.
        repos: { 'altorg/altrepo': { api_host: 'https://althost.example/api/v3', exclusive: false } }
      });
      server = await listenOnLoopback(app);
      configModule.getGitHubToken.mockReturnValue(null);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      // No probe attempted against the token-less repo.
      expect(GitHubClient.prototype.getAuthenticatedUser).not.toHaveBeenCalled();
    });


    it('reports a token-less alt repo without probing or error-logging', async () => {
      // Repo has api_host but no repo-scoped credentials → empty-token binding.
      // The sweep must NOT construct a client or probe (which would 401 and
      // spam error logs); it reports a per-host status at debug level instead.
      await closeServer(server);
      const missingCredHost = 'https://althost.example/api/v3';
      app = createTestApp(db, {
        github_token: 'test-token', port: 7247, theme: 'light',
        repos: { 'altorg/altrepo': { api_host: missingCredHost, exclusive: false } }
      });
      server = await listenOnLoopback(app);
      mockGithub('ghuser', [
        {
          owner: 'gh-org', repo: 'gh-repo', number: 11,
          title: 'GitHub PR', author: 'ghuser',
          updated_at: '2025-03-04T12:00:00Z',
          html_url: 'https://github.com/gh-org/gh-repo/pull/11', state: 'open'
        }
      ]);
      const errorSpy = vi.spyOn(logger, 'error');

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      // github rows intact.
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(11);
      // Per-host status surfaced with the config-gap reason.
      expect(res.body.hosts).toContainEqual(expect.objectContaining({ host: missingCredHost, repo: 'altorg/altrepo', ok: false, availability: 'unavailable' }));
      // No probe happened: getAuthenticatedUser called once (github only), and
      // no error-level log for a mere config gap.
      expect(GitHubClient.prototype.getAuthenticatedUser).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('skips a non-owner/repo config key and reports it without crashing', async () => {
      await startAltHost();
      await closeServer(server);
      // A monorepo-style key that is not `owner/repo`; the sweep cannot derive
      // a repo for pulls.list, so it must be skipped (not crash the refresh).
      app = createTestApp(db, {
        github_token: 'test-token', port: 7247, theme: 'light',
        repos: { 'weird-monorepo-key': { api_host: apiHost, token: 'alt-token', exclusive: false } }
      });
      server = await listenOnLoopback(app);
      mockGithub('ghuser', [
        {
          owner: 'gh-org', repo: 'gh-repo', number: 9,
          title: 'GitHub PR', author: 'ghuser',
          updated_at: '2025-03-03T12:00:00Z',
          html_url: 'https://github.com/gh-org/gh-repo/pull/9', state: 'open'
        }
      ]);

      const res = await request(server).post('/api/github/my-prs/refresh');

      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].number).toBe(9);
      expect(res.body.hosts).toContainEqual(expect.objectContaining({ host: apiHost, repo: null, ok: false, availability: 'unavailable' }));
      expect(JSON.stringify(res.body)).not.toContain('weird-monorepo-key');
    });
  });
});
