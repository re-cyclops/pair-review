// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { createHash, randomUUID } = require('node:crypto');
const simpleGit = require('simple-git');
const activity = require('./analysis-activity');
const { buildDiffLineSet } = require('./utils/diff-annotator');
const { reviewScope } = require('./local-scope');
const { formatAdoptedComment, resolveFormat } = require('./utils/comment-formatter');
const lifecycle = require('./github/operations/review-lifecycle');
const pendingComments = require('./github/operations/pending-review-comments');
const { resolveRepoLinks, substituteUrlTemplate } = require('./links/repo-links');
const { resolveBindingRepositoryForHost } = require('./utils/host-resolution');
const { USER_DRAFT_CONDITION } = require('./utils/stats-calculator');
const { checkReviewProse } = require('./utils/review-prose');

const active = new Set();
const anchors = new Map();
const terminal = new Set(['submitted', 'superseded']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, statusCode = 409, details = {}) => Object.assign(new Error(message), { statusCode, ...details });
const now = () => new Date().toISOString();

// Called by production migration/startup and the shared test schema. All intent
// and receipts live in the existing database, not a second job/draft store.
function initializeSubmissionState(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS submission_attempts (
      id TEXT PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      target_key TEXT NOT NULL, manifest TEXT NOT NULL, digest TEXT NOT NULL,
      state TEXT NOT NULL, phase TEXT NOT NULL, owner TEXT NOT NULL,
      parent_id TEXT, remote_id TEXT, remote_database_id TEXT, remote_url TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_open_target ON submission_attempts(target_key)
      WHERE state NOT IN ('submitted', 'superseded');
    CREATE INDEX IF NOT EXISTS idx_submission_review ON submission_attempts(review_id, created_at);
    CREATE TABLE IF NOT EXISTS submission_items (
      attempt_id TEXT NOT NULL REFERENCES submission_attempts(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, local_id INTEGER NOT NULL, local_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'unattempted', remote_id TEXT, remote_database_id TEXT,
      thread_id TEXT, error TEXT, PRIMARY KEY(attempt_id, ordinal)
    );
    CREATE TRIGGER IF NOT EXISTS review_submission_delete_guard BEFORE DELETE ON reviews
    WHEN EXISTS (SELECT 1 FROM submission_attempts WHERE review_id = OLD.id AND state NOT IN ('submitted', 'superseded'))
    BEGIN SELECT RAISE(ABORT, 'Resolve the pending submission before removing local review history'); END;
    CREATE TRIGGER IF NOT EXISTS comment_submission_delete_guard BEFORE DELETE ON comments
    WHEN EXISTS (SELECT 1 FROM submission_items i JOIN submission_attempts a ON a.id = i.attempt_id
      WHERE i.local_id = OLD.id AND a.review_id = OLD.review_id AND a.state NOT IN ('submitted', 'superseded'))
    BEGIN SELECT RAISE(ABORT, 'Resolve the pending submission before deleting its drafts'); END;
    CREATE TRIGGER IF NOT EXISTS comment_submission_tombstone_guard BEFORE UPDATE OF deleted_at ON comments
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM submission_items i JOIN submission_attempts a ON a.id = i.attempt_id
      WHERE i.local_id = OLD.id AND a.review_id = OLD.review_id AND a.state NOT IN ('submitted', 'superseded'))
    BEGIN SELECT RAISE(ABORT, 'Resolve the pending submission before deleting its drafts'); END;
  `);
}

function readAttempt(db, id) {
  const row = db.prepare('SELECT * FROM submission_attempts WHERE id = ?').get(id);
  if (!row) return null;
  const items = db.prepare('SELECT * FROM submission_items WHERE attempt_id = ? ORDER BY ordinal').all(id);
  return { ...row, manifest: JSON.parse(row.manifest), items };
}

function receipt(db, id) {
  const attempt = readAttempt(db, id);
  if (!attempt) return null;
  const observed = active.has(id);
  return {
    id, reviewId: attempt.review_id, state: attempt.state === 'writing' && !observed ? 'outcome_unknown' : attempt.state,
    phase: attempt.phase, observation: attempt.state === 'writing' ? observed ? 'live' : 'not_observed' : 'recorded',
    createdAt: attempt.created_at, updatedAt: attempt.updated_at, error: attempt.error,
    remoteId: attempt.remote_id, remoteDatabaseId: attempt.remote_database_id,
    url: attempt.remote_url || attempt.manifest.target?.url, manifest: attempt.manifest,
    items: attempt.items.map(item => ({ ordinal: item.ordinal, key: item.local_key,
      state: item.state === 'writing' && !observed ? 'unknown' : item.state,
      remoteId: item.remote_id, remoteDatabaseId: item.remote_database_id, threadId: item.thread_id, error: item.error }))
  };
}

function listReceipts(db, reviewId) {
  return db.prepare('SELECT id FROM submission_attempts WHERE review_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(reviewId).map(row => receipt(db, row.id));
}

function openAttempt(db, targetKey, reviewId) {
  const row = db.prepare(`SELECT id FROM submission_attempts WHERE state NOT IN ('submitted', 'superseded')
    AND (target_key = ? OR review_id = ?) ORDER BY created_at LIMIT 1`).get(targetKey, reviewId);
  return row ? readAttempt(db, row.id) : null;
}

function cleanupAttempt(db, reviewId) {
  const row = db.prepare(`SELECT id FROM submission_attempts WHERE review_id = ?
    AND state = 'submitted' AND error IS NOT NULL ORDER BY created_at LIMIT 1`).get(reviewId);
  return row ? readAttempt(db, row.id) : null;
}

function readDrafts(db, reviewId, selection) {
  if (selection?.kind === 'analysis') {
    const rows = db.prepare(`SELECT c.*, a.head_sha AS analysis_head FROM comments c JOIN analysis_runs a ON a.id = c.ai_run_id
      WHERE c.review_id = ? AND c.source = 'ai' AND c.ai_run_id = ? AND a.status = 'completed'
      AND c.ai_level IS NULL AND COALESCE(c.is_raw, 0) = 0 AND c.status IN ('active', 'draft') ORDER BY c.file, c.line_start, c.side, c.id`)
      .all(reviewId, selection.analysisId);
    const selected = new Set(selection.ids);
    return rows.filter(row => selected.has(row.id));
  }
  return db.prepare(`SELECT c.* FROM comments c WHERE c.review_id = ? AND ${USER_DRAFT_CONDITION}
    ORDER BY c.file, c.line_start, c.side, c.id`).all(reviewId);
}

function draftData(row, selection) {
  const body = selection?.kind === 'analysis'
    ? formatAdoptedComment({ body: row.body, category: row.type, title: row.title, severity: row.severity,
      suggestionText: row.suggestion_text }, resolveFormat(selection.commentFormat)) : row.body;
  const fileLevel = row.is_file_level === 1;
  const end = row.line_end || row.line_start;
  const side = row.side || 'RIGHT';
  return { id: row.id, key: row.draft_key || `analysis:${row.ai_run_id}:${row.id}`, revision: row.revision,
    source: row.source, included: selection?.kind === 'analysis' || Boolean(row.included), body,
    originalHead: row.commit_sha || row.analysis_head || null,
    wire: fileLevel ? { path: row.file, body, isFileLevel: true }
      : { path: row.file, body, line: end, side, isFileLevel: false,
        ...(row.line_start !== end ? { start_line: row.line_start, start_side: side } : {}) } };
}

async function anchorIndex(client, target, pr) {
  const key = digest([client.apiHost, client.token, target.owner, target.repo, target.prNumber, pr.base_sha, pr.head_sha]);
  let promise = anchors.get(key);
  if (!promise) {
    promise = (async () => {
      const diff = await client.fetchPullRequestDiff(target.owner, target.repo, target.prNumber);
      const after = await client.fetchPullRequest(target.owner, target.repo, target.prNumber);
      if (after.head_sha !== pr.head_sha || after.base_sha !== pr.base_sha) throw fail('The pull request changed while its anchors were loading. Refresh the preview.');
      const { parseUnifiedDiffPatches } = require('./utils/diff-file-list');
      return { lines: buildDiffLineSet(diff), files: new Set(parseUnifiedDiffPatches(diff).keys()) };
    })();
    anchors.set(key, promise);
    if (anchors.size > 8) anchors.delete(anchors.keys().next().value);
    promise.catch(() => { if (anchors.get(key) === promise) anchors.delete(key); });
  }
  return promise;
}

async function localIdentity(review, pr) {
  if (review.review_type !== 'local') return null;
  const scope = reviewScope(review);
  const git = simpleGit(review.local_path);
  const [head, status, base] = await Promise.all([
    git.revparse(['HEAD']), git.status(), git.raw(['merge-base', review.local_base_branch || pr.base_sha, 'HEAD'])
  ]);
  if (!status.isClean() || head.trim() !== pr.head_sha || scope.start !== 'branch') {
    throw fail('Local publication requires a clean checkout at the PR head and a branch-inclusive review scope. Your local drafts are preserved.');
  }
  const remoteBase = (await git.raw(['merge-base', pr.base_sha, pr.head_sha])).trim();
  if (base.trim() !== remoteBase) throw fail('The local review and PR use different comparison bases. Align the local scope before publishing.');
  return { head: head.trim(), base: remoteBase, scope };
}

// The single selection function for counts, authoring preview and publication.
// No rendered-DOM state, caller-supplied counts, or hidden text transformations.
async function buildSubmissionManifest({ db, reviewId, client, target, config = {}, mode = 'submit', selection = null, body, event, localOnly = false }) {
  if (!['submit', 'draft'].includes(mode)) throw fail('Invalid submission mode', 400);
  let review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
  if (!review) throw fail('Review not found', 404);
  const blockers = [];
  let destination = null;
  let pending = null;
  let index = null;
  let local = null;
  let prior = null;
  if (client && target) {
    const [pr, account, pendingReview] = await Promise.all([
      client.fetchPullRequest(target.owner, target.repo, target.prNumber), client.getAuthenticatedUser(),
      client.getPendingReviewForUser(target.owner, target.repo, target.prNumber)
    ]);
    if (!pr?.head_sha || !account?.login) throw fail('Current head or authenticated account is unavailable', 503);
    if (pr.number !== target.prNumber || pr.repository?.full_name?.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()) throw fail('Host returned a different pull request');
    const host = client.apiHost || null;
    const links = resolveRepoLinks(config, resolveBindingRepositoryForHost(target.owner, target.repo, config, host), host);
    const targetUrl = substituteUrlTemplate(links.external?.url_template, {
      owner: target.owner, repo: target.repo, number: target.prNumber,
      branch: pr.head_branch, base_branch: pr.base_branch, head_sha: pr.head_sha
    }) || pr.html_url;
    destination = { host: host || 'github.com', apiHost: client.apiHost || 'https://api.github.com',
      owner: target.owner, repo: target.repo, number: target.prNumber, repository: `${target.owner}/${target.repo}`,
      nodeId: pr.node_id || null, url: targetUrl, account: { id: account.id ?? null, login: account.login },
      head: pr.head_sha, base: pr.base_sha, author: pr.author, state: pr.state, merged: pr.merged,
      transport: { lifecycle: client.features.review_lifecycle, comments: client.features.pending_review_comments } };
    pending = pendingReview ? { id: String(pendingReview.id), body: pendingReview.body ?? '', url: pendingReview.url, count: pendingReview.comments?.totalCount ?? null } : null;
    const key = targetIdentity(destination);
    prior = openAttempt(db, key, reviewId);
    if (prior && prior.review_id !== reviewId) blockers.push('Another local review owns an unresolved submission to this target. Resolve its receipt first.');
    if (prior && prior.target_key !== key) blockers.push('An unresolved attempt uses a different host or account. Resolve it before changing the publication target.');
    if (pending && pending.id !== prior?.remote_id) blockers.push('A remote pending review contains content not authorized by this preview. Manage it on the host; it will not be submitted or deleted here.');
    if (pr.state !== 'open' || pr.merged) blockers.push('The pull request is closed or merged.');
    if ((client.features.review_lifecycle === 'graphql' || client.features.pending_review_comments === 'graphql') && !pr.node_id) blockers.push('The configured GraphQL transport has no PR node identity.');
    try { local = await localIdentity(review, pr); } catch (error) { blockers.push(error.message); }
    index = await anchorIndex(client, target, pr);
  } else {
    blockers.push(localOnly ? 'Remote preflight has not been run. This local preview does not authorize publication.' : review.review_type === 'local' ? 'Local-only review. Remote publication is not applicable until a PR is explicitly associated.' : 'Host authentication is unavailable. Drafts remain local.');
  }
  // Read after host I/O so edits arriving during enrichment are represented.
  review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
  if (!review) throw fail('Review was removed while the preview loaded', 409);
  const cleanup = cleanupAttempt(db, reviewId);
  if (cleanup) blockers.push('The review was submitted successfully, but its local draft cleanup is incomplete. Finish local cleanup from its receipt before publishing another review.');
  const drafts = readDrafts(db, reviewId, selection).map(row => draftData(row, selection));
  const comments = drafts.filter(comment => comment.included);
  if (selection?.kind === 'analysis' && comments.length !== new Set(selection.ids).size) blockers.push('The selected analysis results changed. Start a new preview.');
  for (const comment of comments) {
    const errors = [];
    const anchor = comment.wire;
    if (typeof comment.body !== 'string' || !comment.body.trim()) errors.push('Comment text is empty.');
    if (index && !index.files.has(anchor.path)) errors.push('This file is not in the current PR diff. Exclude the comment or explicitly move its text into the review body.');
    if (destination && comment.originalHead !== destination.head) errors.push(comment.originalHead ? 'This draft is anchored to an older head. Review its anchor on the current revision.' : 'This draft has no recorded head. Confirm its anchor on the current revision.');
    if (index && !anchor.isFileLevel && (!Number.isInteger(anchor.line) || anchor.line < 1 ||
      !index.lines.isLineInDiff(anchor.path, anchor.line, anchor.side) ||
      anchor.start_line && (!Number.isInteger(anchor.start_line) || anchor.start_line < 1 || anchor.start_line > anchor.line || !index.lines.isLineInDiff(anchor.path, anchor.start_line, anchor.side)))) {
      errors.push('The line or range is outside the current diff. Choose a file-level anchor explicitly, move the text to the review body, or exclude it.');
    }
    comment.errors = errors;
  }
  const decision = event ?? review.draft_event;
  const text = body ?? review.draft_body;
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(decision) || typeof text !== 'string') throw fail('Invalid review decision or body', 400);
  const selfAuthored = Boolean(destination && destination.author?.toLowerCase() === destination.account.login.toLowerCase());
  const allowedEvents = selfAuthored ? ['COMMENT'] : ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
  if (!allowedEvents.includes(decision)) blockers.push('You cannot approve or request changes on your own pull request. Choose a comment-only review.');
  if (decision !== 'APPROVE' && !text.trim() && !comments.length) blockers.push('Add review text or include a comment before publishing.');
  if (comments.some(comment => comment.errors.length)) blockers.push('Resolve the selected comment anchors before publishing. No comments will be silently skipped.');
  if (prior && prior.items.some(item => ['unknown', 'writing'].includes(item.state))) blockers.push('A previous write has an unknown outcome. Reconcile its receipt before attempting another write.');
  if (prior && mode === 'draft' && pending && pending.body !== text) blockers.push('The existing remote draft has a different body. Submit the explicitly previewed replacement body, or edit the draft on the host.');
  const prose = checkReviewProse(config, [{ key: 'summary', body: text }, ...comments.map(({ key, body }) => ({ key, body }))]);
  if (prose.diagnostics.some(item => item.severity === 'blocking')) blockers.push('Resolve the blocking prose diagnostics before publishing. Your text has not been changed.');
  const manifest = { version: 1, database: activity.identity(db).dbId, reviewId, reviewType: review.review_type,
    target: destination, local, mode, event: decision, body: text, bodyRevision: body === undefined ? review.draft_revision : null,
    association: review.associated_pr ? JSON.parse(review.associated_pr) : null,
    selection, pendingReviewId: pending?.id || null, pendingBody: pending?.body ?? text, comments, count: comments.length, prose };
  return { ...manifest, digest: digest(manifest), drafts, pending, blockers, allowedEvents,
    fetchedAt: now(), attempt: cleanup ? receipt(db, cleanup.id) : prior ? receipt(db, prior.id) : null };
}

function targetIdentity(target) {
  return digest([target.apiHost, target.host, target.account.id ?? target.account.login.toLowerCase(), target.repository.toLowerCase(), target.number]);
}

function frozenManifest(manifest) {
  const { drafts, pending, blockers, allowedEvents, fetchedAt, attempt, ...frozen } = manifest;
  return frozen;
}

function assertLocalCurrent(db, manifest) {
  const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(manifest.reviewId);
  if (!review || manifest.bodyRevision !== null && (review.draft_revision !== manifest.bodyRevision || review.draft_body !== manifest.body || review.draft_event !== manifest.event)) throw fail('Review body or decision changed after preview. Confirm a new preview.');
  const selected = readDrafts(db, manifest.reviewId, manifest.selection).map(row => draftData(row, manifest.selection)).filter(comment => comment.included);
  const expected = manifest.comments.map(({ errors, ...comment }) => comment);
  if (digest(selected) !== digest(expected)) throw fail('Selected draft text, inclusion or anchors changed after preview. Confirm a new preview.');
}

function matchesRemote(remote, comment) {
  const wire = comment.wire;
  return remote.body === wire.body && remote.path === wire.path && Boolean(remote.isFileLevel) === wire.isFileLevel &&
    (wire.isFileLevel || remote.line === wire.line && (remote.start_line || null) === (wire.start_line || null) &&
      (!remote.side || remote.side === wire.side) && (!remote.start_side || remote.start_side === (wire.start_side || wire.side)));
}

async function inspectRemote(client, attempt) {
  if (!attempt.remote_id) throw fail('Outcome unknown: the host may have created a review but returned no identifier. Blind retry is blocked.');
  const target = attempt.manifest.target;
  const remote = await client.getReviewById(attempt.remote_id, { owner: target.owner, repo: target.repo, prNumber: target.number, reviewId: attempt.remote_database_id });
  if (!remote) throw fail('The recorded remote review is unavailable. Its absence is not permission to replay an uncertain write.');
  if (remote.author?.toLowerCase() !== target.account.login.toLowerCase() || remote.repository?.toLowerCase() !== target.repository.toLowerCase() || remote.prNumber !== target.number || remote.headSha !== target.head) throw fail('The remote review identity or revision differs from this receipt.');
  const expectedBody = remote.state === 'PENDING' ? attempt.manifest.pendingBody : attempt.manifest.body;
  if (remote.body !== expectedBody) throw fail('The remote review body changed outside this attempt. Inspect it on the host before continuing.');
  const accepted = attempt.items.filter(item => item.state === 'accepted');
  if (accepted.length !== remote.comments.length) throw fail('Remote review comments are missing, additional, or ambiguous. Unseen content will not be submitted.');
  const remaining = new Map(remote.comments.map(comment => [String(comment.id), comment]));
  if (remaining.size !== remote.comments.length) throw fail('The host returned duplicate comment identities.');
  for (const item of accepted) {
    const expected = attempt.manifest.comments[item.ordinal];
    // Only acknowledged host-count results may lack IDs. This comparison is
    // content verification, never deduplication of a lost/unknown mutation.
    const remoteComment = item.remote_id ? remaining.get(item.remote_id)
      : [...remaining.values()].find(comment => matchesRemote(comment, expected));
    if (!remoteComment || !matchesRemote(remoteComment, expected)) throw fail('A remote comment differs from its acknowledged receipt. Inspect it on the host.');
    remaining.delete(String(remoteComment.id));
  }
  return remote;
}

// Acknowledged publication is durable independently of local draft cleanup.
// Replaying its digest or reconciling it may finish cleanup, never write remotely.
function finishSubmittedDrafts(db, attempt) {
  try {
    db.transaction(() => {
      const timestamp = now();
      const update = db.prepare("UPDATE comments SET status = 'submitted', updated_at = ? WHERE id = ? AND review_id = ? AND revision = ? AND body = ? AND deleted_at IS NULL");
      for (const comment of attempt.manifest.comments) {
        const raw = db.prepare('SELECT * FROM comments WHERE id = ? AND review_id = ?').get(comment.id, attempt.review_id);
        if (raw && draftData(raw, attempt.manifest.selection).key === comment.key && draftData(raw, attempt.manifest.selection).body === comment.body) update.run(timestamp, comment.id, attempt.review_id, comment.revision, raw.body);
      }
      db.prepare("UPDATE submission_attempts SET error = NULL WHERE id = ? AND state = 'submitted'").run(attempt.id);
    })();
  } catch (error) {
    db.prepare("UPDATE submission_attempts SET error = ?, updated_at = ? WHERE id = ? AND state = 'submitted'")
      .run(`Review submitted successfully, but local draft cleanup failed: ${error.message}`, now(), attempt.id);
  }
  return receipt(db, attempt.id);
}

function finish(db, attempt, remote, mode) {
  db.transaction(() => {
    const timestamp = now();
    const submitted = mode === 'submit';
    const data = { attempt_id: attempt.id, manifest_digest: attempt.digest, github_node_id: attempt.remote_id,
      github_url: remote.url || attempt.remote_url, event: submitted ? attempt.manifest.event : 'DRAFT',
      body: attempt.manifest.body, comments_count: attempt.manifest.count, submitted_at: submitted ? timestamp : null };
    const settled = db.prepare(`UPDATE submission_attempts SET state = ?, phase = 'settled', error = NULL, remote_url = ?, updated_at = ?
      WHERE id = ? AND owner = ? AND state NOT IN ('submitted', 'superseded')`)
      .run(submitted ? 'submitted' : 'draft_saved', data.github_url, timestamp, attempt.id, attempt.owner);
    if (!settled.changes) return;
    db.prepare('UPDATE reviews SET status = ?, review_data = ?, submitted_at = ?, updated_at = ? WHERE id = ?')
      .run(submitted ? 'submitted' : 'pending', JSON.stringify(data), data.submitted_at, timestamp, attempt.review_id);
    const recorded = db.prepare('SELECT id FROM github_reviews WHERE review_id = ? AND github_node_id = ?').get(attempt.review_id, attempt.remote_id);
    if (recorded) db.prepare('UPDATE github_reviews SET state = ?, event = ?, body = ?, submitted_at = ?, github_url = ? WHERE id = ?')
      .run(submitted ? 'submitted' : 'pending', submitted ? attempt.manifest.event : null, data.body, data.submitted_at, data.github_url, recorded.id);
    else db.prepare('INSERT INTO github_reviews (review_id, github_review_id, github_node_id, state, event, body, submitted_at, github_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(attempt.review_id, attempt.remote_database_id, attempt.remote_id, submitted ? 'submitted' : 'pending', submitted ? attempt.manifest.event : null, data.body, data.submitted_at, data.github_url);
  })();
  if (mode === 'submit') return finishSubmittedDrafts(db, attempt);
  return receipt(db, attempt.id);
}

async function reconcileSubmission({ db, client, attemptId }) {
  const attempt = readAttempt(db, attemptId);
  if (!attempt) throw fail('Submission attempt not found', 404);
  if (active.has(attemptId)) throw fail('This submission is still running. Wait for its recorded result.');
  if (attempt.state === 'submitted') return finishSubmittedDrafts(db, attempt);
  if (terminal.has(attempt.state)) return receipt(db, attemptId);
  try {
    const user = await client.getAuthenticatedUser();
    if (user.login.toLowerCase() !== attempt.manifest.target.account.login.toLowerCase() || (attempt.manifest.target.account.id != null && user.id !== attempt.manifest.target.account.id)) throw fail('The authenticated account differs from this receipt.');
    if (!attempt.remote_id) {
      const target = attempt.manifest.target;
      const pending = await client.getPendingReviewForUser(target.owner, target.repo, target.number);
      if (pending?.url) db.prepare('UPDATE submission_attempts SET remote_url = ? WHERE id = ? AND owner = ? AND state = ? AND phase = ? AND updated_at = ? AND remote_id IS NULL')
        .run(pending.url, attemptId, attempt.owner, attempt.state, attempt.phase, attempt.updated_at);
      throw fail(pending
        ? 'Outcome unknown. A pending review was observed, but ownership by this attempt is unconfirmed. Inspect it on the host; blind retry is blocked.'
        : 'Outcome unknown. No remote review identifier was acknowledged, and absence from a read does not prove creation failed.');
    }
    const remote = await inspectRemote(client, attempt);
    const expectedState = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[attempt.manifest.event];
    if (remote.state === expectedState && attempt.items.every(item => item.state === 'accepted')) return finish(db, attempt, remote, 'submit');
    if (remote.state !== 'PENDING') throw fail(`Remote review state is ${remote.state}; it does not prove this intended submission.`);
    if (attempt.state === 'writing') throw fail('This executor is not observed by this server. Its pending remote review does not prove it stopped; reconciliation will not revoke its write ownership.');
    if (!['ready', 'settled'].includes(attempt.phase) || attempt.items.some(item => ['unknown', 'writing'].includes(item.state))) throw fail('Outcome unknown. A pending review alone does not prove a lost write failed. Blind retry is blocked.');
    db.prepare('UPDATE submission_attempts SET state = ?, error = NULL, updated_at = ? WHERE id = ? AND owner = ? AND state = ? AND phase = ? AND updated_at = ?')
      .run(attempt.manifest.mode === 'draft' && attempt.items.every(item => item.state === 'accepted') ? 'draft_saved' : 'partial',
        now(), attemptId, attempt.owner, attempt.state, attempt.phase, attempt.updated_at);
  } catch (error) {
    db.prepare(`UPDATE submission_attempts SET state = CASE WHEN state = 'writing' THEN state ELSE 'outcome_unknown' END, error = ?, updated_at = ?
      WHERE id = ? AND owner = ? AND state = ? AND phase = ? AND updated_at = ?`)
      .run(error.message, now(), attemptId, attempt.owner, attempt.state, attempt.phase, attempt.updated_at);
  }
  return receipt(db, attemptId);
}

async function publishSubmission(options, confirmedDigest) {
  const { db, client } = options;
  if (typeof confirmedDigest !== 'string' || !confirmedDigest) throw fail('Confirm an exact server preview before publication', 428);
  const completed = () => db.prepare("SELECT id FROM submission_attempts WHERE review_id = ? AND digest = ? AND state IN ('submitted', 'draft_saved') ORDER BY created_at DESC LIMIT 1").get(options.reviewId, confirmedDigest)?.id;
  const recorded = completed();
  if (recorded) {
    const attempt = readAttempt(db, recorded);
    return attempt.state === 'submitted' ? finishSubmittedDrafts(db, attempt) : receipt(db, recorded);
  }
  const manifest = await buildSubmissionManifest(options);
  if (manifest.digest !== confirmedDigest) throw fail('The target, account, head or drafts changed. Review and confirm the new manifest.', 409, { manifest });
  if (manifest.blockers.length) throw fail(manifest.blockers.join(' '), 409, { manifest });
  const targetKey = targetIdentity(manifest.target);
  const prior = openAttempt(db, targetKey, manifest.reviewId);
  let priorRemote;
  if (prior) {
    if (active.has(prior.id) || !['ready', 'settled'].includes(prior.phase) || prior.items.some(item => ['unknown', 'writing'].includes(item.state))) throw fail('Resolve the outstanding submission receipt before writing again.', 409, { receipt: receipt(db, prior.id) });
    priorRemote = await inspectRemote(client, prior);
    if (priorRemote.state !== 'PENDING') throw fail('Reconcile the completed remote review before starting another attempt.');
    for (const item of prior.items.filter(item => item.state === 'accepted')) {
      const old = prior.manifest.comments[item.ordinal];
      const current = manifest.comments.find(comment => comment.key === old.key);
      if (!current || digest(current.wire) !== digest(old.wire)) throw fail('An already accepted remote comment was edited or excluded locally. Manage that remote draft first; no unseen text will be submitted.');
    }
  }
  const id = randomUUID();
  const owner = `${activity.instanceId}:${id}`;
  const replay = db.transaction(() => {
    const recorded = completed();
    if (recorded) return recorded;
    assertLocalCurrent(db, manifest);
    const cleanup = cleanupAttempt(db, manifest.reviewId);
    if (cleanup) throw fail('Finish local cleanup of the submitted review before publishing another review.', 409, { receipt: receipt(db, cleanup.id) });
    const current = openAttempt(db, targetKey, manifest.reviewId);
    if ((current?.id || null) !== (prior?.id || null)) throw fail('Another submission started while this preview was being checked.');
    if (prior) {
      if (current.owner !== prior.owner || current.updated_at !== prior.updated_at) throw fail('The prior submission changed while it was being inspected.');
      db.prepare("UPDATE submission_attempts SET state = 'superseded', updated_at = ? WHERE id = ?").run(now(), prior.id);
    }
    const timestamp = now();
    db.prepare(`INSERT INTO submission_attempts (id, review_id, target_key, manifest, digest, state, phase, owner, parent_id,
      remote_id, remote_database_id, remote_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'writing', 'ready', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, manifest.reviewId, targetKey, JSON.stringify(frozenManifest(manifest)), manifest.digest, owner, prior?.id || null,
        prior?.remote_id || null, prior?.remote_database_id || null, prior?.remote_url || manifest.target.url, timestamp, timestamp);
    const insert = db.prepare('INSERT INTO submission_items (attempt_id, ordinal, local_id, local_key, state, remote_id, remote_database_id, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    manifest.comments.forEach((comment, ordinal) => {
      const accepted = prior?.items.find(item => item.local_key === comment.key && item.state === 'accepted');
      insert.run(id, ordinal, comment.id, comment.key, accepted ? 'accepted' : 'unattempted', accepted?.remote_id || null, accepted?.remote_database_id || null, accepted?.thread_id || null);
    });
    return null;
  })();
  if (replay) {
    const attempt = readAttempt(db, replay);
    return attempt.state === 'submitted' ? finishSubmittedDrafts(db, attempt) : receipt(db, replay);
  }
  active.add(id);
  const target = manifest.target;
  const context = { owner: target.owner, repo: target.repo, prNumber: target.number, headSha: target.head };
  // A 401 on a write must not refresh credentials into another account under
  // the old authorization. This client belongs to this submission operation.
  client.refresh = null;
  const recordPhase = phase => db.transaction(() => {
    assertLocalCurrent(db, manifest);
    const changed = db.prepare("UPDATE submission_attempts SET phase = ?, updated_at = ? WHERE id = ? AND owner = ? AND state = 'writing'").run(phase, now(), id, owner);
    if (!changed.changes) throw fail('Submission ownership changed; this executor will make no further writes.');
  })();
  const checkpoint = async phase => {
    const [head, account] = await Promise.all([client.fetchPullRequest(target.owner, target.repo, target.number), client.getAuthenticatedUser()]);
    if (head.head_sha !== target.head || head.base_sha !== target.base || head.state !== 'open' || head.merged || account.login.toLowerCase() !== target.account.login.toLowerCase() || (target.account.id != null && account.id !== target.account.id)) throw fail('Head, account or PR state changed during submission. Remaining writes were stopped.');
    if (manifest.local) {
      const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(manifest.reviewId);
      if (!review || digest(await localIdentity(review, head)) !== digest(manifest.local)) throw fail('The local checkout or review scope changed. Remaining writes were stopped.');
    }
    recordPhase(phase);
  };
  try {
    if (!prior) {
      await checkpoint('create');
      const created = await lifecycle.addPullRequestReviewWithBody(client.octokit, client.features, target.nodeId, manifest.body, context);
      if (!created?.id) throw fail('Host creation returned no stable review identifier');
      db.prepare("UPDATE submission_attempts SET remote_id = ?, remote_database_id = ?, remote_url = ?, phase = 'ready', updated_at = ? WHERE id = ? AND owner = ?")
        .run(String(created.id), created.databaseId == null ? null : String(created.databaseId), created.url || target.url, now(), id, owner);
    }
    let attempt = readAttempt(db, id);
    context.reviewId = attempt.remote_database_id;
    const queued = attempt.items.filter(item => item.state === 'unattempted');
    for (let offset = 0; offset < queued.length; offset += 10) {
      const batch = queued.slice(offset, offset + 10);
      await checkpoint('comments');
      db.transaction(() => { for (const item of batch) db.prepare("UPDATE submission_items SET state = 'writing' WHERE attempt_id = ? AND ordinal = ?").run(id, item.ordinal); })();
      const result = await pendingComments.addCommentBatch(client.octokit, client.features, target.nodeId, attempt.remote_id,
        batch.map(item => manifest.comments[item.ordinal].wire), context);
      db.transaction(() => {
        for (const item of batch) {
          const outcome = result.receipts.find(value => value.index === batch.indexOf(item));
          db.prepare('UPDATE submission_items SET state = ?, remote_id = ?, remote_database_id = ?, thread_id = ?, error = ? WHERE attempt_id = ? AND ordinal = ?')
            .run(outcome?.state || 'unknown', outcome?.remoteId || null, outcome?.remoteDatabaseId || null, outcome?.threadId || null,
              outcome?.error || (outcome ? null : 'Host returned no receipt'), id, item.ordinal);
        }
        db.prepare("UPDATE submission_attempts SET phase = 'ready', updated_at = ? WHERE id = ? AND owner = ?").run(now(), id, owner);
      })();
      if (result.receipts.length !== batch.length || result.receipts.some(item => item.state !== 'accepted')) throw fail('Only part of the review has an acknowledged result. Drafts and individual receipts are preserved.');
    }
    attempt = readAttempt(db, id);
    await checkpoint('ready');
    // Every existing remote comment must be accounted for before publication.
    // A newly created pending review is not a license to submit later additions
    // made in another tab on the host.
    const remote = await inspectRemote(client, attempt);
    if (remote.state !== 'PENDING') throw fail('The remote review is no longer pending. Reconcile before continuing.');
    if (manifest.mode === 'draft') return finish(db, attempt, remote, 'draft');
    recordPhase('submit');
    const submitted = await lifecycle.submitPullRequestReview(client.octokit, client.features, attempt.remote_id, manifest.event, manifest.body, context);
    const expected = { APPROVE: 'APPROVED', COMMENT: 'COMMENTED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[manifest.event];
    if (submitted?.state !== expected || String(submitted.id) !== attempt.remote_id) throw fail('The host returned an unexpected submission receipt');
    return finish(db, readAttempt(db, id), submitted, 'submit');
  } catch (error) {
    const attempt = readAttempt(db, id);
    if (terminal.has(attempt.state)) return receipt(db, id);
    const unknown = ['create', 'submit'].includes(attempt.phase) || attempt.items.some(item => ['writing', 'unknown'].includes(item.state));
    db.prepare('UPDATE submission_attempts SET state = ?, error = ?, updated_at = ? WHERE id = ? AND owner = ?')
      .run(unknown ? 'outcome_unknown' : 'partial', error.message, now(), id, owner);
    return receipt(db, id);
  } finally { active.delete(id); }
}

async function reanchorDraft(options, { commentId, draft_key, expected_revision, head, as_file = false }) {
  const { db, client, target, reviewId } = options;
  if (!client || !target) throw fail('A current associated PR is required to validate a publication anchor');
  if (!Number.isInteger(expected_revision) || typeof draft_key !== 'string' || typeof as_file !== 'boolean') throw fail('Draft identity, revision and anchor choice are required', 428);
  const pr = await client.fetchPullRequest(target.owner, target.repo, target.prNumber);
  if (!head || pr.head_sha !== head) throw fail('The head changed. Inspect the current revision before choosing this anchor.');
  const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
  await localIdentity(review, pr);
  const index = await anchorIndex(client, target, pr);
  return db.transaction(() => {
    const comment = db.prepare("SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'").get(commentId, reviewId);
    if (!comment || comment.draft_key !== draft_key || comment.revision !== expected_revision || comment.deleted_at || comment.status === 'submitted') throw fail('Draft changed before its anchor was confirmed');
    if (!index.files.has(comment.file)) throw fail('This file is outside the current PR diff');
    const fileLevel = as_file || Boolean(comment.is_file_level);
    if (!fileLevel && (!index.lines.isLineInDiff(comment.file, comment.line_start, comment.side) ||
      !index.lines.isLineInDiff(comment.file, comment.line_end || comment.line_start, comment.side))) throw fail('This line range is outside the current diff');
    db.prepare('UPDATE comments SET commit_sha = ?, is_file_level = ?, line_start = ?, line_end = ?, diff_position = NULL WHERE id = ?')
      .run(head, Number(fileLevel), fileLevel ? null : comment.line_start, fileLevel ? null : comment.line_end, comment.id);
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id);
  })();
}

module.exports = { initializeSubmissionState, buildSubmissionManifest, publishSubmission, reconcileSubmission, reanchorDraft, receipt, listReceipts };
