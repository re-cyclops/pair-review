// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Derive an identity for a REST review payload. GraphQL identifies
 * reviews by their `node_id` string; on alt-hosts that don't surface
 * `node_id` we fall back to the numeric `id` stringified, so callers
 * always receive a non-null id when the review was created. Returns
 * null only when neither field is present.
 *
 * @param {Object|null|undefined} data - The REST API review payload
 * @returns {string|null}
 */
function deriveRestReviewId(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.node_id) return data.node_id;
  if (data.id !== undefined && data.id !== null) return String(data.id);
  return null;
}

/**
 * REST implementation of the review-lifecycle area:
 *   - addPullRequestReviewWithBody -> `pulls.createReview({ body })`
 *   - submitPullRequestReview      -> `pulls.submitReview({ event, body })`
 *
 * Each function takes an Octokit-like client as its first parameter and
 * a `prContext = { owner, repo, prNumber }` since REST endpoints
 * identify the review by `(owner, repo, pull_number, review_id)` rather
 * than by a GraphQL node id.
 *
 * Return shapes are normalized for the durable review publisher.
 */

/**
 * Ensure prContext has the fields REST endpoints require. Throws a
 * descriptive error pointing at the dispatcher/client wiring when
 * called without enough context.
 *
 * @param {Object} prContext
 * @param {string} fnName - Function name for the error message
 */
function requirePRContext(prContext, fnName) {
  if (!prContext || !prContext.owner || !prContext.repo || !prContext.prNumber) {
    throw new Error(
      `REST ${fnName} requires prContext={owner, repo, prNumber}. ` +
      'The REST API needs the PR coordinates to identify the review; ' +
      'pass them via the dispatcher / GitHubClient.'
    );
  }
}

/**
 * Create a pending review with the exact body and confirmed head.
 *
 * @param {Object} octokit
 * @param {string} prNodeId
 * @param {string|null} body
 * @param {Object} prContext
 * @returns {Promise<{id: string, databaseId: number|null, url: string}>}
 */
async function addPullRequestReviewWithBody(octokit, prNodeId, body, prContext) {
  requirePRContext(prContext, 'addPullRequestReviewWithBody');

  const { data } = await octokit.rest.pulls.createReview({
    owner: prContext.owner,
    repo: prContext.repo,
    pull_number: prContext.prNumber,
    body: body ?? '',
    commit_id: prContext.headSha
    // No `event` -> PENDING.
  });

  return {
    id: deriveRestReviewId(data),
    databaseId: typeof data.id === 'number' ? data.id : null,
    url: data.html_url
  };
}

/**
 * Submit a pending review. Maps the GraphQL `event` enum values
 * (APPROVE/REQUEST_CHANGES/COMMENT) directly to REST's `event` field,
 * which accepts the same uppercase values.
 *
 * @param {Object} octokit
 * @param {string} reviewId - GraphQL node id OR numeric review id
 * @param {string} event - APPROVE | REQUEST_CHANGES | COMMENT
 * @param {string|null} body
 * @param {Object} prContext - { owner, repo, prNumber, reviewId? } - numeric id required for REST
 * @returns {Promise<{id: string, databaseId: number|null, url: string, state: string}>}
 */
async function submitPullRequestReview(octokit, reviewId, event, body, prContext) {
  requirePRContext(prContext, 'submitPullRequestReview');

  const numericId = resolveNumericReviewId(reviewId, prContext);
  if (numericId === null) {
    throw new Error(
      'REST submitPullRequestReview needs a numeric review id. Pass prContext.reviewId ' +
      'when the reviewId argument is a GraphQL node id.'
    );
  }

  const { data } = await octokit.rest.pulls.submitReview({
    owner: prContext.owner,
    repo: prContext.repo,
    pull_number: prContext.prNumber,
    review_id: numericId,
    event,
    body: body || ''
  });

  return {
    id: deriveRestReviewId(data),
    databaseId: typeof data.id === 'number' ? data.id : null,
    url: data.html_url,
    state: data.state
  };
}

/**
 * Resolve a numeric REST review id from the dispatcher-supplied
 * `reviewId` (which may be either a numeric REST id or a GraphQL node
 * id) plus an optional override on `prContext.reviewId`.
 *
 * @param {string|number} reviewId
 * @param {Object} prContext
 * @returns {number|null}
 */
function resolveNumericReviewId(reviewId, prContext) {
  if (prContext && (typeof prContext.reviewId === 'number' || typeof prContext.reviewId === 'string')) {
    const fromCtx = Number(prContext.reviewId);
    if (Number.isFinite(fromCtx)) return fromCtx;
  }
  if (typeof reviewId === 'number') return reviewId;
  if (typeof reviewId === 'string' && /^\d+$/.test(reviewId)) return Number(reviewId);
  return null;
}

module.exports = {
  addPullRequestReviewWithBody,
  submitPullRequestReview,
  _internals: { resolveNumericReviewId, requirePRContext }
};
