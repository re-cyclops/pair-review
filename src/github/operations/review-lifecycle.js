// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const graphqlImpl = require('../impl/graphql/review-lifecycle');
const restImpl = require('../impl/rest/review-lifecycle');

/**
 * Dispatcher for the `review_lifecycle` area:
 *   - addPullRequestReviewWithBody (creates a pending review with a body)
 *   - submitPullRequestReview (submits a pending review with an event)
 *
 * Each operation inspects `features.review_lifecycle`:
 *   - `"graphql"` (default for github.com): delegates to the GraphQL impl
 *     in `impl/graphql/review-lifecycle.js`.
 *   - `"rest"`: delegates to `impl/rest/review-lifecycle.js`. The REST
 *     impl requires a `prContext = { owner, repo, prNumber, reviewId? }`
 *     because REST endpoints identify the review by
 *     (owner, repo, pull_number, review_id) rather than by node id.
 *   - `"host"`: not yet implemented — Phase 5 (no current host extension).
 */

const AREA = 'review_lifecycle';
// Modes actually implemented by the dispatcher below. Co-located with the
// dispatch logic so validateRepoConfig() and the dispatcher can't drift.
// `host` is reserved for Phase 5 and is not yet implemented.
const IMPLEMENTED_MODES = new Set(['graphql', 'rest']);

function selectFeature(features) {
  return (features && features[AREA]) || 'graphql';
}

function notYetAvailable(mode) {
  if (mode === 'host') {
    throw new Error('Host implementation for review_lifecycle not yet available (Phase 5)');
  }
  throw new Error(`Unknown features.review_lifecycle value: "${mode}"`);
}

/**
 * Create a pending review with a body.
 *
 * @param {Object} octokit
 * @param {Object} features
 * @param {string} prNodeId
 * @param {string|null} body
 * @param {Object} [prContext] - { owner, repo, prNumber } — REQUIRED for REST mode
 */
async function addPullRequestReviewWithBody(octokit, features, prNodeId, body, prContext) {
  const mode = selectFeature(features);
  if (mode === 'graphql') {
    return graphqlImpl.addPullRequestReviewWithBody(octokit, prNodeId, body, prContext);
  }
  if (mode === 'rest') {
    return restImpl.addPullRequestReviewWithBody(octokit, prNodeId, body, prContext);
  }
  notYetAvailable(mode);
}

/**
 * Submit a pending review.
 *
 * @param {Object} octokit
 * @param {Object} features
 * @param {string|number} reviewId
 * @param {string} event - APPROVE | REQUEST_CHANGES | COMMENT
 * @param {string|null} body
 * @param {Object} [prContext] - { owner, repo, prNumber, reviewId? } — REQUIRED for REST mode
 */
async function submitPullRequestReview(octokit, features, reviewId, event, body, prContext) {
  const mode = selectFeature(features);
  if (mode === 'graphql') {
    return graphqlImpl.submitPullRequestReview(octokit, reviewId, event, body);
  }
  if (mode === 'rest') {
    return restImpl.submitPullRequestReview(octokit, reviewId, event, body, prContext);
  }
  notYetAvailable(mode);
}

module.exports = {
  addPullRequestReviewWithBody,
  submitPullRequestReview,
  AREA,
  IMPLEMENTED_MODES
};
