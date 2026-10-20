// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import express from 'express';
import { createTestDatabase, seedTestReview } from '../utils/schema.js';

const { CommentRepository } = require('../../src/database');
const routes = require('../../src/routes/reviews');
const activity = require('../../src/analysis-activity');

describe('Revisioned review drafts', () => {
  let db;
  let server;
  let base;
  let commentId;

  beforeEach(async () => {
    db = createTestDatabase();
    seedTestReview(db, { id: 1 });
    commentId = await new CommentRepository(db).createLineComment({
      review_id: 1, file: 'sample.js', line_start: 2, body: 'Keep the guard.'
    });
    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.use(routes);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api/reviews/1/comments/${commentId}`;
  });

  afterEach(async () => {
    if (server) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    db?.close();
  });

  it('counts summary-only work but not deleted comments as unfinished reviews', async () => {
    const original = await (await fetch(base)).json();
    await fetch(`${base}/draft`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: original.revision, draft_key: original.draft_key }) });
    expect(activity.snapshot(db).draftCount).toBe(0);
    const endpoint = base.replace(/comments\/\d+$/, 'draft');
    const summary = await (await fetch(endpoint)).json();
    await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '', event: 'APPROVE', expected_revision: summary.revision }) });
    const recent = await (await fetch(new URL('/api/reviews/recent', base))).json();
    expect(recent.reviews[0]).toMatchObject({ draftCount: 0, hasDraftSummary: true });
    expect(activity.snapshot(db).draftCount).toBe(1);
  });

  it('rejects a stale editor while preserving both the current draft and exact technical text', async () => {
    const firstTab = await (await fetch(base)).json();
    const secondTab = await (await fetch(base)).json();
    const savedText = '    await keepGuard();\n\nSee `guard(input)` and https://example.invalid/a--b.\n';
    const save = (draft, body) => fetch(base, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, expected_revision: draft.revision, draft_key: draft.draft_key })
    });
    expect((await save(firstTab, savedText)).status).toBe(200);
    const conflict = await save(secondTab, 'A conflicting edit from the other tab.');
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).current.body).toBe(savedText);
    const persisted = await (await fetch(base)).json();
    expect(persisted.body).toBe(savedText);
    expect(persisted.revision).toBe(firstTab.revision + 1);
  });

  it('reconciles a repeated create by stable identity without accepting different text', async () => {
    const endpoint = base.replace(/\/\d+$/, '');
    const payload = { file: 'sample.js', body: '    keepIndentation();\n', included: false, draft_key: 'retryable-file-draft' };
    const create = body => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const first = await (await create(payload)).json();
    const repeated = await create(payload);
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).commentId).toBe(first.commentId);
    const different = await create({ ...payload, body: 'Different text after a lost acknowledgement' });
    expect(different.status).toBe(409);
    expect((await different.json()).current).toMatchObject({ id: first.commentId, body: payload.body, included: 0 });
    expect(db.prepare('SELECT id, body FROM comments WHERE draft_key = ?').all(payload.draft_key))
      .toEqual([{ id: first.commentId, body: payload.body }]);
  });

  it('does not apply a stale editor to a new comment that reused its integer ID', async () => {
    const original = await (await fetch(base)).json();
    db.prepare('DELETE FROM comments WHERE id = ?').run(original.id);
    const replacement = await new CommentRepository(db).createLineComment({ review_id: 1, file: 'new.js', line_start: 1, body: 'An unrelated draft' });
    expect(replacement).toBe(original.id);
    const response = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Stale text', expected_revision: original.revision, draft_key: original.draft_key }) });
    expect(response.status).toBe(409);
    expect((await (await fetch(base)).json()).body).toBe('An unrelated draft');
  });

  it('preserves exclusion independently of dismissal and restore', async () => {
    const original = await (await fetch(base)).json();
    const excluded = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ included: false, expected_revision: original.revision, draft_key: original.draft_key }) });
    expect(excluded.status).toBe(200);
    expect((await excluded.json()).comment).toMatchObject({ body: original.body, included: 0, status: 'active' });
    expect((await fetch(base, { method: 'DELETE' })).status).toBe(200);
    const restored = await fetch(`${base}/restore`, { method: 'PUT' });
    expect(restored.status).toBe(200);
    expect((await restored.json()).comment).toMatchObject({ body: original.body, included: 0, status: 'active' });
  });

  it('clears a deleted draft and blocks stale saves, creates, and restoration', async () => {
    const original = await (await fetch(base)).json();
    const removed = await fetch(`${base}/draft`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: original.revision, draft_key: original.draft_key }) });
    expect(removed.status).toBe(200);
    const stale = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: original.body, expected_revision: original.revision, draft_key: original.draft_key }) });
    expect(stale.status).toBe(409);
    const retry = await fetch(base.replace(/\/\d+$/, ''), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: original.file, line_start: original.line_start, body: original.body, draft_key: original.draft_key }) });
    expect(retry.status).toBe(409);
    expect((await fetch(`${base}/restore`, { method: 'PUT' })).status).toBe(410);
    expect(db.prepare('SELECT body, included, status FROM comments WHERE id = ?').get(original.id))
      .toEqual({ body: '', included: 0, status: 'inactive' });
    expect((await new CommentRepository(db).getUserComments(1, { includeDismissed: true })).find(comment => comment.id === original.id)).toBeUndefined();
  });

  it('does not replace a newer review decision with another tab’s stale summary', async () => {
    const endpoint = base.replace(/comments\/\d+$/, 'draft');
    const original = await (await fetch(endpoint)).json();
    const save = (body, event) => fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, event, expected_revision: original.revision }) });
    expect((await save('The guard is now correct', 'APPROVE')).status).toBe(200);
    const stale = await save('The original objection', 'REQUEST_CHANGES');
    expect(stale.status).toBe(409);
    expect((await stale.json()).current).toMatchObject({ event: 'APPROVE', body: 'The guard is now correct', revision: original.revision + 1 });
  });
});
