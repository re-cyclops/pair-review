// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../../../utils/logger');
const { GitHubApiError } = require('../../errors');

/**
 * GraphQL implementation of the pending-review-check area.
 *
 * Provides:
 *   - getPendingReviewForUser(owner, repo, prNumber)
 *   - getReviewById(nodeId)
 *
 * Each function takes an Octokit-like client as its first parameter and
 * returns the same shape `GitHubClient` historically returned.
 */

const PENDING_REVIEW_QUERY = `
  query($owner: String!, $repo: String!, $prNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviews(states: PENDING, first: 100, after: $cursor) {
          nodes {
            id
            databaseId
            body
            url
            state
            createdAt
            viewerDidAuthor
            comments {
              totalCount
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const REVIEW_BY_ID_QUERY = `
  query($nodeId: ID!, $cursor: String) {
    node(id: $nodeId) {
      ... on PullRequestReview {
        id databaseId body state submittedAt url viewerDidAuthor
        author { login }
        commit { oid }
        repository { nameWithOwner }
        pullRequest { number }
        comments(first: 100, after: $cursor) {
          nodes { id databaseId body path line startLine subjectType url }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

/**
 * GitHub allows only ONE pending review per user per PR, so this returns
 * either the single pending review or null if none exists.
 *
 * @param {Object} octokit - Octokit instance (must expose .graphql)
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - Pull request number
 * @returns {Promise<Object|null>} The pending review object or null
 */
async function getPendingReviewForUser(octokit, owner, repo, prNumber) {
  try {
    logger.debug(`Checking for pending review on PR #${prNumber} in ${owner}/${repo}`);

    let cursor = null;
    let userPendingReview = null;
    for (let page = 0; page < 100; page++) {
      const result = await octokit.graphql(PENDING_REVIEW_QUERY, { owner, repo, prNumber, cursor });
      const connection = result.repository?.pullRequest?.reviews;
      if (!Array.isArray(connection?.nodes) || !connection.pageInfo) throw new Error('Pending review information is incomplete');
      userPendingReview = connection.nodes.find(review => review?.viewerDidAuthor);
      if (userPendingReview || connection.pageInfo.hasNextPage === false) break;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor || page === 99) throw new Error('Pending review information is truncated');
      cursor = connection.pageInfo.endCursor;
    }

    if (userPendingReview) {
      logger.debug(`Found pending review for user: ${userPendingReview.id} with ${userPendingReview.comments.totalCount} comments`);
      return {
        id: userPendingReview.id,
        databaseId: userPendingReview.databaseId,
        body: userPendingReview.body,
        url: userPendingReview.url,
        state: userPendingReview.state,
        createdAt: userPendingReview.createdAt,
        comments: {
          totalCount: userPendingReview.comments.totalCount
        }
      };
    }

    logger.debug('No pending review found for user');
    return null;
  } catch (error) {
    logger.error(`Error checking for pending review: ${error.message}`);

    if (error.status === 401) {
      throw new GitHubApiError('GitHub authentication failed. Check your token in ~/.pair-review/config.json', 401);
    }

    if (error.status === 404 || error.errors?.some(e => e.type === 'NOT_FOUND')) {
      throw new GitHubApiError(`Pull request #${prNumber} not found in repository ${owner}/${repo}`, 404);
    }

    if (error.errors) {
      const messages = error.errors.map(e => e.message).join(', ');
      throw new Error(`GitHub GraphQL error: ${messages}`);
    }

    throw new Error(`Failed to check for pending review: ${error.message}`);
  }
}

/**
 * Fetch a review by its GraphQL node ID.
 *
 * @param {Object} octokit - Octokit instance (must expose .graphql)
 * @param {string} nodeId - GraphQL node ID for the review
 * @returns {Promise<Object|null>} Review data or null if not found
 */
async function getReviewById(octokit, nodeId) {
  let cursor = null;
  let review = null;
  const comments = [];
  for (let page = 0; page < 100; page++) {
    let result;
    try {
      result = await octokit.graphql(REVIEW_BY_ID_QUERY, { nodeId, cursor });
    } catch (error) {
      if (error.status === 404 || error.errors?.some(item => item.type === 'NOT_FOUND')) return null;
      throw error;
    }
    if (!result.node) return null;
    review = result.node;
    const connection = review.comments;
    if (!Array.isArray(connection?.nodes) || !connection.pageInfo) throw new Error('Remote review comments are unavailable');
    for (const comment of connection.nodes) {
      if (!comment?.id) throw new Error('Remote review contains an unidentified comment');
      comments.push({
        id: comment.id, databaseId: comment.databaseId, body: comment.body, path: comment.path,
        line: comment.line, start_line: comment.startLine, isFileLevel: comment.subjectType === 'FILE', url: comment.url
      });
    }
    if (connection.pageInfo.hasNextPage === false) {
      return { id: review.id, databaseId: review.databaseId, body: review.body,
        state: review.state, submittedAt: review.submittedAt, url: review.url,
        headSha: review.commit?.oid, author: review.author?.login,
        viewerDidAuthor: review.viewerDidAuthor, repository: review.repository?.nameWithOwner,
        prNumber: review.pullRequest?.number, comments };
    }
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) break;
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error('Remote review comments are truncated; publication is blocked');
}

module.exports = {
  getPendingReviewForUser,
  getReviewById
};
