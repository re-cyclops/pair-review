// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { createHash } = require('node:crypto');

const cache = new Map();
const pending = new Map();
const accounts = new Map();
const waiters = [];
let active = 0;
const MAX_PAGES = 10;
const now = () => new Date().toISOString();
const unavailable = error => ({ availability: 'unavailable', reason: error?.status === 401 ? 'unauthenticated'
  : error?.status === 403 ? 'permission-denied-or-rate-limited' : error?.status === 404 ? 'not-available'
    : 'offline-or-unsupported', fetchedAt: null });
const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };
const person = user => user?.login ? { login: user.login, name: user.name || null, type: user.type || 'User' } : null;

const section = async operation => {
  try { return { availability: 'known', fetchedAt: now(), ...await operation() }; }
  catch (error) { return unavailable(error); }
};

const pages = async (method, params, field) => {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await method({ ...params, per_page: 100, page });
    const batch = field ? response.data[field] : response.data;
    if (!Array.isArray(batch)) throw new Error('Unexpected host response');
    items.push(...batch);
    if (!response.headers?.link?.includes('rel="next"') && batch.length < 100) return { items, complete: true };
  }
  return { items, complete: false };
};

// Comments and pending reviews are not opinions. A later comment does not erase a request for changes.
const effectiveReviews = reviews => {
  const byReviewer = new Map();
  for (const review of [...reviews].sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')) || a.id - b.id)) {
    if (!review.user?.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    byReviewer.set(review.user.login.toLowerCase(), {
      id: review.id, reviewer: person(review.user), state: review.state, commitSha: review.commit_id || null,
      submittedAt: review.submitted_at, url: safeUrl(review.html_url)
    });
  }
  return [...byReviewer.values()];
};

const readThreads = async (client, identity) => {
  // The GitHub review-thread connection is not assumed on compatible REST hosts.
  if (client.apiHost) return { availability: 'unavailable', reason: 'host-capability-unavailable', unresolved: null };
  const threads = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.octokit.graphql(`query ReviewThreads($owner:String!,$repo:String!,$number:Int!,$after:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        reviewDecision mergeStateStatus reviewThreads(first:100,after:$after) {
          nodes { id isResolved isOutdated comments(first:1) { nodes { url author { login } } } }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`, { owner: identity.owner, repo: identity.repo, number: identity.number, after });
    const pr = result.repository?.pullRequest;
    if (!pr?.reviewThreads) throw new Error('Review thread connection unavailable');
    threads.push(...pr.reviewThreads.nodes.map(thread => ({ id: thread.id, resolved: thread.isResolved,
      outdated: thread.isOutdated, url: safeUrl(thread.comments?.nodes?.[0]?.url) })));
    if (!pr.reviewThreads.pageInfo.hasNextPage) return { items: threads, unresolved: threads.filter(t => !t.resolved).length,
      complete: true, providerDecision: pr.reviewDecision, mergeState: pr.mergeStateStatus };
    after = pr.reviewThreads.pageInfo.endCursor;
  }
  return { availability: 'partial', items: threads, unresolved: threads.filter(t => !t.resolved).length, complete: false };
};

const checkItems = (items, source, sha) => items.map(item => source === 'check-run' ? {
  id: String(item.id), name: item.name, source, appId: item.app?.id ?? null, revision: sha,
  status: item.status, conclusion: item.conclusion, startedAt: item.started_at, completedAt: item.completed_at,
  url: safeUrl(item.details_url || item.html_url)
} : { id: String(item.id), name: item.context, source, appId: null, revision: sha,
  status: item.state === 'pending' ? 'queued' : 'completed', conclusion: item.state,
  startedAt: item.created_at, completedAt: item.updated_at, url: safeUrl(item.target_url) });

const readChecks = async (client, identity, sha) => {
  const params = { owner: identity.owner, repo: identity.repo, ref: sha };
  const runs = await section(async () => {
    const result = await pages(client.octokit.rest.checks.listForRef, { ...params, filter: 'all' }, 'check_runs');
    return { items: checkItems(result.items, 'check-run', sha), availability: result.complete ? 'known' : 'partial' };
  });
  const statuses = await section(async () => {
    const result = await pages(client.octokit.rest.repos.listCommitStatusesForRef, params);
    return { items: checkItems(result.items, 'commit-status', sha), availability: result.complete ? 'known' : 'partial' };
  });
  const items = [...(runs.items || []), ...(statuses.items || [])];
  // Keep attempts in items. Only the compact summary picks the latest identity per app/context.
  const latest = new Map();
  for (const item of [...items].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || Number(a.id) - Number(b.id))) {
    latest.set(`${item.source}:${item.appId}:${item.name}`, item);
  }
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0, neutral: 0, cancelled: 0, actionRequired: 0, unknown: 0 };
  for (const item of latest.values()) {
    if (item.status !== 'completed') counts.pending++;
    else if (item.conclusion === 'success') counts.passed++;
    else if (['failure', 'error', 'timed_out', 'startup_failure', 'stale'].includes(item.conclusion)) counts.failed++;
    else if (item.conclusion === 'action_required') counts.actionRequired++;
    else if (Object.hasOwn(counts, item.conclusion)) counts[item.conclusion]++;
    else counts.unknown++;
  }
  return { availability: runs.availability === 'known' && statuses.availability === 'known' ? 'known' : items.length ? 'partial' : 'unavailable',
    fetchedAt: now(), revision: sha, items, counts, sources: { runs: runs.availability, statuses: statuses.availability } };
};

const collect = async (client, identity, accountKey) => {
  const params = { owner: identity.owner, repo: identity.repo, pull_number: identity.number };
  const response = await client.octokit.rest.pulls.get(params);
  const pr = response.data;
  let account = accounts.get(accountKey);
  if (!account || Date.now() - account.at > 300000) {
    account = { at: Date.now(), promise: section(async () => {
      const { data } = await client.octokit.rest.users.getAuthenticated();
      const teams = await section(async () => {
        const result = await pages(client.octokit.rest.teams?.listForAuthenticatedUser, {});
        return { availability: result.complete ? 'known' : 'partial', ids: result.items.map(team => team.id) };
      });
      return { ...person(data), teams };
    }) };
    accounts.set(accountKey, account);
    if (accounts.size > 32) accounts.delete(accounts.keys().next().value);
  }
  const viewerIdentity = await account.promise;
  const reviews = await section(async () => {
    const result = await pages(client.octokit.rest.pulls.listReviews, params);
    const effective = effectiveReviews(result.items);
    const viewerLogin = viewerIdentity.login?.toLowerCase();
    return { availability: result.complete ? 'known' : 'partial', complete: result.complete, effective,
      approving: effective.filter(r => r.state === 'APPROVED'),
      viewerReview: effective.find(r => r.reviewer.login.toLowerCase() === viewerLogin) || null,
      pending: result.items.some(r => r.state === 'PENDING' && r.user?.login?.toLowerCase() === viewerLogin) };
  });
  const requests = await section(async () => {
    const users = [];
    const teams = [];
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await client.octokit.rest.pulls.listRequestedReviewers({ ...params, per_page: 100, page });
      if (!Array.isArray(data.users) || !Array.isArray(data.teams)) throw new Error('Requested reviewers unavailable');
      users.push(...data.users);
      teams.push(...data.teams);
      if (!headers?.link?.includes('rel="next"') && Math.max(data.users.length, data.teams.length) < 100) { complete = true; break; }
    }
    return { availability: complete ? 'known' : 'partial',
      users: users.map(person).filter(Boolean), teams: teams.map(t => ({ id: t.id, slug: t.slug, name: t.name })) };
  });
  const policy = await section(async () => {
    const { data } = await client.octokit.rest.repos.getBranchProtection({ owner: identity.owner, repo: identity.repo, branch: pr.base.ref });
    const rules = await pages(client.octokit.rest.repos.getRulesForBranch, { owner: identity.owner, repo: identity.repo, branch: pr.base.ref });
    const ruleReviews = rules.items.filter(r => r.type === 'pull_request').map(r => r.parameters || {});
    const approvalCounts = [data.required_pull_request_reviews?.required_approving_review_count ?? 0,
      ...ruleReviews.map(r => r.required_approving_review_count ?? 0)];
    const requiredChecks = [...(data.required_status_checks?.checks || []).map(c => ({ name: c.context, appId: c.app_id ?? null })),
      ...(data.required_status_checks?.contexts || []).filter(name => !data.required_status_checks?.checks?.some(c => c.context === name)).map(name => ({ name, appId: null })),
      ...rules.items.filter(r => r.type === 'required_status_checks').flatMap(r => (r.parameters?.required_status_checks || []).map(c => ({ name: c.context, appId: c.integration_id ?? null })))];
    return { availability: rules.complete ? 'known' : 'partial', requiredApprovalCount: Math.max(...approvalCounts),
      codeOwnersRequired: !!data.required_pull_request_reviews?.require_code_owner_reviews || ruleReviews.some(r => r.require_code_owner_review),
      dismissStale: !!data.required_pull_request_reviews?.dismiss_stale_reviews || ruleReviews.some(r => r.dismiss_stale_reviews_on_push),
      conversationResolution: !!data.required_conversation_resolution?.enabled || ruleReviews.some(r => r.required_review_thread_resolution),
      requiredChecks, otherRules: rules.items.filter(r => !['pull_request', 'required_status_checks'].includes(r.type)).map(r => r.type),
      source: 'branch-protection-and-effective-rules', requirementKnowledge: 'partial',
      note: 'Code-owner eligibility, bypass permissions and merge-queue requirements are not inferred' };
  });
  const threads = await section(() => readThreads(client, identity));
  const checks = await readChecks(client, identity, pr.head.sha);
  const testMerge = pr.merge_commit_sha && !pr.merged && pr.merge_commit_sha !== pr.head.sha
    ? await readChecks(client, identity, pr.merge_commit_sha) : null;
  const required = policy.requiredChecks?.map(rule => {
    const matching = checks.items.filter(c => c.name === rule.name && (rule.appId == null || c.appId === rule.appId));
    return { ...rule, presentOnHead: matching.length > 0,
      presentOnTestMerge: !!testMerge?.items.some(c => c.name === rule.name && (rule.appId == null || c.appId === rule.appId)) };
  }) ?? null;
  const own = viewerIdentity.login && pr.user?.login?.toLowerCase() === viewerIdentity.login.toLowerCase();
  const direct = requests.users ? requests.users.some(u => u.login.toLowerCase() === viewerIdentity.login?.toLowerCase()) : null;
  const viewerReview = reviews.viewerReview;
  const changeRequested = viewerReview?.state === 'CHANGES_REQUESTED';
  const newRevision = viewerReview?.commitSha ? viewerReview.commitSha !== pr.head.sha : null;
  const viaTeam = requests.teams?.some(team => viewerIdentity.teams?.ids?.includes(team.id)) || false;
  const responsibilityKnown = viewerIdentity.availability === 'known' && requests.availability === 'known'
    && reviews.availability === 'known' && (!requests.teams?.length || viewerIdentity.teams?.availability === 'known');
  const reason = own ? 'Your pull request' : direct ? 'Requested from you personally'
    : viaTeam ? 'Requested from one of your teams'
      : changeRequested ? (newRevision ? 'New commits since your request for changes' : 'Your request for changes is still outstanding')
        : reviews.pending ? 'You have an unpublished remote draft' : viewerReview?.state === 'APPROVED' ? 'You already approved; other requirements may remain'
          : !responsibilityKnown ? 'Your review responsibility is not fully known' : 'No individual review responsibility observed';
  return {
    identity: { host: client.apiHost || 'github.com', repository: `${identity.owner}/${identity.repo}`, number: identity.number, url: safeUrl(pr.html_url) },
    fetchedAt: now(), headSha: pr.head.sha, baseSha: pr.base.sha, baseBranch: pr.base.ref,
    state: pr.state, draft: !!pr.draft, merged: !!pr.merged, title: pr.title, author: person(pr.user),
    approvals: { ...reviews, observedCount: reviews.approving?.length ?? null, requiredCount: policy.requiredApprovalCount ?? null },
    viewer: { identity: viewerIdentity, self: !!own, requestedDirectly: direct, requestedTeams: requests.teams ?? null,
      effectiveReview: viewerReview || null, pendingReview: reviews.pending ?? null, newRevision,
      reason, requestedViaTeam: viaTeam, needsYou: own ? false : direct || viaTeam || changeRequested || reviews.pending ? true : responsibilityKnown ? false : null, soleBlocker: null },
    requests, threads, checks, testMerge, policy: { ...policy, requiredChecks: required },
    merge: { conflict: pr.mergeable == null ? null : !pr.mergeable, providerDecision: threads.providerDecision ?? null,
      providerMergeState: threads.mergeState ?? null, requirementKnowledge: policy.requirementKnowledge || 'unavailable' }
  };
};

const fetchReviewSnapshot = async (client, identity, { refresh = false } = {}) => {
  const accountKey = createHash('sha256').update(`${client.apiHost || 'github.com'}\0${client.token}`).digest('hex');
  const key = `${accountKey}:${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}#${identity.number}`;
  const cached = cache.get(key);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached?.retryAt > Date.now()) return cached.value;
  if (cached && age < (refresh ? 5000 : 30000)) return cached.value;
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    if (active >= 3) await new Promise(resolve => waiters.push(resolve));
    active++;
    try {
      const value = await collect(client, identity, accountKey);
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 512) cache.delete(cache.keys().next().value);
      return value;
    } catch (error) {
      const failure = unavailable(error);
      const value = { ...(cached?.value || { identity: { repository: `${identity.owner}/${identity.repo}`, number: identity.number } }),
        availability: cached?.value?.headSha ? 'stale' : 'unavailable', error: failure.reason,
        lastSuccessAt: cached?.value?.lastSuccessAt || cached?.value?.fetchedAt || null,
        retryAfterSeconds: Math.max(30, Math.min(3600, Number(error.response?.headers?.['retry-after']) || 60)) };
      cache.set(key, { at: Date.now(), value, retryAt: Date.now() + value.retryAfterSeconds * 1000 });
      if (cache.size > 512) cache.delete(cache.keys().next().value);
      return value;
    } finally { active--; waiters.shift()?.(); }
  })();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
};

module.exports = { effectiveReviews, fetchReviewSnapshot };
