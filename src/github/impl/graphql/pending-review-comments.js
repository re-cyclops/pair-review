// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const { isComplexityError } = require('../../errors');

// Upstream's retry policy: only proof that execution never started permits a
// resend. Every attempted batch still has one durable intent and alias receipts.
const PRE_SEND_NETWORK_CODES = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/;
const AMBIGUOUS_GRAPHQL_MESSAGE = /timeout|timed out|something went wrong/i;

function isSafeToRetry(error) {
  if (!error || error.data !== undefined) return false;
  const status = typeof error.status === 'number' ? error.status : null;
  const neverConnected = () => PRE_SEND_NETWORK_CODES.test(
    [error.code, error.cause && error.cause.code, error.message].filter(Boolean).join(' ')
  );
  if (error.response && status !== null && status >= 500) return false;
  if (!error.response && status !== null) return neverConnected();
  if (isComplexityError(error)) return true;
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return !error.errors.some(item => AMBIGUOUS_GRAPHQL_MESSAGE.test(item?.message || ''));
  }
  if (error.response) return status !== null && status >= 400 && status < 500;
  return neverConnected();
}


/**
 * Build the GraphQL mutation text for a batch of comments. Aliases each
 * inner mutation as `comment0`, `comment1`, ... so partial-failure paths
 * can map errors back to individual comments via `error.path[0]`.
 *
 * @param {Array} batch - Slice of comments to include in this mutation
 * @returns {string} The full mutation text
 */
function buildBatchMutation(batch, { includeCommentMetadata = true } = {}) {
  const threadSelection = includeCommentMetadata
    ? 'thread { id comments(first: 1) { nodes { id fullDatabaseId url } } }'
    : 'thread { id }';
  const commentMutations = batch.map((comment, index) => {
    const isFileLevel = comment.isFileLevel || !comment.line;

    if (isFileLevel) {
      return `
          comment${index}: addPullRequestReviewThread(input: {
            pullRequestId: $prId
            pullRequestReviewId: $reviewId
            path: ${JSON.stringify(comment.path)}
            subjectType: FILE
            body: ${JSON.stringify(comment.body)}
          }) {
            ${threadSelection}
          }
        `;
    }

    const side = comment.side || 'RIGHT';
    // A range sends its start side too: GitHub defaults startSide to RIGHT,
    // which breaks a LEFT-side (deleted lines) range.
    const startLineField = comment.start_line
      ? `startLine: ${comment.start_line}\n            startSide: ${comment.start_side || side}\n            `
      : '';
    return `
          comment${index}: addPullRequestReviewThread(input: {
            pullRequestId: $prId
            pullRequestReviewId: $reviewId
            path: ${JSON.stringify(comment.path)}
            ${startLineField}line: ${comment.line}
            side: ${side}
            body: ${JSON.stringify(comment.body)}
          }) {
            ${threadSelection}
          }
        `;
  }).join('\n');

  return `
      mutation AddReviewComments($prId: ID!, $reviewId: ID!) {
        ${commentMutations}
      }
    `;
}

async function addCommentBatch(octokit, prNodeId, reviewId, comments) {
  if (!comments.length) return { receipts: [] };
  let data;
  let failure;
  let includeCommentMetadata = true;
  let retries = 0;
  while (true) {
    try {
      data = await octokit.graphql(buildBatchMutation(comments, { includeCommentMetadata }), { prId: prNodeId, reviewId });
      failure = null;
      break;
    } catch (error) {
      data = error.data;
      failure = error;
      if (!isSafeToRetry(error)) break;
      const metadataRejected = includeCommentMetadata && error.errors?.length && error.errors.every(item =>
        item.extensions?.code === 'undefinedField' && item.extensions?.fieldName === 'fullDatabaseId' ||
        /(?:Cannot query field ["']fullDatabaseId["']|Field ["']fullDatabaseId["'] doesn.t exist)/i.test(item.message || ''));
      if (metadataRejected) {
        includeCommentMetadata = false;
        continue;
      }
      if (retries++ >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const receipts = comments.map((_comment, index) => {
    const thread = data?.[`comment${index}`]?.thread;
    const remote = thread?.comments?.nodes?.[0];
    const error = failure?.errors?.find(item => item.path?.[0] === `comment${index}`)?.message;
    return {
      index,
      state: thread?.id ? 'accepted' : failure && isSafeToRetry(failure) ? 'rejected' : 'unknown',
      remoteId: remote?.id || null,
      remoteDatabaseId: (remote?.fullDatabaseId ?? remote?.databaseId) == null ? null : String(remote.fullDatabaseId ?? remote.databaseId),
      remoteUrl: remote?.url || null,
      threadId: thread?.id || null,
      error: thread?.id ? null : error || failure?.message || 'The host returned no stable comment receipt'
    };
  });
  return { receipts };
}

module.exports = { addCommentBatch, buildBatchMutation, isSafeToRetry };
