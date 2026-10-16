// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const config = require('../../src/config');
const activity = require('../../src/analysis-activity');
const { backgroundQueue } = require('../../src/ai/background-queue');
const { AnalysisRunRepository, ReviewRepository } = require('../../src/database');
const { WorktreePoolLifecycle } = require('../../src/git/worktree-pool-lifecycle');
const { WorktreePoolUsageTracker } = require('../../src/git/worktree-pool-usage');
const { withWorktreeRemoval } = require('../../src/review-removal');
const worktrees = require('../../src/routes/worktrees');
const locals = require('../../src/routes/local');

const draftBody = 'Keep this exact draft — including `literal code`.';

describe('review and checkout removal boundaries', () => {
  let root, checkout, source, db, server, usage, pool;
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Removal fixture', GIT_AUTHOR_EMAIL: 'removal@example.invalid',
      GIT_COMMITTER_NAME: 'Removal fixture', GIT_COMMITTER_EMAIL: 'removal@example.invalid' }
  });
  const row = table => db.prepare(`SELECT * FROM ${table} WHERE id = 1`).get();
  const expectPreserved = () => {
    expect(row('reviews').draft_body).toBe(draftBody);
    expect(row('comments').body).toBe(draftBody);
    expect(fs.readFileSync(path.join(checkout, 'file.js'), 'utf8')).toBe('export const value = 1;\n');
    expect(db.prepare('SELECT path FROM worktrees WHERE id = ?').get('checkout').path).toBe(checkout);
  };
  const seedPool = status => db.prepare(`INSERT INTO worktree_pool
    (id, repository, path, status, current_pr_number, current_review_id, created_at)
    VALUES ('checkout', 'owner/repo', ?, ?, 42, 1, CURRENT_TIMESTAMP)`).run(checkout, status);

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-removal-'));
    source = path.join(root, 'source');
    checkout = path.join(root, 'checkout');
    fs.mkdirSync(source);
    git(source, 'init', '-b', 'main');
    fs.writeFileSync(path.join(source, 'file.js'), 'export const value = 1;\n');
    git(source, 'add', 'file.js');
    git(source, '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
    git(source, 'worktree', 'add', '--detach', checkout, 'HEAD');
    vi.spyOn(config, 'getConfigDir').mockReturnValue(path.join(root, 'config'));
    db = createTestDatabase();
    db.prepare("INSERT INTO pr_metadata (id, pr_number, repository, pr_data) VALUES (1, 42, 'owner/repo', '{}')").run();
    db.prepare("INSERT INTO reviews (id, pr_number, repository, draft_body) VALUES (1, 42, 'owner/repo', ?)").run(draftBody);
    db.prepare("INSERT INTO comments (id, review_id, source, file, line_start, body) VALUES (1, 1, 'user', 'file.js', 1, ?)").run(draftBody);
    db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES ('checkout', 42, 'owner/repo', 'feature', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(checkout);
    usage = new WorktreePoolUsageTracker();
    pool = new WorktreePoolLifecycle(db, {}, { usageTracker: usage });
    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.set('config', {});
    app.set('poolLifecycle', pool);
    app.use(worktrees);
    app.use(locals);
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    activity.setProcessCount('owned-run', 0);
    usage.reset();
    await closeServer(server);
    closeTestDatabase(db);
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['delete', '/api/worktrees/1', null],
    ['delete', '/api/repos/owner/repo/worktrees/checkout', null],
    ['post', '/api/worktrees/bulk-delete', { ids: [1] }],
    ['delete', '/api/repos/owner/repo/worktrees', null],
  ])('preserves an unobserved executor and its drafts during %s %s', async (method, url, body) => {
    db.prepare("INSERT INTO analysis_runs (id, review_id, status) VALUES ('unobserved', 1, 'running')").run();
    let pending = request(server)[method](url);
    if (body) pending = pending.send(body);
    const response = await pending;
    if (url.endsWith('bulk-delete') || url.endsWith('/worktrees')) {
      expect(response.body).toMatchObject({ deleted: 0, failed: 1 });
    } else expect(response.status).toBe(409);
    expectPreserved();
    expect(db.prepare("SELECT status, activity_state FROM analysis_runs WHERE id = 'unobserved'").get())
      .toEqual({ status: 'running', activity_state: null });
  });

  it('waits for child acknowledgement, not a terminal row or cancellation request', async () => {
    const runs = new AnalysisRunRepository(db);
    await runs.create({ id: 'owned-run', reviewId: 1 });
    activity.setProcessCount('owned-run', 1);
    activity.requestCancellation(db, 'owned-run');
    await runs.update('owned-run', { status: 'cancelled' });
    activity.acknowledgeCancellation('owned-run');
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(409);
    expectPreserved();
    activity.setProcessCount('owned-run', 0);
    activity.acknowledgeCancellation('owned-run');
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(200);
    expect(row('reviews')).toBeUndefined();
    expect(row('comments')).toBeUndefined();
    expect(fs.existsSync(checkout)).toBe(false);
  });

  it('protects local history and the source directory until its run terminates', async () => {
    db.prepare("UPDATE reviews SET review_type = 'local', pr_number = NULL, local_path = ? WHERE id = 1").run(checkout);
    db.prepare("INSERT INTO analysis_runs (id, review_id, status) VALUES ('local-run', 1, 'running')").run();
    expect((await request(server).delete('/api/local/sessions/1')).status).toBe(409);
    expectPreserved();
    db.prepare("UPDATE analysis_runs SET status = 'completed' WHERE id = 'local-run'").run();
    expect((await request(server).delete('/api/local/sessions/1')).status).toBe(200);
    expect(row('reviews')).toBeUndefined();
    expect(fs.readFileSync(path.join(checkout, 'file.js'), 'utf8')).toBe('export const value = 1;\n');
  });

  it('protects active chat and unresolved publication without changing their state', async () => {
    db.prepare("INSERT INTO chat_sessions (id, review_id, provider, status) VALUES (1, 1, 'pi', 'active')").run();
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(409);
    expect(row('chat_sessions').status).toBe('active');
    db.prepare("UPDATE chat_sessions SET status = 'closed' WHERE id = 1").run();
    db.prepare(`INSERT INTO submission_attempts (id, review_id, target_key, manifest, digest, state, phase, owner, created_at, updated_at)
      VALUES ('pending', 1, 'target', '{}', 'digest', 'outcome_unknown', 'submitting', 'other-instance', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run();
    expect((await request(server).delete('/api/repos/owner/repo/worktrees/checkout')).status).toBe(409);
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(409);
    expectPreserved();
    expect(db.prepare("SELECT state FROM submission_attempts WHERE id = 'pending'").get().state).toBe('outcome_unknown');
  });

  it('retains cancelled background ownership until its worker settles', async () => {
    let release;
    const job = backgroundQueue.enqueue(1, 'removal-regression', () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    try {
      backgroundQueue.cancel(1, 'removal-regression');
      expect((await request(server).delete('/api/worktrees/1')).status).toBe(409);
      expectPreserved();
    } finally { release(); await job; }
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(200);
    expect(fs.existsSync(checkout)).toBe(false);
  });

  it('refuses wrong-repository deletion and preserves shared checkout contents', async () => {
    expect((await request(server).delete('/api/repos/other/repo/worktrees/checkout')).status).toBe(404);
    expectPreserved();
    db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES ('shared', 42, 'other/repo', 'feature', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(checkout);
    expect((await request(server).delete('/api/repos/owner/repo/worktrees/checkout')).status).toBe(409);
    expect((await request(server).delete('/api/worktrees/1')).body).toMatchObject({ success: true, retainedCheckout: true });
    expect(row('reviews')).toBeUndefined();
    expect(fs.readFileSync(path.join(checkout, 'file.js'), 'utf8')).toBe('export const value = 1;\n');
    expect(db.prepare("SELECT path FROM worktrees WHERE id = 'shared'").get().path).toBe(checkout);
  });

  it('rejects dirty checkout removal without losing local history or registry', async () => {
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'Keep these local bytes.');
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(409);
    expect((await request(server).delete('/api/repos/owner/repo/worktrees/checkout')).status).toBe(500);
    expectPreserved();
    expect(fs.readFileSync(path.join(checkout, 'untracked.txt'), 'utf8')).toBe('Keep these local bytes.');
  });

  it('removes only the idle bulk item and retains the busy one', async () => {
    db.prepare("INSERT INTO pr_metadata (id, pr_number, repository) VALUES (2, 43, 'owner/repo')").run();
    db.prepare("INSERT INTO reviews (id, pr_number, repository) VALUES (2, 43, 'owner/repo')").run();
    db.prepare("INSERT INTO analysis_runs (id, review_id, status) VALUES ('busy', 1, 'running')").run();
    const response = await request(server).post('/api/worktrees/bulk-delete').send({ ids: [1, 2] });
    expect(response.body).toMatchObject({ deleted: 1, failed: 1, errors: [{ id: 1 }] });
    expectPreserved();
    expect(db.prepare('SELECT id FROM reviews WHERE id = 2').get()).toBeUndefined();
  });

  it('blocks new native execution while the checkout removal owns its lock', async () => {
    const record = db.prepare("SELECT * FROM worktrees WHERE id = 'checkout'").get();
    await withWorktreeRemoval(db, record, async () => {
      await expect(new AnalysisRunRepository(db).create({ id: 'raced-start', reviewId: 1 })).rejects.toMatchObject({ statusCode: 409 });
      expect(db.prepare("SELECT id FROM analysis_runs WHERE id = 'raced-start'").get()).toBeUndefined();
    });
    await new AnalysisRunRepository(db).create({ id: 'after-removal-lock', reviewId: 1 });
    expect(db.prepare("SELECT status FROM analysis_runs WHERE id = 'after-removal-lock'").get().status).toBe('running');
  });

  it('serializes removal against another native process using the same database', async () => {
    seedPool('available');
    const databasePath = path.join(root, 'shared.db');
    await db.backup(databasePath);
    const Database = require('better-sqlite3');
    const shared = new Database(databasePath);
    shared.pragma('foreign_keys = ON');
    const attempt = action => JSON.parse(execFileSync(process.execPath, ['-e', `
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const { AnalysisRunRepository, WorktreePoolRepository } = require(${JSON.stringify(require.resolve('../../src/database'))});
      const db = new Database(${JSON.stringify(databasePath)});
      db.pragma('foreign_keys = ON');
      (async () => {
        try {
          if (${JSON.stringify(action)} === 'pool') await new WorktreePoolRepository(db).claimByPR(42, 'owner/repo');
          else await new AnalysisRunRepository(db).create({ id: 'standalone-admission', reviewId: 1 });
          console.log(JSON.stringify({ admitted: true }));
        } catch (error) {
          console.log(JSON.stringify({ admitted: false, statusCode: error.statusCode }));
        } finally { db.close(); }
      })();
    `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: root, USERPROFILE: root } }).trim());
    try {
      const record = shared.prepare("SELECT * FROM worktrees WHERE id = 'checkout'").get();
      await withWorktreeRemoval(shared, record, async () => {
        expect(attempt('analysis')).toEqual({ admitted: false, statusCode: 409 });
        expect(attempt('pool')).toEqual({ admitted: false, statusCode: 409 });
        expect(shared.prepare("SELECT id FROM analysis_runs WHERE id = 'standalone-admission'").get()).toBeUndefined();
        expect(shared.prepare("SELECT status FROM worktree_pool WHERE id = 'checkout'").get().status).toBe('available');
        // Registry removal cannot admit a new review while Git is still settling.
        shared.prepare("DELETE FROM worktrees WHERE id = 'checkout'").run();
        expect(attempt('analysis')).toEqual({ admitted: false, statusCode: 409 });
      });
      expect(attempt('analysis')).toEqual({ admitted: true });
      expect(shared.prepare("SELECT status FROM analysis_runs WHERE id = 'standalone-admission'").get().status).toBe('running');
      expect(fs.readFileSync(path.join(checkout, 'file.js'), 'utf8')).toBe('export const value = 1;\n');
    } finally { shared.close(); }
  });

  it('does not infer acknowledgement from a reservation owner exiting or an old timestamp', async () => {
    const databasePath = path.join(root, 'interrupted.db');
    await db.backup(databasePath);
    execFileSync(process.execPath, ['-e', `
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const { WorktreeLockManager } = require(${JSON.stringify(require.resolve('../../src/git/worktree-lock'))});
      const db = new Database(${JSON.stringify(databasePath)});
      new WorktreeLockManager(db).acquire(${JSON.stringify(checkout)}, 'departed-owner', { repository: 'owner/repo', prNumber: 42 });
      db.prepare("UPDATE worktree_locks SET locked_at = '2000-01-01T00:00:00.000Z'").run();
      db.close();
    `], { timeout: 10000, env: { ...process.env, HOME: root, USERPROFILE: root } });
    const Database = require('better-sqlite3');
    const shared = new Database(databasePath);
    try {
      const record = shared.prepare("SELECT * FROM worktrees WHERE id = 'checkout'").get();
      let removed = false;
      await expect(withWorktreeRemoval(shared, record, async () => { removed = true; }))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(new AnalysisRunRepository(shared).create({ id: 'unconfirmed-start', reviewId: 1 }))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(removed).toBe(false);
      expect(shared.prepare("SELECT draft_body FROM reviews WHERE id = 1").get().draft_body).toBe(draftBody);
      expect(fs.readFileSync(path.join(checkout, 'file.js'), 'utf8')).toBe('export const value = 1;\n');
    } finally { shared.close(); }
  });

  it('keeps the checkout and drafts while its existing-PR refresh claim is outstanding', async () => {
    seedPool('available');
    await pool.poolRepo.claimByPR(42, 'owner/repo');
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(409);
    expect((await request(server).delete('/api/repos/owner/repo/worktrees/checkout')).status).toBe(409);
    expectPreserved();

    await pool.poolRepo.markInUse('checkout', 42);
    expect((await request(server).delete('/api/repos/owner/repo/worktrees/checkout')).status).toBe(200);
    expect(fs.existsSync(checkout)).toBe(false);
    expect(row('reviews').draft_body).toBe(draftBody);
    expect(row('comments').body).toBe(draftBody);
  });

  it('retains an active pool lease, then releases history without destroying the reusable checkout', async () => {
    seedPool('in_use');
    usage.addAnalysis('checkout', 'pool-run');
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(409);
    expect((await request(server).delete('/api/repos/owner/repo/worktrees/checkout')).status).toBe(409);
    expectPreserved();
    expect(usage.getActiveAnalyses('checkout')).toEqual(new Set(['pool-run']));
    usage.removeAnalysis('checkout', 'pool-run');
    expect((await request(server).delete('/api/worktrees/1')).body).toMatchObject({ success: true, retainedCheckout: true });
    expect(db.prepare("SELECT status FROM worktree_pool WHERE id = 'checkout'").get().status).toBe('available');
    expect(fs.existsSync(checkout)).toBe(true);
    expect(row('reviews')).toBeUndefined();
  });

  it('preserves pool metadata on filesystem failure and removes it only after successful Git removal', async () => {
    seedPool('available');
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'Preserved');
    expect((await request(server).delete('/api/repos/owner/repo/worktrees/checkout')).status).toBe(500);
    expect(db.prepare("SELECT status FROM worktree_pool WHERE id = 'checkout'").get().status).toBe('available');
    expectPreserved();
    git(checkout, 'add', 'untracked.txt');
    git(checkout, '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'preserve local file');
    expect((await request(server).delete('/api/repos/owner/repo/worktrees/checkout')).status).toBe(200);
    expect(fs.existsSync(checkout)).toBe(false);
    expect(db.prepare("SELECT id FROM worktree_pool WHERE id = 'checkout'").get()).toBeUndefined();
    expect(row('reviews').draft_body).toBe(draftBody);
  });

  it.each(['creating', 'switching'])('retains a %s pool slot with no checkout registry row', async status => {
    seedPool(status);
    db.prepare("DELETE FROM worktrees WHERE id = 'checkout'").run();
    const response = await request(server).delete('/api/repos/owner/repo/worktrees');
    expect(response.body).toMatchObject({ deleted: 0, failed: 1, errors: [{ id: 'checkout' }] });
    expect(db.prepare("SELECT status FROM worktree_pool WHERE id = 'checkout'").get().status).toBe(status);
    expect(fs.existsSync(checkout)).toBe(true);
  });

  it('does not remove another host’s discovery entry when clearing local history', async () => {
    const insert = db.prepare(`INSERT INTO github_pr_cache (owner, repo, number, collection, host, fetched_at)
      VALUES ('owner', 'repo', 42, 'my-prs', ?, CURRENT_TIMESTAMP)`);
    insert.run(null);
    insert.run('https://other.example.invalid/api');
    expect((await request(server).delete('/api/worktrees/1')).status).toBe(200);
    expect(db.prepare('SELECT host FROM github_pr_cache').all()).toEqual([{ host: 'https://other.example.invalid/api' }]);
  });
});
