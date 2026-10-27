// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * GraphQL implementation of the review-lifecycle area:
 *   - addPullRequestReviewWithBody
 *   - submitPullRequestReview
 *
 * Creation pins the confirmed head explicitly. The shared durable publisher
 * owns orchestration and never deletes a remote review as failure cleanup.
 */

const ADD_REVIEW_WITH_BODY_MUTATION = `
  mutation AddPendingReview($prId: ID!, $body: String, $commitOID: GitObjectID!) {
    addPullRequestReview(input: {
      pullRequestId: $prId
      body: $body
      commitOID: $commitOID
    }) {
      pullRequestReview {
        id
        databaseId
        url
      }
    }
  }
`;

const SUBMIT_REVIEW_MUTATION = `
  mutation SubmitReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
    submitPullRequestReview(input: {
      pullRequestReviewId: $reviewId
      event: $event
      body: $body
    }) {
      pullRequestReview {
        id
        databaseId
        url
        state
      }
    }
  }
`;

/**
 * Create a pending review with a body. Used by the draft-review flow which
 * persists the summary on the pending review itself.
 *
 * @param {Object} octokit
 * @param {string} prNodeId
 * @param {string|null} body
 * @returns {Promise<{id: string, databaseId: number|null, url: string}>}
 */
async function addPullRequestReviewWithBody(octokit, prNodeId, body, prContext) {
  const result = await octokit.graphql(ADD_REVIEW_WITH_BODY_MUTATION, {
    prId: prNodeId,
    body: body ?? '',
    commitOID: prContext.headSha
  });
  const review = result.addPullRequestReview.pullRequestReview;
  return {
    id: review.id,
    databaseId: review.databaseId,
    url: review.url
  };
}

/**
 * Submit a pending review with the chosen event (APPROVE/REQUEST_CHANGES/COMMENT).
 *
 * @param {Object} octokit
 * @param {string} reviewId - GraphQL node ID of the pending review
 * @param {string} event - APPROVE | REQUEST_CHANGES | COMMENT
 * @param {string|null} body
 * @returns {Promise<{id: string, databaseId: number|null, url: string, state: string}>}
 */
async function submitPullRequestReview(octokit, reviewId, event, body) {
  const result = await octokit.graphql(SUBMIT_REVIEW_MUTATION, {
    reviewId,
    event,
    body: body ?? ''
  });
  const review = result.submitPullRequestReview.pullRequestReview;
  return {
    id: review.id,
    databaseId: review.databaseId,
    url: review.url,
    state: review.state
  };
}

module.exports = {
  addPullRequestReviewWithBody,
  submitPullRequestReview
};
