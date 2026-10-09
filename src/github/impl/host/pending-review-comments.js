// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Configured host extension: POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments
 * accepts { comments: [...] } and returns { added, failed: [{ index, error_message }] }.
 * The count contract acknowledges individual successes only when every index
 * is accounted for. It does not provide comment IDs or idempotency. A lost or
 * inconsistent response remains unknown; the publisher must not replay it.
 */

const DEFAULT_ENDPOINT_TEMPLATE =
  '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments';

const REQUIRED_PLACEHOLDERS = ['{owner}', '{repo}', '{pull_number}', '{review_id}'];

// Matches any of the four supported placeholder names. Used globally so
// that templates which repeat a placeholder (e.g. `{repo}` in both the
// path and a query string) get every occurrence substituted, not just
// the first. `validateRepoConfig()` only asserts each required
// placeholder appears *somewhere*, so a chained per-name single
// `String.replace` would leave later occurrences literal in the URL.
const PLACEHOLDER_RE = /\{(owner|repo|pull_number|review_id)\}/g;

/**
 * Substitute placeholders in an endpoint template. URL-encodes each value
 * so that an `owner` like `my org` or a repo containing a slash cannot
 * break the path. The four required placeholders are validated at startup
 * by `validateRepoConfig()`, so missing placeholders here would indicate
 * a bug rather than user error — we still throw a clear error so the
 * failure is loud rather than producing a malformed request path.
 *
 * All occurrences of each placeholder are replaced (global substitution),
 * mirroring the behaviour of `substituteUrlTemplate` in
 * `src/links/repo-links.js`.
 *
 * @param {string} template - Endpoint template with `{...}` placeholders
 * @param {Object} values - { owner, repo, pull_number, review_id }
 * @returns {string} Substituted endpoint path
 */
function substituteEndpoint(template, values) {
  return template.replace(PLACEHOLDER_RE, (_match, name) => {
    const value = values ? values[name] : undefined;
    if (value === undefined || value === null) {
      throw new Error(
        `Host pending_review_comments: endpoint template references {${name}} ` +
        'but no value was provided. This should have been caught by ' +
        'validateRepoConfig — please report this as a bug.'
      );
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * Map an internal comment shape to the host-extension wire shape. The
 * internal shape matches what callers already pass to the GraphQL impl:
 * `{ path, line?, start_line?, side?, body, isFileLevel? }`.
 *
 * - File-level comments (no `line` or explicit `isFileLevel`) are sent
 *   with `subject_type: "file"`.
 * - Line comments default to `side: "RIGHT"` to match GraphQL behaviour.
 * - Range comments include `start_line` and `start_side` (defaulting
 *   `start_side` to the same side as the end line, matching GitHub's
 *   own REST conventions).
 * - `commitId` (the PR head SHA) is added as `commit_id` to every wire
 *   comment when supplied. GitHub-compatible hosts validate comments like
 *   `pulls.createReviewComment` and reject a missing `commit_id` with a
 *   422. When `commitId` is empty/undefined the field is omitted entirely
 *   (we never send `commit_id: undefined`).
 *
 * @param {Object} comment - Internal comment shape.
 * @param {string} [commitId] - PR head SHA. Added as `commit_id` when a
 *   non-empty string; omitted otherwise.
 */
function toWireComment(comment, commitId) {
  const hasCommitId = typeof commitId === 'string' && commitId.length > 0;
  const isFileLevel = comment.isFileLevel || !comment.line;
  if (isFileLevel) {
    const wire = {
      path: comment.path,
      body: comment.body,
      subject_type: 'file'
    };
    if (hasCommitId) wire.commit_id = commitId;
    return wire;
  }
  const side = comment.side || 'RIGHT';
  const wire = {
    path: comment.path,
    body: comment.body,
    side,
    line: comment.line,
    subject_type: 'line'
  };
  if (comment.start_line) {
    wire.start_line = comment.start_line;
    wire.start_side = comment.start_side || side;
  }
  if (hasCommitId) wire.commit_id = commitId;
  return wire;
}

async function addCommentBatch(octokit, features, prContext, reviewId, comments) {
  if (!comments || comments.length === 0) {
    return { receipts: [] };
  }

  if (!prContext || typeof prContext !== 'object') {
    throw new Error(
      'Host pending_review_comments: prContext is required ' +
      '({ owner, repo, prNumber }). The host endpoint is path-shaped, ' +
      'so GraphQL node IDs alone are not sufficient.'
    );
  }
  const { owner, repo, prNumber } = prContext;
  if (!owner || !repo || prNumber === undefined || prNumber === null) {
    throw new Error(
      'Host pending_review_comments: prContext must include owner, repo, and prNumber.'
    );
  }

  // Resolve the *numeric* review id. The host endpoint is REST-shaped:
  // it identifies a review by its numeric database id, not its GraphQL
  // node id. Prefer `prContext.reviewId` (set by the durable publisher
  // from the `databaseId` returned by review creation)
  // and fall back to the positional `reviewId` argument only when it is
  // itself numeric. If only a node id was supplied, fail fast with a
  // clear message so regressions surface immediately rather than as a
  // 404 from the host.
  let resolvedReviewId = null;
  if (prContext && (typeof prContext.reviewId === 'number' || typeof prContext.reviewId === 'string')) {
    const fromCtx = String(prContext.reviewId);
    if (/^\d+$/.test(fromCtx)) {
      resolvedReviewId = fromCtx;
    }
  }
  if (resolvedReviewId === null) {
    if (typeof reviewId === 'number') {
      resolvedReviewId = String(reviewId);
    } else if (typeof reviewId === 'string' && /^\d+$/.test(reviewId)) {
      resolvedReviewId = reviewId;
    } else if (!reviewId && reviewId !== 0) {
      throw new Error('Host pending_review_comments: reviewId is required.');
    } else {
      throw new Error(
        `Host comment batches require a numeric review id; received "${reviewId}". ` +
        'Set prContext.reviewId or ensure review creation returned a numeric databaseId.'
      );
    }
  }

  const template = (features && features.pending_review_comments_endpoint) || DEFAULT_ENDPOINT_TEMPLATE;
  const endpoint = substituteEndpoint(template, {
    owner,
    repo,
    pull_number: prNumber,
    review_id: resolvedReviewId
  });

  // Pin every inline/file comment to the publisher's confirmed revision.
  const commitId = prContext.headSha;
  const wireComments = comments.map((c) => toWireComment(c, commitId));

  let result;
  try {
    result = (await octokit.request(`POST ${endpoint}`, {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      data: { comments: wireComments }
    })).data;
  } catch (error) {
    return { receipts: comments.map((_comment, index) => ({
      index, state: 'unknown', error: error.message || 'Host response unavailable'
    })) };
  }
  const failures = Array.isArray(result?.failed) ? result.failed : [];
  const failed = new Map();
  for (const item of failures) {
    if (item && typeof item === 'object') {
      const error = item.error_message || item.message;
      failed.set(item.index, typeof error === 'string' ? error : 'Rejected by host');
    }
  }
  const complete = Array.isArray(result?.failed) && Number.isInteger(result?.added) && result.added >= 0 &&
    failed.size === failures.length && [...failed.keys()].every(index => Number.isInteger(index) && index >= 0 && index < comments.length) &&
    result.added + failed.size === comments.length;
  return { receipts: comments.map((_comment, index) => ({
    index,
    state: complete ? failed.has(index) ? 'rejected' : 'accepted' : 'unknown',
    remoteId: null,
    error: complete ? failed.get(index) || null : 'The host did not account for every submitted comment'
  })) };
}

module.exports = {
  addCommentBatch,
  DEFAULT_ENDPOINT_TEMPLATE,
  REQUIRED_PLACEHOLDERS,
  // Exported for direct unit testing.
  substituteEndpoint,
  toWireComment
};
