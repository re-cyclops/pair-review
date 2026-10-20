// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
const operations = require('../../../../src/github/operations/pending-review-comments');

describe('Comment transport capability isolation', () => {
  it.each(['rest', 'unknown'])('rejects %s without silently publishing through another transport', async mode => {
    const network = vi.fn();
    await expect(operations.addCommentBatch({ graphql: network, request: network },
      { pending_review_comments: mode }, 'PR_1', 'REVIEW_1',
      [{ path: 'a.js', line: 1, side: 'RIGHT', body: 'Exact text' }],
      { owner: 'owner', repo: 'repo', prNumber: 1, reviewId: 42 }
    )).rejects.toBeInstanceOf(Error);
    expect(network).not.toHaveBeenCalled();
  });
});
