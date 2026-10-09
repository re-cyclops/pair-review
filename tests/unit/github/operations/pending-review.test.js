// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
const operations = require('../../../../src/github/operations/pending-review');
const context = { owner: 'owner', repo: 'repo', prNumber: 1, reviewId: 42 };

describe.each([
  ['pending lookup', (client, features) => operations.getPendingReviewForUser(client, features, 'owner', 'repo', 1)],
  ['receipt lookup', (client, features) => operations.getReviewById(client, features, 'REVIEW_1', context)]
])('%s capability isolation', (_name, lookup) => {
  it.each(['host', 'unknown'])('rejects %s without contacting another transport', async mode => {
    const network = vi.fn();
    const client = { graphql: network, request: network, paginate: network,
      rest: { users: { getAuthenticated: network }, pulls: { getReview: network, listReviews: network, listCommentsForReview: network } } };
    await expect(lookup(client, { pending_review_check: mode })).rejects.toBeInstanceOf(Error);
    expect(network).not.toHaveBeenCalled();
  });
});
