// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createTestDatabase } from '../utils/schema.js';
const { createSubmissionHost } = require('../utils/submission-host');
const { CommentRepository } = require('../../src/database');
const routes = require('../../src/routes/reviews');
const activity = require('../../src/analysis-activity');

describe('Manifest-bound native review publication', () => {
  let db, host, server, base, repo, app;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const draft = (body, values = {}) => repo.createLineComment({ review_id: 1, file: 'a.js', line_start: 2, commit_sha: host.state.head, body, ...values });
  const preview = async (mode = 'submit') => {
    const result = await request(`/manifest?mode=${mode}`);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return result.data;
  };
  const publish = manifest => request('/submit', 'POST', { digest: manifest.digest, mode: manifest.mode });

  beforeEach(async () => {
    db = createTestDatabase();
    host = await createSubmissionHost();
    db.prepare("INSERT INTO reviews (id, pr_number, repository, draft_body) VALUES (1, 1, 'owner/repo', 'Review summary')").run();
    db.prepare("INSERT INTO pr_metadata (pr_number, repository, host, pr_data) VALUES (1, 'owner/repo', ?, ?)")
      .run(host.baseUrl, JSON.stringify({ html_url: `${host.baseUrl}/owner/repo/pull/1`, head_sha: host.state.head }));
    repo = new CommentRepository(db);
    app = express();
    app.use(express.json());
    app.set('db', db);
    app.set('config', { repos: { 'owner/repo': { api_host: host.baseUrl, token: 'synthetic-local-fixture', features: {
      pending_review_check: 'graphql', review_lifecycle: 'graphql', pending_review_comments: 'graphql'
    } } } });
    app.use(routes);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api/reviews/1`;
  });

  afterEach(async () => {
    if (server) { const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped; }
    await host?.close();
    if (db?.open) db.close();
  });

  it('keeps the configured host link instead of an upstream API presentation URL', async () => {
    app.get('config').repos['owner/repo'].links = {
      external: { label: 'Review host', url_template: 'https://review-host.example/{owner}/{repo}/pull/{number}' }
    };
    const manifest = await preview();
    expect(manifest.target.url).toBe('https://review-host.example/owner/repo/pull/1');
    expect(manifest.target.apiHost).toBe(host.baseUrl);
    expect(manifest.target.host).toBe(host.baseUrl);
    expect(host.state.calls).toEqual([]);
  });

  it('resolves a persisted local association before checking checkout safety', async () => {
    const associated = { repository: 'owner/repo', number: 1, host: host.baseUrl, url: `${host.baseUrl}/owner/repo/pull/1` };
    db.prepare("UPDATE reviews SET review_type = 'local', repository = 'local/project', local_path = ?, associated_pr = ? WHERE id = 1")
      .run(require('node:path').join(require('node:os').tmpdir(), `missing-checkout-${require('node:crypto').randomUUID()}`), JSON.stringify(associated));
    const manifest = await preview();
    expect(manifest.target).toMatchObject({ repository: 'owner/repo', number: 1, host: host.baseUrl });
    expect(manifest.local).toBeNull();
    expect((await publish(manifest)).status).toBe(409);
    expect(host.state.calls).toEqual([]);
    expect((await request('/draft')).data.body).toBe('Review summary');
  });

  it('publishes the exact ordered stored selection, including a hidden file, range and file comment', async () => {
    const line = await draft('    preserveIndentation();\n', { line_start: 2, line_end: 4, side: 'LEFT' });
    const hidden = await draft('Chat-created finding outside the rendered file', { file: 'hidden.js', line_start: 20 });
    const file = await repo.createFileComment({ review_id: 1, file: 'a.js', body: 'Whole-file invariant', commit_sha: host.state.head });
    const excluded = await draft('Do not publish this draft', { included: false });
    const manifest = await preview();
    expect(manifest.comments.map(comment => comment.id)).toEqual([file, line, hidden]);
    expect(manifest.count).toBe(3);
    const result = await publish(manifest);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    expect(result.data.receipt.state).toBe('submitted');
    const remote = [...host.state.reviews.values()][0];
    expect(remote.body).toBe(manifest.body);
    expect(remote.comments.map(comment => ({ body: comment.body, file: comment.path })))
      .toEqual(manifest.comments.map(comment => ({ body: comment.body, file: comment.wire.path })));
    expect(remote.comments[1]).toMatchObject({ side: 'LEFT', startLine: 2, line: 4 });
    expect(db.prepare('SELECT status, included FROM comments WHERE id = ?').get(excluded)).toEqual({ status: 'active', included: 0 });
  });

  it('checks only selected prose while publishing technical Markdown byte for byte', async () => {
    app.get('config').review_prose = { profile: 'Fixture style', rules: { 'long-dashes': 'advisory', 'terminal-period': 'advisory' } };
    const body = 'This might fail\u2014under cancellation. Could we retain `literal.name.`?\n\n```suggestion\nconst label = \"keep\u2014this.\";\n```\n';
    const id = await draft(body);
    await draft('Excluded\u2014prose.', { included: false });
    const manifest = await preview();
    expect(manifest.prose.diagnostics).toMatchObject([{ key: db.prepare('SELECT draft_key FROM comments WHERE id = ?').get(id).draft_key, rule: 'long-dashes', severity: 'advisory' }]);
    expect(manifest.prose.diagnostics).toHaveLength(1);
    expect((await publish(manifest)).data.receipt.state).toBe('submitted');
    expect([...host.state.reviews.values()][0].comments.map(comment => comment.body)).toEqual([body]);
  });

  it('preserves blocked prose until an explicit saved edit receives a new confirmation', async () => {
    app.get('config').review_prose = { profile: 'Fixture style', rules: { 'terminal-period': 'blocking' } };
    const id = await draft('Keep `literal.name.`.');
    const blocked = await preview();
    expect(blocked.prose.diagnostics).toMatchObject([{ rule: 'terminal-period', severity: 'blocking' }]);
    expect((await publish(blocked)).status).toBe(409);
    expect(host.state.calls).toEqual([]);
    const original = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    expect(original.body).toBe('Keep `literal.name.`.');
    const replacement = 'Could we keep `literal.name.`?';
    await request(`/comments/${id}`, 'PUT', { body: replacement, expected_revision: original.revision, draft_key: original.draft_key });
    expect((await publish(blocked)).status).toBe(409);
    expect(host.state.calls).toEqual([]);
    const accepted = await preview();
    expect(accepted.prose.diagnostics).toEqual([]);
    expect((await publish(accepted)).data.receipt.state).toBe('submitted');
    expect([...host.state.reviews.values()][0].comments[0].body).toBe(replacement);
  });

  it('invalidates the old manifest when the effective outgoing policy changes', async () => {
    await draft('Potential failure\u2014verify the trigger');
    const original = await preview();
    app.set('config', { ...app.get('config'), review_prose: { profile: 'New fixture style', rules: { 'long-dashes': 'advisory' } } });
    const stale = await publish(original);
    expect(stale.status).toBe(409);
    expect(stale.data.manifest.prose).toMatchObject({ profile: 'New fixture style', diagnostics: [{ rule: 'long-dashes' }] });
    expect(host.state.calls).toEqual([]);
    expect((await publish(await preview())).data.receipt.state).toBe('submitted');
  });

  it.each(['body', 'head', 'account'])('invalidates authorization when %s changes after preview', async change => {
    const id = await draft('Original text');
    const manifest = await preview();
    if (change === 'body') {
      const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
      await repo.updateComment(id, { body: 'Newer text', expected_revision: row.revision, draft_key: row.draft_key });
    } else if (change === 'head') host.state.head = 'c'.repeat(40);
    else host.state.viewer = { id: 8, login: 'another-account' };
    const result = await publish(manifest);
    expect(result.status).toBe(409);
    expect(host.state.calls).toEqual([]);
    expect(db.prepare('SELECT status FROM comments WHERE id = ?').get(id).status).toBe('active');
  });

  it('does not silently turn context text into different file-level prose', async () => {
    const id = await draft('Exact contextual text', { line_start: 500 });
    const invalid = await preview();
    expect(invalid.comments[0]).toMatchObject({ id, body: 'Exact contextual text', wire: { line: 500, isFileLevel: false } });
    expect((await publish(invalid)).status).toBe(409);
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    expect((await request(`/comments/${id}/anchor`, 'PUT', { draft_key: row.draft_key, expected_revision: row.revision, head: host.state.head, as_file: true })).status).toBe(200);
    const authorized = await preview();
    expect((await publish(authorized)).status).toBe(200);
    expect([...host.state.reviews.values()][0].comments[0]).toMatchObject({ body: 'Exact contextual text', subjectType: 'FILE', line: null });
  });

  it('persists accepted first-batch IDs and blocks retry after a lost second-batch response', async () => {
    for (let index = 0; index < 11; index++) await draft(`Finding ${index}`, { line_start: index + 1 });
    host.state.loseBatch = 2;
    const first = await publish(await preview());
    expect(first.status).toBe(409);
    const receipt = first.data.receipt;
    expect(receipt.state).toBe('outcome_unknown');
    expect(receipt.items.map(item => item.state)).toEqual([...Array(10).fill('accepted'), 'unknown']);
    expect(receipt.items[0].remoteId).toBe([...host.state.reviews.values()][0].comments[0].id);
    const persisted = await request('/submissions');
    expect(persisted.data.receipts[0].id).toBe(receipt.id);
    expect((await publish(await preview())).status).toBe(409);
    const reconciled = await request(`/submissions/${receipt.id}/reconcile`, 'POST', {});
    expect(reconciled.data.receipt.state).toBe('outcome_unknown');
    expect(host.state.calls.filter(call => call.operation === 'comment').length).toBe(11);
    expect(host.state.calls.filter(call => call.operation === 'submit')).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM comments WHERE status = 'active'").get().count).toBe(11);
  });

  it('retains partial GraphQL alias receipts without retrying the accepted alias', async () => {
    await draft('First'); await draft('Second', { line_start: 3 });
    host.state.partialBatch = 1;
    const result = await publish(await preview());
    expect(result.data.receipt.items.map(item => item.state)).toEqual(['accepted', 'unknown']);
    expect(host.state.calls.filter(call => call.operation === 'comment').map(call => call.comment.body)).toEqual(['First']);
    expect((await publish(await preview())).status).toBe(409);
  });

  it('reconciles a lost final response by stable review and comment IDs without another write', async () => {
    const id = await draft('Preserve the validation guard');
    host.state.loseSubmit = true;
    const result = await publish(await preview());
    expect(result.status).toBe(409);
    expect(result.data.receipt.state).toBe('outcome_unknown');
    const before = host.state.calls.length;
    const reconciled = await request(`/submissions/${result.data.receipt.id}/reconcile`, 'POST', {});
    expect(reconciled.data.receipt.state).toBe('submitted');
    expect(host.state.calls.length).toBe(before);
    expect(db.prepare('SELECT status FROM comments WHERE id = ?').get(id).status).toBe('submitted');
  });

  it('does not touch an unrelated pending review, even when its text resembles a local draft', async () => {
    await draft('Identical legitimate text');
    const foreign = host.createReview('Unseen remote summary', host.state.head);
    host.addComment(foreign, { body: 'Identical legitimate text', path: 'a.js', line: 2, subjectType: 'LINE' });
    const before = host.state.calls.length;
    const result = await publish(await preview());
    expect(result.status).toBe(409);
    expect(host.state.calls.length).toBe(before);
    expect(foreign.state).toBe('PENDING');
    expect(foreign.body).toBe('Unseen remote summary');
  });

  it('requires a fresh confirmation to submit an owned remote draft without adding its comments twice', async () => {
    await draft('One deliberately selected comment');
    const saved = await publish(await preview('draft'));
    expect(saved.data.receipt.state).toBe('draft_saved');
    const original = (await request('/draft')).data;
    await request('/draft', 'PUT', { body: 'An explicit approval body', event: 'APPROVE', expected_revision: original.revision });
    const confirmed = await preview();
    expect(confirmed.pendingReviewId).toBe(saved.data.receipt.remoteId);
    const result = await publish(confirmed);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    expect(result.data.receipt.state).toBe('submitted');
    expect(host.state.calls.map(call => call.operation)).toEqual(['create', 'comment', 'submit']);
    expect([...host.state.reviews.values()][0]).toMatchObject({ body: 'An explicit approval body', state: 'APPROVED' });
    expect((await request('/submissions')).data.receipts.find(item => item.id === saved.data.receipt.id).manifest.body).toBe('Review summary');
  });

  it('clears a previously saved host body when an empty approval is explicitly confirmed', async () => {
    const saved = await publish(await preview('draft'));
    expect(saved.data.receipt.state).toBe('draft_saved');
    const original = (await request('/draft')).data;
    await request('/draft', 'PUT', { body: '', event: 'APPROVE', expected_revision: original.revision });
    const result = await publish(await preview());
    expect(result.data.receipt.state).toBe('submitted');
    expect([...host.state.reviews.values()][0]).toMatchObject({ body: '', state: 'APPROVED' });
    expect(host.state.calls.map(call => call.operation)).toEqual(['create', 'submit']);
  });

  it.each(['COMMENT', 'APPROVE'])('returns the durable receipt instead of replaying a completed %s body-only manifest', async event => {
    const summary = (await request('/draft')).data;
    await request('/draft', 'PUT', { body: '    preserveSummary();\n', event, expected_revision: summary.revision });
    const manifest = await preview();
    expect(activity.snapshot(db).draftCount).toBe(1);
    const first = await publish(manifest);
    const replay = await publish(manifest);
    expect(replay.status).toBe(200);
    expect(replay.data.receipt.id).toBe(first.data.receipt.id);
    expect(host.state.calls.map(call => call.operation)).toEqual(['create', 'submit']);
    expect([...host.state.reviews.values()][0].body).toBe('    preserveSummary();\n');
    expect(activity.snapshot(db).draftCount).toBe(0);
    const recent = await (await fetch(new URL('/api/reviews/recent', base))).json();
    expect(recent.reviews[0]).toMatchObject({ draftCount: 0, hasDraftSummary: false });
    const saved = (await request('/draft')).data;
    await request('/draft', 'PUT', { body: `${saved.body}A new observation`, event, expected_revision: saved.revision });
    expect(activity.snapshot(db).draftCount).toBe(1);
  });

  it('allows only one publisher for concurrent confirmations of a body-only review', async () => {
    const manifest = await preview();
    const results = await Promise.all([publish(manifest), publish(manifest)]);
    expect(results.filter(result => result.data.receipt?.state === 'submitted').length).toBeGreaterThanOrEqual(1);
    expect(host.state.calls.map(call => call.operation)).toEqual(['create', 'submit']);
    expect((await request('/submissions')).data.receipts.map(receipt => receipt.state)).toEqual(['submitted']);
  });

  it('does not submit host content added during the final identity checkpoint', async () => {
    const id = await draft('Only this draft was authorized');
    const manifest = await preview();
    host.state.beforePullRead = () => {
      const remote = [...host.state.reviews.values()][0];
      if (!remote || remote.comments.length !== 1) return;
      host.state.beforePullRead = null;
      host.addComment(remote, { body: 'Unselected host content', path: 'a.js', line: 5, side: 'RIGHT', subjectType: 'LINE' });
    };
    const result = await publish(manifest);
    expect(result.status).toBe(409);
    expect(result.data.receipt.state).toBe('partial');
    const remote = [...host.state.reviews.values()][0];
    expect(remote.state).toBe('PENDING');
    expect(remote.comments.map(comment => comment.body)).toEqual(['Only this draft was authorized', 'Unselected host content']);
    expect(host.state.calls.some(call => call.operation === 'submit')).toBe(false);
    expect(db.prepare('SELECT status, body FROM comments WHERE id = ?').get(id))
      .toEqual({ status: 'active', body: 'Only this draft was authorized' });
  });

  it('keeps a lost creation response unresolved instead of adopting a text-matched pending review', async () => {
    await draft('Exact but not idempotent text');
    host.state.loseCreate = true;
    const result = await publish(await preview());
    expect(result.data.receipt).toMatchObject({ state: 'outcome_unknown', remoteId: null });
    expect((await publish(await preview())).status).toBe(409);
    const reconciled = await request(`/submissions/${result.data.receipt.id}/reconcile`, 'POST', {});
    expect(reconciled.data.receipt.state).toBe('outcome_unknown');
    expect(host.state.calls.map(call => call.operation)).toEqual(['create']);
    expect([...host.state.reviews.values()].map(review => review.state)).toEqual(['PENDING']);
  });

  it('requires an explicit current-head anchor for a legacy unversioned draft', async () => {
    const id = await draft('Legacy exact text', { commit_sha: null });
    expect((await publish(await preview())).status).toBe(409);
    expect(host.state.calls).toEqual([]);
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    await request(`/comments/${id}/anchor`, 'PUT', { draft_key: row.draft_key, expected_revision: row.revision, head: host.state.head, as_file: false });
    const manifest = await preview();
    expect(manifest.comments[0].originalHead).toBe(host.state.head);
    expect((await publish(manifest)).data.receipt.state).toBe('submitted');
    expect([...host.state.reviews.values()][0].comments[0].body).toBe('Legacy exact text');
  });

  it('preserves a draft captured by an unresolved submission when deletion is requested', async () => {
    const id = await draft('Preserve uncertain publication text');
    host.state.loseBatch = 1;
    await publish(await preview());
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    const removed = await request(`/comments/${id}/draft`, 'DELETE', { draft_key: row.draft_key, expected_revision: row.revision });
    expect(removed.status).toBe(409);
    expect(db.prepare('SELECT body, deleted_at FROM comments WHERE id = ?').get(id)).toEqual({ body: row.body, deleted_at: null });
  });
  it.each([
    { lifecycle: 'rest', omitNodeIds: false }, { lifecycle: 'graphql', omitNodeIds: false },
    { lifecycle: 'rest', omitNodeIds: true }
  ])('preserves numeric identity with $lifecycle lifecycle (omitted node IDs: $omitNodeIds)', async ({ lifecycle, omitNodeIds }) => {
    host.state.omitNodeIds = omitNodeIds;
    app.get('config').repos['owner/repo'].features = { pending_review_check: lifecycle, review_lifecycle: lifecycle, pending_review_comments: 'host' };
    await draft('    exactHostRange();\n', { line_start: 2, line_end: 4, side: 'LEFT' });
    await repo.createFileComment({ review_id: 1, file: 'a.js', body: 'File invariant', commit_sha: host.state.head });
    const result = await publish(await preview());
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    const remote = [...host.state.reviews.values()][0];
    expect(result.data.receipt.remoteDatabaseId).toBe(String(remote.databaseId));
    expect(remote).toMatchObject({ state: 'COMMENTED', head: host.state.head, body: 'Review summary' });
    expect(remote.comments).toMatchObject([
      { body: 'File invariant', subjectType: 'FILE', commit_id: host.state.head },
      { body: '    exactHostRange();\n', subjectType: 'LINE', side: 'LEFT', startLine: 2, line: 4, commit_id: host.state.head }
    ]);
    // This host contract acknowledges counts, not per-comment identities.
    // A later content read must not manufacture an acknowledged local-to-remote ID.
    expect(result.data.receipt.items.map(({ state, remoteId }) => ({ state, remoteId })))
      .toEqual([{ state: 'accepted', remoteId: null }, { state: 'accepted', remoteId: null }]);
  });

  it('publishes distinct legitimate drafts with identical technical text and anchors exactly once each', async () => {
    const body = 'Keep `addPullRequestReview(input:` as literal code.\n\n    keepTechnicalNames();\n';
    const first = await draft(body);
    const second = await draft(body);
    const result = await publish(await preview());
    expect(result.data.receipt.state).toBe('submitted');
    const remote = [...host.state.reviews.values()][0];
    expect(remote.comments.map(comment => comment.body)).toEqual([body, body]);
    expect(result.data.receipt.items.map(item => item.key)).toEqual([
      db.prepare('SELECT draft_key FROM comments WHERE id = ?').get(first).draft_key,
      db.prepare('SELECT draft_key FROM comments WHERE id = ?').get(second).draft_key
    ]);
    expect(new Set(result.data.receipt.items.map(item => item.remoteId)).size).toBe(2);
  });

  it('resumes only a known-rejected host batch after a new explicit preview', async () => {
    app.get('config').repos['owner/repo'].features = { pending_review_check: 'rest', review_lifecycle: 'rest', pending_review_comments: 'host' };
    for (let index = 0; index < 11; index++) await draft(`Host finding ${index}`, { line_start: index + 1 });
    host.state.rejectBatch = 2;
    const first = await publish(await preview());
    expect(first.data.receipt).toMatchObject({ state: 'partial', observation: 'recorded' });
    expect(first.data.receipt.items.map(item => item.state)).toEqual([...Array(10).fill('accepted'), 'rejected']);
    const second = await publish(await preview());
    expect(second.status, JSON.stringify(second.data)).toBe(200);
    expect(host.state.calls.filter(call => call.operation === 'create')).toHaveLength(1);
    expect([...host.state.reviews.values()][0].comments.map(comment => comment.body)).toEqual(Array.from({ length: 11 }, (_, index) => `Host finding ${index}`));
    expect((await request('/submissions')).data.receipts.map(receipt => receipt.state).sort()).toEqual(['submitted', 'superseded']);
  });

  it('resumes only unattempted comments after an executor dies between acknowledged batches', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pair-review-publisher-crash-'));
    let child, childClosed, inFlight, release, deadlineTimer;
    try {
      const bodies = Array.from({ length: 11 }, (_, index) => `Durable finding ${index}`);
      for (const [index, body] of bodies.entries()) await draft(body, { line_start: index + 1 });
      const filename = join(home, 'review.db');
      await db.backup(filename);
      db.close();
      db = new (require('better-sqlite3'))(filename);
      db.pragma('foreign_keys = ON');
      app.set('db', db);
      repo = new CommentRepository(db);

      let reachedCheckpoint;
      const checkpoint = new Promise(resolve => { reachedCheckpoint = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      host.state.beforePullRead = () => {
        if (host.state.batches === 1) {
          reachedCheckpoint();
          return held;
        }
      };
      const script = `
        const express = require('express');
        const db = new (require('better-sqlite3'))(process.argv[1]);
        db.pragma('foreign_keys = ON');
        const app = express();
        app.use(express.json());
        app.set('db', db);
        app.set('config', JSON.parse(process.argv[2]));
        app.use(require('./src/routes/reviews'));
        const server = app.listen(0, '127.0.0.1', () => {
          process.send({ base: 'http://127.0.0.1:' + server.address().port + '/api/reviews/1' });
        });
      `;
      child = spawn(process.execPath, ['-e', script, filename, JSON.stringify(app.get('config'))], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      const deadline = new Promise((resolve, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error(`Publisher did not reach its durable checkpoint: ${stderr}`)), 8000);
      });
      const [ready] = await Promise.race([once(child, 'message'), deadline]);
      const manifest = await (await fetch(`${ready.base}/manifest`)).json();
      inFlight = fetch(`${ready.base}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest: manifest.digest, mode: manifest.mode })
      }).catch(() => null);
      await Promise.race([checkpoint, deadline]);
      const original = (await request('/submissions')).data.receipts[0];
      expect(original.items.map(item => item.state)).toEqual([...Array(10).fill('accepted'), 'unattempted']);
      expect(db.prepare('SELECT state, phase FROM submission_attempts WHERE id = ?').get(original.id))
        .toEqual({ state: 'writing', phase: 'ready' });
      child.kill('SIGKILL');
      expect(await childClosed).toEqual({ code: null, signal: 'SIGKILL' });
      await inFlight;
      host.state.beforePullRead = null;
      release();

      const interrupted = (await request('/submissions')).data.receipts[0];
      expect(interrupted).toMatchObject({ state: 'outcome_unknown', observation: 'not_observed' });
      const reconciled = await request(`/submissions/${original.id}/reconcile`, 'POST', {});
      expect(reconciled.data.receipt.state).toBe('outcome_unknown');
      expect(host.state.calls.map(call => call.operation)).toEqual(['create', ...Array(10).fill('comment')]);

      // A fresh explicit confirmation can claim the recorded safe boundary.
      const resumed = await publish(await preview());
      expect(resumed.status, JSON.stringify(resumed.data)).toBe(200);
      expect(resumed.data.receipt.state).toBe('submitted');
      expect(resumed.data.receipt.items.slice(0, 10).map(item => item.remoteId))
        .toEqual(original.items.slice(0, 10).map(item => item.remoteId));
      expect(host.state.calls.filter(call => call.operation === 'create')).toHaveLength(1);
      expect(host.state.calls.filter(call => call.operation === 'submit')).toHaveLength(1);
      expect([...host.state.reviews.values()][0].comments.map(comment => comment.body)).toEqual(bodies);
      expect((await request('/submissions')).data.receipts.map(item => item.state).sort()).toEqual(['submitted', 'superseded']);
    } finally {
      clearTimeout(deadlineTimer);
      host.state.beforePullRead = null;
      release?.();
      if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (childClosed) await childClosed;
      if (inFlight) await inFlight;
      if (db?.open) db.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 12000);

  it('does not revoke an unobserved executor when read-only reconciliation finds a pending review', async () => {
    await draft('Still owned by another executor');
    const saved = await publish(await preview('draft'));
    // Persisted state from another process is not proof that its executor died.
    db.prepare("UPDATE submission_attempts SET state = 'writing', phase = 'comments', owner = 'other-instance' WHERE id = ?").run(saved.data.receipt.id);
    const writes = host.state.calls.length;
    const reconciled = await request(`/submissions/${saved.data.receipt.id}/reconcile`, 'POST', {});
    expect(reconciled.data.receipt).toMatchObject({ state: 'outcome_unknown', observation: 'not_observed' });
    expect(db.prepare('SELECT state, phase, owner FROM submission_attempts WHERE id = ?').get(saved.data.receipt.id))
      .toEqual({ state: 'writing', phase: 'comments', owner: 'other-instance' });
    expect(host.state.calls.length).toBe(writes);
  });
});
