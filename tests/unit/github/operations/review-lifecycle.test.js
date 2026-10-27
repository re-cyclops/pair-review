// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
const operations = require('../../../../src/github/operations/review-lifecycle');
const context = { owner: 'owner', repo: 'repo', prNumber: 1, reviewId: 42, headSha: 'confirmed-head' };

describe.each([
  ['create pending review', (client, features) => operations.addPullRequestReviewWithBody(client, features, 'PR_1', 'Exact body', context)],
  ['submit review', (client, features) => operations.submitPullRequestReview(client, features, 'REVIEW_1', 'COMMENT', 'Exact body', context)]
])('%s capability isolation', (_name, mutate) => {
  it.each(['host', 'unknown'])('rejects %s without silently publishing through another transport', async mode => {
    const network = vi.fn();
    const client = { graphql: network, request: network, rest: { pulls: { createReview: network, submitReview: network } } };
    await expect(mutate(client, { review_lifecycle: mode })).rejects.toBeInstanceOf(Error);
    expect(network).not.toHaveBeenCalled();
  });
});
