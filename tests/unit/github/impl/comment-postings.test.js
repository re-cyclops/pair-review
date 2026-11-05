// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const graphql = require('../../../../src/github/impl/graphql/pending-review-comments');
const host = require('../../../../src/github/impl/host/pending-review-comments');
const comments = Array.from({ length: 3 }, (_, i) => ({ path: `${i}.js`, line: i + 1, body: `note ${i}` }));
const ctx = { owner: 'test', repo: 'repo', prNumber: 1 };
const thread = id => ({ thread: { id: `thread-${id}`, comments: { nodes: [{
  id: `node-${id}`, fullDatabaseId: id, url: `https://github.com/comment/${id}`
}] } } });
const acceptedIndexes = result => result.receipts.filter(receipt => receipt.state === 'accepted').map(receipt => receipt.index);

describe('per-comment transport receipts', () => {
  it('keeps stable indexes and lossless database IDs when comment metadata is optional', async () => {
    const octokit = { graphql: vi.fn().mockResolvedValue({
      comment0: thread('9007199254740993'), comment1: { thread: { id: 't' } }, comment2: thread(12)
    }) };
    const result = await graphql.addCommentBatch(octokit, 'pr', 'review', comments);
    expect(result.receipts).toMatchObject([
      { index: 0, state: 'accepted', remoteDatabaseId: '9007199254740993', remoteId: 'node-9007199254740993', remoteUrl: 'https://github.com/comment/9007199254740993' },
      { index: 1, state: 'accepted', remoteDatabaseId: null, remoteId: null },
      { index: 2, state: 'accepted', remoteDatabaseId: '12', remoteId: 'node-12' }
    ]);
  });

  it('falls back only after fullDatabaseId schema validation proves no mutation executed', async () => {
    const octokit = { graphql: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('schema validation'), { errors: [{
        message: "Field 'fullDatabaseId' doesn't exist on type 'PullRequestReviewComment'",
        extensions: { code: 'undefinedField', fieldName: 'fullDatabaseId' }
      }] }))
      .mockResolvedValueOnce({ comment0: { thread: { id: 't0' } }, comment1: { thread: { id: 't1' } }, comment2: { thread: { id: 't2' } } }) };
    expect(acceptedIndexes(await graphql.addCommentBatch(octokit, 'pr', 'review', comments))).toEqual([0, 1, 2]);
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    expect(octokit.graphql.mock.calls[1][0]).not.toContain('comments(first:');
  });

  it('does not metadata-fallback replay a response containing partial successes', async () => {
    const octokit = { graphql: vi.fn().mockRejectedValue(Object.assign(new Error('partial'), {
      data: { comment0: thread(1) }, errors: [{ message: "Cannot query field 'fullDatabaseId' on type 'PullRequestReviewComment'" }]
    })) };
    const result = await graphql.addCommentBatch(octokit, 'pr', 'review', comments);
    expect(acceptedIndexes(result)).toEqual([0]);
    expect(result.receipts.slice(1).map(receipt => receipt.state)).toEqual(['unknown', 'unknown']);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it('accepts stable thread receipts even when an error envelope accompanies every success', async () => {
    const octokit = { graphql: vi.fn().mockRejectedValue(Object.assign(new Error('other error'), {
      data: { comment0: thread(0) }, errors: [{ message: 'other error' }]
    })) };
    expect(acceptedIndexes(await graphql.addCommentBatch(octokit, 'pr', 'review', comments.slice(0, 1)))).toEqual([0]);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it('distinguishes singular host rejection from acknowledged surrounding comments', async () => {
    const octokit = { request: vi.fn()
      .mockResolvedValueOnce({ data: { id: 10, node_id: 'node', html_url: 'https://host/comment/10' } })
      .mockRejectedValueOnce(Object.assign(new Error('invalid'), { status: 422 }))
      .mockResolvedValueOnce({ data: {} }) };
    const result = await host.addCommentBatch(octokit, { pending_review_comments_batch: false }, ctx, 1, comments);
    expect(result.receipts).toMatchObject([
      { index: 0, state: 'accepted', remoteDatabaseId: '10', remoteId: 'node', remoteUrl: 'https://host/comment/10' },
      { index: 1, state: 'rejected' }, { index: 2, state: 'accepted' }
    ]);
  });

  it('does not send later singular writes after an ambiguous outcome', async () => {
    const octokit = { request: vi.fn().mockRejectedValue(new Error('Connection lost after writing')) };
    const result = await host.addCommentBatch(octokit, { pending_review_comments_batch: false }, ctx, 1, comments);
    expect(result.receipts.map(receipt => receipt.state)).toEqual(['unknown', 'unattempted', 'unattempted']);
    expect(octokit.request).toHaveBeenCalledTimes(1);
  });

  it('derives successful host indexes only from complete consistent accounting', async () => {
    const result = await host.addCommentBatch({ request: vi.fn().mockResolvedValue({ data: { added: 2, failed: [{ index: 1 }] } }) }, {}, ctx, 1, comments);
    expect(result.receipts.map(receipt => receipt.state)).toEqual(['accepted', 'rejected', 'accepted']);
  });

  it.each([
    { added: 0, failed: [] }, { added: 1, failed: [] }, { failed: [] },
    { added: 2, failed: [{}] }, { added: 1, failed: [{ index: 0 }, { index: 0 }] },
    { added: 2, failed: [{ index: 4 }] }, { added: 2, failed: [{ index: 0.5 }] },
    { added: 2, failed: [null] }, { added: -1, failed: [] }
  ])('keeps ambiguous host accounting unresolved: %j', async data => {
    const result = await host.addCommentBatch({ request: vi.fn().mockResolvedValue({ data }) }, {}, ctx, 1, comments);
    expect(result.receipts.map(receipt => receipt.state)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('acknowledges every index on explicit full host success', async () => {
    const result = await host.addCommentBatch({ request: vi.fn().mockResolvedValue({ data: { added: 3, failed: [] } }) }, {}, ctx, 1, comments);
    expect(acceptedIndexes(result)).toEqual([0, 1, 2]);
  });

  it('does not infer host success from a lost response', async () => {
    const result = await host.addCommentBatch({ request: vi.fn().mockRejectedValue(new Error('connection lost')) }, {}, ctx, 1, comments);
    expect(result.receipts.map(receipt => receipt.state)).toEqual(['unknown', 'unknown', 'unknown']);
  });
});
