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

  it.each([false, true])('does not let an older request replace newer-head evidence (older failure: %s)', async failOlder => {
    const client = fixture();
    const get = client.octokit.rest.pulls.get;
    let releaseOlder, rejectOlder;
    const delayed = new Promise((resolve, reject) => { releaseOlder = resolve; rejectOlder = reject; });
    client.octokit.rest.pulls.get = vi.fn()
      .mockImplementationOnce(() => delayed)
      .mockImplementation(async () => {
        const response = await get();
        response.data.head.sha = 'new-head';
        return response;
      });
    client.octokit.rest.checks.listForRef = ({ ref }) => result({ check_runs: [
      { id: 1, name: 'ci', status: 'completed', conclusion: ref === 'new-head' ? 'failure' : 'success' }
    ] });
    const older = fetchReviewSnapshot(client, identity, { headSha: 'old-head' });
    const newer = await fetchReviewSnapshot(client, identity, { headSha: 'new-head' });
    expect(newer.headSha).toBe('new-head');
    if (failOlder) rejectOlder(Object.assign(new Error('Old request rate limited'), { status: 429 }));
    else {
      const response = await get();
      response.data.head.sha = 'old-head';
      releaseOlder(response);
    }
    await older;
    const current = await fetchReviewSnapshot(client, identity);
    expect(current.headSha).toBe('new-head');
    expect(current.checks.counts).toMatchObject({ failed: 1, passed: 0 });
    expect(current.availability).not.toBe('unavailable');
    expect(client.octokit.rest.pulls.get).toHaveBeenCalledTimes(2);
  });

  it('does not reuse earlier-head checks after a caller observes a new revision', async () => {
    const client = fixture();
    const get = client.octokit.rest.pulls.get;
    let head = 'first-head';
    client.octokit.rest.pulls.get = async () => {
      const response = await get();
      response.data.head.sha = head;
      return response;
    };
    client.octokit.rest.checks.listForRef = ({ ref }) => result({ check_runs: [{
      id: 1, name: 'ci', status: 'completed', conclusion: ref === 'first-head' ? 'success' : 'failure'
    }] });
    expect((await fetchReviewSnapshot(client, identity)).checks.counts.passed).toBe(1);
    head = 'second-head';
    const current = await fetchReviewSnapshot(client, identity, { headSha: head });
    expect(current).toMatchObject({ headSha: 'second-head', checks: { revision: 'second-head', counts: { failed: 1, passed: 0 } } });
  });

  it('does not certify an approval total when reviewers are deleted or history is truncated', async () => {
    const deleted = fixture();
    deleted.octokit.rest.pulls.listReviews = () => result([{ id: 1, user: null, state: 'APPROVED' }]);
    expect((await fetchReviewSnapshot(deleted, identity)).approvals)
      .toMatchObject({ availability: 'partial', unattributed: true, observedCount: null });
    const truncated = fixture();
    truncated.octokit.rest.pulls.listReviews = async () => ({
      data: [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED' }],
      headers: { link: '<next>; rel="next"' }
    });
    const partial = await fetchReviewSnapshot(truncated, identity);
    expect(partial.approvals).toMatchObject({ availability: 'partial', complete: false, observedCount: null });
    expect(partial.viewer.needsYou).toBeNull();
  });

  it('keeps viewer and team responsibility unknown when identity permissions are unavailable', async () => {
    const team = fixture();
    team.octokit.rest.teams.listForAuthenticatedUser = async () => { throw Object.assign(new Error('Denied'), { status: 403 }); };
    team.octokit.rest.pulls.listRequestedReviewers = () => result({ users: [], teams: [{ id: 7, slug: 'maintainers' }] });
    const teamSnapshot = await fetchReviewSnapshot(team, identity);
    const anonymous = fixture();
    anonymous.octokit.rest.users.getAuthenticated = async () => { throw Object.assign(new Error('Denied'), { status: 403 }); };
    anonymous.octokit.rest.pulls.listReviews = () => result([{ id: 1, state: 'PENDING', user: null }]);
    const unknown = await fetchReviewSnapshot(anonymous, identity);
    expect({ team: teamSnapshot.viewer.requestedViaTeam, teamNeeds: teamSnapshot.viewer.needsYou,
      self: unknown.viewer.self, direct: unknown.viewer.requestedDirectly, pending: unknown.viewer.pendingReview })
      .toEqual({ team: null, teamNeeds: null, self: null, direct: null, pending: null });
  });
});
