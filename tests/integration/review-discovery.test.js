// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import express from 'express';
import { JSDOM } from 'jsdom';
import { createTestDatabase, seedTestReview } from '../utils/schema.js';
const routes = require('../../src/routes/reviews');
const workspaceSource = readFileSync(new URL('../../public/js/components/Workspace.js', import.meta.url), 'utf8');
const evidenceSource = readFileSync(new URL('../../public/js/components/ReviewEvidence.js', import.meta.url), 'utf8');
let db, server, base, dom, workspace, clock, failOlder, identity, holdNext, recentRequests;
let snapshot, holdSnapshot, snapshotRequests;

beforeEach(async () => {
  db = createTestDatabase();
  for (let id = 1; id <= 6; id++) seedTestReview(db, { id, prNumber: id });
  db.prepare("UPDATE reviews SET updated_at = '2026-10-08 00:00:00'").run();
  failOlder = false;
  identity = { instanceId: 'fixture-instance', dbId: 'fixture-database' };
  holdNext = null;
  recentRequests = 0;
  snapshot = { headSha: 'old-head', availability: 'known' };
  holdSnapshot = null;
  snapshotRequests = 0;
  const app = express();
  app.set('db', db);
  app.get('/api/analyses/activity', (req, res) => res.json({ ...identity, runs: [], observedAt: new Date().toISOString() }));
  app.get('/api/reviews/recent', (req, res, next) => {
    if (failOlder && req.query.before) return res.status(503).json({ error: 'History temporarily unavailable' });
    if (holdNext) {
      const hold = holdNext;
      holdNext = null;
      const send = res.json.bind(res);
      res.json = data => hold(() => send(data));
    }
    next();
  });
  app.get('/api/pr/test/repo/6/snapshot', (req, res) => {
    const value = snapshot;
    if (holdSnapshot) { const hold = holdSnapshot; holdSnapshot = null; hold(() => res.json(value)); }
    else res.json(value);
  });
  app.use(routes);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  dom = new JSDOM('<main></main>', { url: `${base}/pr/test/repo/6?host=github`, runScripts: 'outside-only' });
  const win = dom.window;
  clock = Date.now();
  win.Date.now = () => clock;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.fetch = (input, options) => {
    const url = new URL(input, base);
    if (url.pathname === '/api/reviews/recent') { url.searchParams.set('limit', '2'); recentRequests++; }
    if (url.pathname.endsWith('/snapshot')) snapshotRequests++;
    return fetch(url, options);
  };
  win.eval(evidenceSource);
  win.eval(workspaceSource);
  if (!win.reviewWorkspace) await new Promise(resolve => win.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  workspace = win.reviewWorkspace;
  await workspace.refresh();
});

afterEach(async () => {
  dom?.window.close();
  if (server) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  db?.close();
});

describe('Saved review discovery', () => {
  it('refreshes the loaded range without dropping older search results or retaining deleted reviews', async () => {
    await workspace.loadReviews();
    await workspace.loadReviews(true);
    expect(workspace.reviews.map(review => review.id)).toEqual([6, 5, 4, 3]);
    db.prepare('DELETE FROM reviews WHERE id = 5').run();
    seedTestReview(db, { id: 7, prNumber: 7 });
    db.prepare("UPDATE reviews SET updated_at = '2026-10-09 00:00:00' WHERE id = 7").run();
    db.prepare("UPDATE reviews SET updated_at = '2026-10-10 00:00:00' WHERE id = 3").run();
    clock += 31000;
    await workspace.loadReviews();
    expect(workspace.reviews.map(review => review.id)).toEqual([3, 7, 6, 4, 2, 1]);
    workspace.search.value = '#4';
    workspace.renderCommands();
    expect(workspace.results.textContent).toContain('test/repo #4');
  });

  it('retains the complete previous search and continuation when a refresh fails midway', async () => {
    await workspace.loadReviews();
    await workspace.loadReviews(true);
    const before = workspace.reviews.map(review => review.id);
    const cursor = workspace.nextReviewCursor;
    failOlder = true;
    clock += 31000;
    await workspace.loadReviews();
    expect(workspace.reviews.map(review => review.id)).toEqual(before);
    expect(workspace.nextReviewCursor).toBe(cursor);
    workspace.renderCommands();
    expect(workspace.commandStatus.textContent).toContain('History temporarily unavailable');
  });

  it.each(['instanceId', 'dbId'])('rejects a delayed discovery response from a previous %s', async field => {
    let release;
    const captured = new Promise(resolve => { holdNext = send => {
      let released = false;
      release = () => { if (!released) { released = true; send(); } };
      resolve();
    }; });
    const older = workspace.loadReviews();
    await captured;
    db.prepare('DELETE FROM reviews').run();
    seedTestReview(db, { id: 9, prNumber: 9 });
    identity[field] = 'replacement-context';
    await workspace.refresh();
    const fresh = workspace.loadReviews();
    // Let a broken single-flight implementation finish rather than hang.
    if (recentRequests === 1) release();
    await fresh;
    release();
    await older;
    expect(workspace.reviews.map(review => review.id)).toEqual([9]);
    workspace.search.value = '#6';
    workspace.renderCommands();
    expect(workspace.results.textContent).not.toContain('test/repo #6');
  });

  it('keeps a forced current-head inspector read when an older read arrives later', async () => {
    let release;
    const captured = new Promise(resolve => { holdSnapshot = send => {
      let released = false;
      release = () => { if (!released) { released = true; send(); } };
      resolve();
    }; });
    const older = workspace.loadCurrentEvidence();
    await captured;
    snapshot = { headSha: 'new-head', availability: 'known' };
    const fresh = workspace.loadCurrentEvidence(true);
    await Promise.resolve();
    if (snapshotRequests === 1) release();
    await fresh;
    release();
    await older;
    expect(workspace.currentSnapshot.headSha).toBe('new-head');
    expect(workspace.currentReview.id).toBe(6);
  });
});
