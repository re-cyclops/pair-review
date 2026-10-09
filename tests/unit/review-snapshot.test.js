// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
const { fetchReviewSnapshot, effectiveReviews } = require('../../src/github/operations/review-snapshot');
const identity = { owner: 'example', repo: 'project', number: 42 };
let sequence = 0;
const result = data => Promise.resolve({ data });
const fixture = () => ({ token: `fixture-${++sequence}`, apiHost: null, octokit: {
  rest: {
    users: { getAuthenticated: () => result({ login: 'reviewer' }) },
    teams: { listForAuthenticatedUser: () => result([{ id: 7, slug: 'maintainers' }]) },
    pulls: {
      get: () => result({ title: 'Fixture change', html_url: 'https://github.com/example/project/pull/42', state: 'open', user: { login: 'author' }, head: { sha: 'head' }, base: { sha: 'base', ref: 'main' }, mergeable: null }),
      listReviews: () => result([]), listRequestedReviewers: () => result({ users: [], teams: [] })
    },
    repos: { getBranchProtection: () => result({ required_pull_request_reviews: { required_approving_review_count: 2 }, required_status_checks: { contexts: ['ci'] } }),
      getRulesForBranch: () => result([]), listCommitStatusesForRef: () => result([]) },
    checks: { listForRef: () => result({ check_runs: [] }) }
  },
  graphql: () => Promise.resolve({ repository: { pullRequest: { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'UNKNOWN', reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } })
} });

describe('read-only review snapshots', () => {
  it('keeps reviewer opinions through later comments and replaces only that reviewer opinion', () => {
    const make = (id, login, state) => ({ id, user: { login }, state, submitted_at: `2026-01-0${id}`, commit_id: `sha-${id}` });
    expect(effectiveReviews([make(3, 'Pat', 'COMMENTED'), make(1, 'Pat', 'CHANGES_REQUESTED'), make(2, 'Kim', 'APPROVED')])
      .map(row => [row.reviewer.login, row.state])).toEqual([['Pat', 'CHANGES_REQUESTED'], ['Kim', 'APPROVED']]);
    expect(effectiveReviews([make(1, 'Pat', 'APPROVED'), make(2, 'pat', 'DISMISSED'), make(3, 'Pat', 'PENDING')])[0].state).toBe('DISMISSED');
  });

  it('distinguishes direct, team and self responsibility without asserting sole blockage', async () => {
    const direct = fixture();
    direct.octokit.rest.pulls.listRequestedReviewers = () => result({ users: [{ login: 'reviewer' }], teams: [] });
    const snapshot = await fetchReviewSnapshot(direct, identity);
    expect(snapshot.viewer).toMatchObject({ requestedDirectly: true, needsYou: true, self: false, soleBlocker: null });
    expect(snapshot.approvals).toMatchObject({ observedCount: 0, requiredCount: 2 });
    expect(snapshot.merge).toMatchObject({ conflict: null, requirementKnowledge: 'partial' });
    expect(snapshot.policy.requiredChecks).toEqual([{ name: 'ci', appId: null, presentOnHead: false, presentOnTestMerge: false }]);
    const team = fixture();
    team.octokit.rest.pulls.listRequestedReviewers = () => result({ users: [], teams: [{ id: 7, slug: 'maintainers' }] });
    expect((await fetchReviewSnapshot(team, identity)).viewer).toMatchObject({ requestedDirectly: false, requestedViaTeam: true, needsYou: true });
    const own = fixture();
    own.octokit.rest.users.getAuthenticated = () => result({ login: 'author' });
    expect((await fetchReviewSnapshot(own, identity)).viewer).toMatchObject({ self: true, needsYou: false });
  });

  it('retains successful check sources when permissions hide policy, reviews or another check source', async () => {
    const client = fixture();
    const denied = () => Promise.reject(Object.assign(new Error('denied'), { status: 403 }));
    client.octokit.rest.pulls.listReviews = denied;
    client.octokit.rest.repos.getBranchProtection = denied;
    client.octokit.rest.repos.listCommitStatusesForRef = denied;
    client.octokit.rest.checks.listForRef = () => result({ check_runs: [
      { id: 1, name: 'build', app: { id: 9 }, status: 'completed', conclusion: 'success', started_at: '2026-01-01' },
      { id: 2, name: 'build', app: { id: 9 }, status: 'completed', conclusion: 'failure', started_at: '2026-01-02' },
      { id: 3, name: 'lint', app: { id: 9 }, status: 'queued', conclusion: null }
    ] });
    const snapshot = await fetchReviewSnapshot(client, identity);
    expect(snapshot.approvals).toMatchObject({ availability: 'unavailable', observedCount: null, requiredCount: null });
    expect(snapshot.viewer.needsYou).toBeNull();
    expect(snapshot.checks).toMatchObject({ availability: 'partial', counts: { passed: 0, failed: 1, pending: 1 } });
    expect(snapshot.checks.items.map(item => item.id)).toEqual(['1', '2', '3']);
    expect(snapshot.policy.requiredChecks).toBeNull();
  });

  it('separates head and test-merge checks and account-scopes cached results', async () => {
    const first = fixture();
    const get = first.octokit.rest.pulls.get;
    first.octokit.rest.pulls.get = async () => ({ data: { ...(await get()).data, merge_commit_sha: 'merge' } });
    first.octokit.rest.checks.listForRef = ({ ref }) => result({ check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: ref === 'head' ? 'failure' : 'success' }] });
    const data = await fetchReviewSnapshot(first, identity);
    expect(data.checks).toMatchObject({ revision: 'head', counts: { failed: 1, passed: 0 } });
    expect(data.testMerge).toMatchObject({ revision: 'merge', counts: { failed: 0, passed: 1 } });
    const second = fixture();
    expect((await fetchReviewSnapshot(second, identity)).checks.counts.failed).toBe(0);
  });

  it('coalesces repeated reads and backs off rate-limited hosts rather than polling them', async () => {
    const client = fixture();
    client.octokit.rest.pulls.get = vi.fn(() => Promise.reject(Object.assign(new Error('rate limit'), { status: 403, response: { headers: { 'retry-after': '120' } } })));
    const [first, second] = await Promise.all([fetchReviewSnapshot(client, identity), fetchReviewSnapshot(client, identity)]);
    expect(first).toMatchObject({ availability: 'unavailable', retryAfterSeconds: 120, lastSuccessAt: null });
    expect(second).toEqual(first);
    expect(await fetchReviewSnapshot(client, identity, { refresh: true })).toEqual(first);
    expect(client.octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
  });

  it('paginates requested reviewers once per page without duplicating users and teams', async () => {
    const client = fixture();
    client.octokit.rest.pulls.listRequestedReviewers = vi.fn(({ page }) => Promise.resolve({
      data: page === 1 ? { users: [{ login: 'first' }], teams: [{ id: 9, slug: 'other' }] } : { users: [{ login: 'reviewer' }], teams: [] },
      headers: page === 1 ? { link: '<next>; rel="next"' } : {}
    }));
    const data = await fetchReviewSnapshot(client, identity);
    expect(data.requests.users.map(user => user.login)).toEqual(['first', 'reviewer']);
    expect(data.requests.teams.map(team => team.id)).toEqual([9]);
    expect(data.viewer.needsYou).toBe(true);
    expect(client.octokit.rest.pulls.listRequestedReviewers).toHaveBeenCalledTimes(2);
  });
});
