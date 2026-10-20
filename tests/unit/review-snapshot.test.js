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
    issues: { listEventsForTimeline: () => result([]) },
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
  const request = (created_at, target = { requested_reviewer: { login: 'reviewer' } }, actor = { login: 'requester', name: 'Real Requester', type: 'User' }) =>
    ({ event: 'review_requested', created_at, ...target, review_requester: actor });

  it('uses the earliest direct request across removals, submissions and re-requests, independently of current state', async () => {
    const client = fixture();
    const timeline = vi.fn(() => result([
      request('2026-01-01T00:00:00Z', { requested_reviewer: { login: 'someone-else' } }),
      request('2026-01-02T00:00:00Z', { requested_team: { id: 7, slug: 'maintainers' } }),
      request('2026-01-05T00:00:00Z'),
      { event: 'review_request_removed', created_at: '2026-01-06T00:00:00Z', requested_reviewer: { login: 'reviewer' } },
      request('2026-01-03T00:00:00Z', { requested_reviewer: { login: 'REVIEWER' } })
    ]));
    client.octokit.rest.issues.listEventsForTimeline = timeline;
    client.octokit.rest.pulls.listReviews = () => result([{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'another' }, submitted_at: '2026-01-07T00:00:00Z', commit_id: 'head' }]);
    const snapshot = await fetchReviewSnapshot(client, identity);
    expect(snapshot.viewer.reviewRequest).toMatchObject({ availability: 'known', firstRequestedAt: '2026-01-03T00:00:00.000Z',
      source: 'direct', team: null, requestedBy: { login: 'requester', name: 'Real Requester', type: 'User' } });
    expect(timeline).toHaveBeenCalledWith({ owner: 'example', repo: 'project', issue_number: 42, per_page: 100, page: 1 });
    expect(snapshot.viewer.requestedDirectly).toBe(false);
    expect(snapshot.viewer.needsYou).toBe(false);
    expect(snapshot.approvals.effective[0]).toMatchObject({ state: 'CHANGES_REQUESTED', reviewer: { login: 'another' } });
    expect(snapshot.headSha).toBe('head');
  });

  it('falls back only to known team IDs and attributes the actual actor', async () => {
    const client = fixture();
    client.octokit.rest.issues.listEventsForTimeline = () => result([
      request('invalid', { requested_reviewer: { login: 'other' } }),
      request('2026-01-01T00:00:00Z', { requested_team: { id: 99, slug: 'maintainers' } }),
      { ...request('2026-01-04T00:00:00Z', { requested_team: { id: 7, slug: 'maintainers', name: 'Maintainers' } }, null), actor: { login: 'actual-actor' } }
    ]);
    expect((await fetchReviewSnapshot(client, identity)).viewer.reviewRequest).toMatchObject({
      availability: 'known', source: 'team', firstRequestedAt: '2026-01-04T00:00:00.000Z',
      team: { id: 7, slug: 'maintainers', name: 'Maintainers' }, requestedBy: { login: 'actual-actor' }
    });
  });

  it.each(['truncated', 'invalid', 'identity', 'membership', 'target', 'unavailable'])('leaves first timing unknown for %s evidence', async kind => {
    const client = fixture();
    let events = [request('2026-01-01T00:00:00Z')];
    if (kind === 'invalid') events.push(request('not-a-date'));
    if (kind === 'membership') {
      events = [request('2026-01-01T00:00:00Z', { requested_team: { id: 7 } })];
      client.octokit.rest.teams.listForAuthenticatedUser = async () => { throw new Error('Unsupported'); };
    }
    if (kind === 'identity') client.octokit.rest.users.getAuthenticated = async () => { throw new Error('Offline'); };
    if (kind === 'target') events.push({ event: 'review_requested', created_at: '2025-01-01T00:00:00Z' });
    client.octokit.rest.issues.listEventsForTimeline = vi.fn(async () => {
      if (kind === 'unavailable') throw Object.assign(new Error('Denied'), { status: 403 });
      return { data: events, headers: kind === 'truncated' ? { link: '<next>; rel="next"' } : {} };
    });
    const snapshot = await fetchReviewSnapshot(client, identity);
    expect(snapshot.viewer.reviewRequest).toMatchObject({ availability: kind === 'unavailable' ? 'unavailable' : 'partial',
      firstRequestedAt: null, source: null, team: null, requestedBy: null });
    expect(snapshot.approvals.availability).toBe('known');
    expect(snapshot.checks.availability).toBe('known');
    if (kind === 'truncated') expect(client.octokit.rest.issues.listEventsForTimeline).toHaveBeenCalledTimes(10);
  });

  it('distinguishes complete no-request history from unknown and does not guess requester from author', async () => {
    const none = await fetchReviewSnapshot(fixture(), identity);
    expect(none.viewer.reviewRequest).toMatchObject({ availability: 'known', firstRequestedAt: null, source: null, requestedBy: null });
    const client = fixture();
    client.octokit.rest.issues.listEventsForTimeline = ({ page }) => Promise.resolve({
      data: page === 1 ? [request('2026-01-04T00:00:00Z', undefined, null)] : [request('2026-01-02T00:00:00Z', undefined, null)],
      headers: page === 1 ? { link: '<next>; rel="next"' } : {}
    });
    expect((await fetchReviewSnapshot(client, identity)).viewer.reviewRequest).toMatchObject({
      availability: 'known', firstRequestedAt: '2026-01-02T00:00:00.000Z', requestedBy: null
    });
  });
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

  it('keeps wrong-revision results out of current-head and test-merge check evidence', async () => {
    const client = fixture();
    const get = client.octokit.rest.pulls.get;
    client.octokit.rest.pulls.get = async () => ({ data: { ...(await get()).data, merge_commit_sha: 'merge' } });
    client.octokit.rest.checks.listForRef = ({ ref }) => result({ check_runs: [{
      id: 1, name: 'ci', head_sha: ref === 'head' ? 'old-head' : 'head',
      status: 'completed', conclusion: 'success'
    }] });
    const snapshot = await fetchReviewSnapshot(client, identity);
    expect(snapshot.checks).toMatchObject({ availability: 'partial', counts: { passed: 0 } });
    expect(snapshot.checks.items[0].revision).toBe('old-head');
    expect(snapshot.testMerge).toMatchObject({ availability: 'partial', counts: { passed: 0 } });
    expect(snapshot.testMerge.items[0].revision).toBe('head');
    expect(snapshot.policy.requiredChecks).toEqual([
      { name: 'ci', appId: null, presentOnHead: false, presentOnTestMerge: false }
    ]);
  });

  it.each([[401, 'unauthenticated'], [429, 'rate-limited'], [503, 'offline-or-unsupported']])(
    'keeps an unobserved snapshot unavailable after HTTP %s', async (status, reason) => {
      const client = fixture();
      client.octokit.rest.pulls.get = async () => { throw Object.assign(new Error('Host read failed'), { status }); };
      expect(await fetchReviewSnapshot(client, identity))
        .toMatchObject({ availability: 'unavailable', error: reason, lastSuccessAt: null });
    });

  it('retains successful evidence as stale when a subsequent refresh fails', async () => {
    const client = fixture();
    const before = await fetchReviewSnapshot(client, identity);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    try {
      client.octokit.rest.pulls.get = async () => { throw Object.assign(new Error('Host offline'), { status: 503 }); };
      const stale = await fetchReviewSnapshot(client, identity, { refresh: true });
      expect(stale).toMatchObject({ availability: 'stale', headSha: before.headSha, lastSuccessAt: before.fetchedAt });
      expect(stale.approvals).toEqual(before.approvals);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not share GitHub evidence or assume GraphQL policy capabilities on an alternate host', async () => {
    const github = fixture();
    github.octokit.rest.pulls.listReviews = () => result([{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED' }]);
    expect((await fetchReviewSnapshot(github, identity)).approvals.observedCount).toBe(1);
    const alternate = fixture();
    alternate.token = github.token;
    alternate.apiHost = 'https://git.example.invalid/api/v3';
    alternate.octokit.rest.repos.getRulesForBranch = async () => { throw Object.assign(new Error('Unsupported'), { status: 404 }); };
    const snapshot = await fetchReviewSnapshot(alternate, identity);
    expect(snapshot).toMatchObject({
      identity: { host: alternate.apiHost },
      approvals: { observedCount: 0, requiredCount: null },
      threads: { availability: 'unavailable', reason: 'host-capability-unavailable', unresolved: null },
      policy: { availability: 'unavailable' }
    });
  });

  it('counts effective reviewers once without letting comments or pending drafts erase their opinions', async () => {
    const client = fixture();
    client.octokit.rest.pulls.listReviews = () => result([
      ['reviewer', 'APPROVED'], ['reviewer', 'APPROVED'], ['reviewer', 'COMMENTED'],
      ['kim', 'CHANGES_REQUESTED'], ['kim', 'APPROVED'], ['pat', 'PENDING'], ['reviewer', 'PENDING']
    ].map(([login, state], index) => ({ id: index + 1, user: { login }, state, submitted_at: `2026-01-0${index + 1}`, commit_id: 'head' })));
    const snapshot = await fetchReviewSnapshot(client, identity);
    expect(snapshot.approvals.observedCount).toBe(2);
    expect(snapshot.approvals.effective.map(review => [review.reviewer.login, review.state]))
      .toEqual([['reviewer', 'APPROVED'], ['kim', 'APPROVED']]);
    expect(snapshot.viewer).toMatchObject({ effectiveReview: { state: 'APPROVED' }, pendingReview: true, needsYou: true, soleBlocker: null });
  });

  it.each(['direct', 'team'])('keeps an explicit %s re-request actionable after the viewer approved', async kind => {
    const client = fixture();
    client.octokit.rest.pulls.listReviews = () => result([{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'head' }]);
    client.octokit.rest.pulls.listRequestedReviewers = () => result({
      users: kind === 'direct' ? [{ login: 'reviewer' }] : [],
      teams: kind === 'team' ? [{ id: 7, slug: 'maintainers' }] : []
    });
    expect((await fetchReviewSnapshot(client, identity)).viewer)
      .toMatchObject({ effectiveReview: { state: 'APPROVED' }, needsYou: true, requestedDirectly: kind === 'direct', requestedViaTeam: kind === 'team' });
  });

  it.each([0, 1])('distinguishes an observed requirement of %s approvals from an unknown requirement', async required => {
    const client = fixture();
    client.octokit.rest.repos.getBranchProtection = () => result({ required_pull_request_reviews: { required_approving_review_count: required } });
    expect((await fetchReviewSnapshot(client, identity)).approvals).toMatchObject({ observedCount: 0, requiredCount: required });
  });

  it('keeps partial code-owner rules and somebody else’s change request separate from viewer responsibility', async () => {
    const client = fixture();
    client.octokit.rest.pulls.listReviews = () => result([
      { id: 1, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'head' },
      { id: 2, user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', commit_id: 'head' }
    ]);
    client.octokit.rest.repos.getRulesForBranch = () => Promise.resolve({
      data: [{ type: 'pull_request', parameters: { required_approving_review_count: 3, require_code_owner_review: true } }],
      headers: { link: '<next>; rel="next"' }
    });
    const snapshot = await fetchReviewSnapshot(client, identity);
    expect(snapshot).toMatchObject({
      approvals: { observedCount: 1, requiredCount: null },
      policy: { availability: 'partial', codeOwnersRequired: true, requirementKnowledge: 'partial' },
      viewer: { effectiveReview: { state: 'APPROVED' }, needsYou: false, soleBlocker: null }
    });
    expect(snapshot.approvals.effective.find(review => review.reviewer.login === 'maintainer').state).toBe('CHANGES_REQUESTED');
  });

  it('separates check sources, reruns, pending and non-passing conclusions from a failing test merge', async () => {
    const client = fixture();
    const get = client.octokit.rest.pulls.get;
    client.octokit.rest.pulls.get = async () => ({ data: { ...(await get()).data, merge_commit_sha: 'merge' } });
    const runs = [
      ['pass', 'completed', 'success'], ['fail', 'completed', 'failure'],
      ['skip', 'completed', 'skipped'], ['neutral', 'completed', 'neutral'],
      ['cancel', 'completed', 'cancelled'], ['action', 'completed', 'action_required'],
      ['queued', 'queued', null], ['running', 'in_progress', null]
    ].map(([name, status, conclusion], index) => ({ id: index + 1, name, status, conclusion, app: { id: 1 }, started_at: '2026-01-01' }));
    runs.push(
      { id: 9, name: 'ci', app: { id: 1 }, status: 'completed', conclusion: 'success', started_at: '2026-01-01' },
      { id: 10, name: 'ci', app: { id: 1 }, status: 'queued', conclusion: null, started_at: '2026-01-02' },
      { id: 11, name: 'ci', app: { id: 2 }, status: 'completed', conclusion: 'success', started_at: '2026-01-02' }
    );
    client.octokit.rest.checks.listForRef = ({ ref }) => result({ check_runs: ref === 'head' ? runs : [
      { id: 20, name: 'merge-build', status: 'completed', conclusion: 'failure', head_sha: 'merge' }
    ] });
    client.octokit.rest.repos.listCommitStatusesForRef = ({ ref }) => result(ref === 'head'
      ? [{ id: 12, context: 'ci', state: 'error', created_at: '2026-01-02' }] : []);
    const snapshot = await fetchReviewSnapshot(client, identity);
    expect(snapshot.checks.counts).toEqual({ passed: 2, failed: 2, pending: 3, skipped: 1, neutral: 1, cancelled: 1, actionRequired: 1, unknown: 0 });
    expect(snapshot.testMerge).toMatchObject({ revision: 'merge', counts: { passed: 0, failed: 1 } });
  });

  it.each([false, true])('orders queued attempts without start timestamps (latest pending: %s)', async latestPending => {
    const client = fixture();
    client.octokit.rest.checks.listForRef = () => result({ check_runs: [
      { id: 1, name: 'ci', app: { id: 1 }, status: latestPending ? 'completed' : 'queued',
        conclusion: latestPending ? 'success' : null, started_at: latestPending ? '2026-01-01' : null },
      { id: 2, name: 'ci', app: { id: 1 }, status: latestPending ? 'queued' : 'completed',
        conclusion: latestPending ? null : 'success', started_at: latestPending ? null : '2026-01-02' }
    ] });
    expect((await fetchReviewSnapshot(client, identity)).checks.counts)
      .toMatchObject({ passed: latestPending ? 0 : 1, pending: latestPending ? 1 : 0 });
  });
});
