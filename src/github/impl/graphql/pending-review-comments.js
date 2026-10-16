// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

// One mutation per call. The durable publisher records intent before invoking
// this boundary and stores every returned alias receipt before another batch.
// A GraphQL error (including a resolver error with data) is not evidence that
// the other aliases had no effect. Never replay an uncertain mutation.

/**
 * Build the GraphQL mutation text for a batch of comments. Aliases each
 * inner mutation as `comment0`, `comment1`, ... so partial-failure paths
 * can map errors back to individual comments via `error.path[0]`.
 *
 * @param {Array} batch - Slice of comments to include in this mutation
 * @returns {string} The full mutation text
 */
function buildBatchMutation(batch) {
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
            thread { id comments(first: 1) { nodes { id databaseId } } }
          }
        `;
    }

    const side = comment.side || 'RIGHT';
    const startLineField = comment.start_line ? `startLine: ${comment.start_line}\n                startSide: ${comment.start_side || side}\n                ` : '';
    return `
          comment${index}: addPullRequestReviewThread(input: {
            pullRequestId: $prId
            pullRequestReviewId: $reviewId
            path: ${JSON.stringify(comment.path)}
            ${startLineField}line: ${comment.line}
            side: ${side}
            body: ${JSON.stringify(comment.body)}
          }) {
            thread { id comments(first: 1) { nodes { id databaseId } } }
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
  try {
    data = await octokit.graphql(buildBatchMutation(comments), { prId: prNodeId, reviewId });
  } catch (error) {
    data = error.data;
    failure = error;
  }
  const receipts = comments.map((_comment, index) => {
    const thread = data?.[`comment${index}`]?.thread;
    const remote = thread?.comments?.nodes?.[0];
    const error = failure?.errors?.find(item => item.path?.[0] === `comment${index}`)?.message;
    return {
      index,
      state: remote?.id ? 'accepted' : 'unknown',
      remoteId: remote?.id || null,
      remoteDatabaseId: remote?.databaseId == null ? null : String(remote.databaseId),
      threadId: thread?.id || null,
      error: remote?.id ? null : error || failure?.message || 'The host returned no stable comment receipt'
    };
  });
  return { receipts };
}

module.exports = { addCommentBatch, buildBatchMutation };
