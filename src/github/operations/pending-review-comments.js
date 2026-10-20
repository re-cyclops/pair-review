// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const graphqlImpl = require('../impl/graphql/pending-review-comments');
const hostImpl = require('../impl/host/pending-review-comments');

/**
 * Dispatcher for the `pending_review_comments` area.
 *
 * Adds inline comments (line / range / file-level) to an already-pending
 * review. This area is special: GitHub provides no REST equivalent for
 * attaching comments to a pending draft, so the `"rest"` value is
 * explicitly rejected at runtime per the plan. Alt-hosts must declare
 * `"host"` and provide an extension endpoint.
 *
 * Dispatch:
 *   - `"graphql"` (default for github.com): one aliased mutation, returning
 *     stable comment/thread receipts without retrying uncertain writes.
 *   - `"rest"`: rejected with a clear error. GitHub REST cannot reliably
 *     attach comments to a pending draft (see plan Hazards).
 *   - `"host"`: delegates to `impl/host/pending-review-comments.js`,
 *     which posts to the host's extension endpoint. Requires `prContext`
 *     ({ owner, repo, prNumber }) because the host endpoint is
 *     path-shaped — the GraphQL node IDs alone are not sufficient.
 */

const AREA = 'pending_review_comments';
// Modes actually implemented by the dispatcher below. Co-located with the
// dispatch logic so validateRepoConfig() and the dispatcher can't drift.
// REST is intentionally excluded: GitHub REST cannot attach comments to a
// pending draft review.
const IMPLEMENTED_MODES = new Set(['graphql', 'host']);

function selectFeature(features) {
  return (features && features[AREA]) || 'graphql';
}

/**
 * Send one already-recorded batch. The caller owns durable intent/receipts.
 * GraphQL returns stable IDs; count-only host extensions cannot promise them.
 */
async function addCommentBatch(octokit, features, prNodeId, reviewId, comments, prContext) {
  const mode = selectFeature(features);
  if (mode === 'graphql') {
    return graphqlImpl.addCommentBatch(octokit, prNodeId, reviewId, comments);
  }
  if (mode === 'rest') {
    throw new Error(
      'REST implementation for pending_review_comments is not supported: ' +
      'GitHub REST cannot reliably attach comments to a pending draft review. ' +
      'Use "graphql" for github.com or "host" with a host extension for alt-hosts.'
    );
  }
  if (mode === 'host') {
    return hostImpl.addCommentBatch(octokit, features, prContext, reviewId, comments);
  }
  throw new Error(`Unknown features.pending_review_comments value: "${mode}"`);
}

module.exports = {
  addCommentBatch,
  AREA,
  IMPLEMENTED_MODES
};
