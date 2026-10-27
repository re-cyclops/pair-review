// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
const comments = require('../../../../../src/github/impl/graphql/pending-review-comments');

describe('Pending comment write receipts', () => {
  it('does not replay a mutation after one alias was accepted and the response failed', async () => {
    const remote = [];
    const octokit = { graphql: async () => {
      remote.push('first');
      throw Object.assign(new Error('Response interrupted'), {
        data: { comment0: { thread: { id: 'thread-1', comments: { nodes: [{ id: 'comment-1', databaseId: 1 }] } } } },
        errors: [{ path: ['comment1'], message: 'Resolver did not return a receipt' }]
      });
    } };
    const result = await comments.addCommentBatch(octokit, 'pr', 'review', [
      { path: 'a.js', line: 1, body: 'First comment' }, { path: 'a.js', line: 2, body: 'Second comment' }
    ]);
    expect(remote).toEqual(['first']);
    expect(result.receipts).toEqual([
      expect.objectContaining({ index: 0, state: 'accepted', remoteId: 'comment-1', threadId: 'thread-1' }),
      expect.objectContaining({ index: 1, state: 'unknown' })
    ]);
  });
});
