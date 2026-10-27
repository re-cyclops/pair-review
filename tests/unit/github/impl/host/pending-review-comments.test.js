// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
const { addCommentBatch } = require('../../../../../src/github/impl/host/pending-review-comments');
const context = { owner: 'owner', repo: 'repo', prNumber: 1, headSha: 'confirmed-head' };
const comments = [
  { path: 'a.js', line: 2, side: 'LEFT', start_line: 1, start_side: 'LEFT', body: '    keepIndentation();\n' },
  { path: 'README.md', isFileLevel: true, body: 'Keep `technical_value` unchanged.' }
];

describe('Host comment acknowledgment boundaries', () => {
  it('associates an explicitly rejected index with its original comment without inventing remote IDs', async () => {
    const octokit = { request: vi.fn(async () => ({ data: { added: 1, failed: [{ index: 0, error_message: 'Invalid anchor' }] } })) };
    const result = await addCommentBatch(octokit, {}, context, 42, comments);
    expect(result.receipts).toEqual([
      { index: 0, state: 'rejected', remoteId: null, error: 'Invalid anchor' },
      { index: 1, state: 'accepted', remoteId: null, error: null }
    ]);
  });

  it.each([
    ['missing counter', { failed: [] }],
    ['incomplete count', { added: 1, failed: [] }],
    ['explicit zero without rejection identities', { added: 0, failed: [] }],
    ['duplicate failed index', { added: 0, failed: [{ index: 1 }, { index: 1 }] }],
    ['out-of-range failed index', { added: 1, failed: [{ index: 2 }] }],
    ['non-array failures', { added: 2, failed: 'invalid' }],
    ['unidentified failure', { added: 1, failed: [null] }]
  ])('keeps every outcome unknown after %s', async (_name, data) => {
    const octokit = { request: vi.fn(async () => ({ data })) };
    const result = await addCommentBatch(octokit, {}, context, 42, comments);
    expect(result.receipts.map(({ index, state, remoteId }) => ({ index, state, remoteId }))).toEqual([
      { index: 0, state: 'unknown', remoteId: null }, { index: 1, state: 'unknown', remoteId: null }
    ]);
    expect(octokit.request).toHaveBeenCalledTimes(1);
  });

  it('does not replay an acknowledged-side-effect request when its response is lost', async () => {
    const remote = [];
    const octokit = { request: vi.fn(async (_endpoint, options) => {
      remote.push(...options.data.comments);
      throw new Error('Response lost after write');
    }) };
    const result = await addCommentBatch(octokit, {}, context, 42, comments);
    expect(remote).toEqual([
      { path: 'a.js', body: comments[0].body, side: 'LEFT', line: 2, start_line: 1, start_side: 'LEFT', subject_type: 'line', commit_id: 'confirmed-head' },
      { path: 'README.md', body: comments[1].body, subject_type: 'file', commit_id: 'confirmed-head' }
    ]);
    expect(result.receipts.map(item => item.state)).toEqual(['unknown', 'unknown']);
    expect(octokit.request).toHaveBeenCalledTimes(1);
  });

  it('uses the numeric review ID and encodes every configured endpoint occurrence', async () => {
    const octokit = { request: vi.fn(async () => ({ data: { added: 2, failed: [] } })) };
    const result = await addCommentBatch(octokit, {
      pending_review_comments_endpoint: '/custom/{owner}/{repo}/{pull_number}/{review_id}?repo={repo}&owner={owner}'
    }, { ...context, owner: 'space org', repo: 'widget/sub', reviewId: 42 }, 'PRR_node', comments);
    expect(octokit.request.mock.calls[0][0]).toBe('POST /custom/space%20org/widget%2Fsub/1/42?repo=widget%2Fsub&owner=space%20org');
    expect(result.receipts.map(item => item.state)).toEqual(['accepted', 'accepted']);
  });

  it('refuses a node-only review identity before sending a host mutation', async () => {
    const octokit = { request: vi.fn() };
    await expect(addCommentBatch(octokit, {}, context, 'PRR_node', comments)).rejects.toBeInstanceOf(Error);
    expect(octokit.request).not.toHaveBeenCalled();
  });
});
