// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

// Only external GitHub/provider boundaries are fixtures. Checkout, diff, storage,
// prompts, analysis orchestration and HTTP handlers below are the real owners.
let configDir;
let remote;
let db;
let omitRechecks;
let failProvider;
let holdProvider = null;
let providerStarted = null;
const prompts = [];
const configModule = require('../../src/config');
vi.spyOn(configModule, 'getConfigDir').mockImplementation(() => configDir);
const ai = require('../../src/ai');
vi.spyOn(ai, 'createProvider').mockImplementation(() => ({
  execute: async (prompt) => {
    prompts.push(prompt);
    providerStarted?.();
    if (holdProvider) await holdProvider;
    if (failProvider) throw new Error('Fixture provider unavailable');
    const feedback = db.prepare("SELECT id FROM comments WHERE commit_sha IS NULL OR commit_sha != ?").all(remote.head_sha);
    return { suggestions: [], summary: 'No new findings; explicitly reassessed saved feedback.',
      ...(!omitRechecks ? { revisionRechecks: feedback.map(({ id }) => ({ id, relevance: 'changed',
        reason: 'Current file.js now uses the revised value; the old proposed wording needs updating.',
        next_action: 'Review the revised behavior and choose the current range before including this draft.',
        suggested_body: 'Suggested current wording, not an authored edit.',
        location: { file: 'file.js', line_start: 2, line_end: 2, side: 'RIGHT' } })) } : {}) };
  }
}));
const { GitHubClient } = require('../../src/github/client');
vi.spyOn(GitHubClient.prototype, 'repositoryExists').mockResolvedValue(true);
vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockImplementation(async () => ({ ...remote }));
vi.spyOn(GitHubClient.prototype, 'fetchPullRequestFiles').mockResolvedValue([{ filename: 'file.js' }]);
vi.spyOn(GitHubClient.prototype, 'getPendingReviewForUser').mockResolvedValue(null);
vi.spyOn(GitHubClient.prototype, 'getAuthenticatedUser').mockResolvedValue({ id: 123, login: 'reviewer' });
const { GitWorktreeManager } = require('../../src/git/worktree');
const { WorktreeLockManager } = require('../../src/git/worktree-lock');
const { setupPRReview, refreshPRReview } = require('../../src/setup/pr-setup');
const { AnalysisRunRepository, CommentRepository, PRMetadataRepository } = require('../../src/database');
const summaryGenerator = require('../../src/ai/summary-generator');
const tourGenerator = require('../../src/ai/tour-generator');
vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockResolvedValue(null);
vi.spyOn(tourGenerator, 'kickOffTourJob').mockResolvedValue(null);
const prRoutes = require('../../src/routes/pr');
const setupRoutes = require('../../src/routes/setup');
const reviewRoutes = require('../../src/routes/reviews');
const { activeAnalyses, activeSetups, reviewToAnalysisId } = require('../../src/routes/shared');
const { buildSubmissionManifest } = require('../../src/review-submission');

let root;
let source;
let git;
let config;
let app;
let reviewId;
let oldHead;
let worktree;

async function advance(value = 3) {
  await git.checkout('feature');
  await fs.writeFile(path.join(source, 'file.js'), `const stable = true;\nconst value = ${value};\n`);
  await git.add('.');
  await git.commit('new revision');
  remote = { ...remote, head_sha: (await git.revparse(['HEAD'])).trim(), title: 'Latest PR title' };
  await git.raw(['update-ref', 'refs/pull/1/head', remote.head_sha]);
  await git.checkout('main');
}

async function analyze(body = {}, endpoint = 'analyses') {
  const response = await request(app).post(`/api/pr/owner/repo/1/${endpoint}`).send(body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const id = response.body.runId;
  for (let i = 0; i < 1000 && activeAnalyses.get(id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(activeAnalyses.get(id)?.status).toBe(failProvider ? 'failed' : 'completed');
  expect(JSON.parse((await new AnalysisRunRepository(db).getById(id)).protocol_snapshot).comparison).toEqual({ baseSha: remote.base_sha, headSha: remote.head_sha });
  return id;
}

async function seedHistory() {
  await new AnalysisRunRepository(db).create({ id: 'old-run', reviewId, provider: 'claude', model: 'opus', headSha: oldHead, status: 'completed', diff: 'historical snapshot' });
  await new CommentRepository(db).bulkInsertAISuggestions(reviewId, 'old-run', [{ file: 'file.js', line_start: 2, line_end: 2,
    type: 'bug', title: 'Old finding', description: 'Review the old value.', confidence: 0.9 }], null);
  const response = await request(app).post(`/api/reviews/${reviewId}/comments`).send({ file: 'file.js', line_start: 2, line_end: 2,
    side: 'RIGHT', commit_sha: oldHead, body: 'My carefully edited pending comment.' });
  expect(response.status).toBe(200);
  db.prepare('UPDATE reviews SET summary = ?, draft_body = ? WHERE id = ?').run('Prior overall review conclusion.', 'My overall pending review.', reviewId);
  return response.body.comment;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-freshness-'));
  configDir = path.join(root, 'config');
  source = path.join(root, 'remote');
  await fs.mkdir(source);
  git = simpleGit(source);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'Freshness Test');
  await git.addConfig('user.email', 'freshness@example.test');
  await fs.writeFile(path.join(source, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(source, 'file.js'), 'const stable = true;\nconst value = 1;\n');
  await git.add('.');
  await git.commit('base');
  const base = (await git.revparse(['HEAD'])).trim();
  await git.checkoutLocalBranch('feature');
  await fs.writeFile(path.join(source, 'file.js'), 'const stable = true;\nconst value = 2;\n');
  await git.add('.');
  await git.commit('first revision');
  oldHead = (await git.revparse(['HEAD'])).trim();
  await git.raw(['update-ref', 'refs/pull/1/head', oldHead]);
  await git.checkout('main');
  await git.addRemote('origin', source);
  remote = { id: 1, number: 1, title: 'Original PR title', body: 'Description', author: 'author', state: 'open', merged: false,
    base_branch: 'main', head_branch: 'feature', base_sha: base, head_sha: oldHead, node_id: 'PR_fixture',
    html_url: 'https://github.com/owner/repo/pull/1', changed_files: 1, repository: { full_name: 'owner/repo', clone_url: source } };
  config = { github_token: 'fixture', repos: { 'owner/repo': { path: source } }, summaries: { enabled: false }, tours: { enabled: false } };
  db = createTestDatabase();
  omitRechecks = false;
  failProvider = false;
  holdProvider = null;
  providerStarted = null;
  prompts.length = 0;
  await setupPRReview({ db, config, owner: 'owner', repo: 'repo', prNumber: 1, githubToken: 'fixture' });
  reviewId = db.prepare('SELECT id FROM reviews').get().id;
  worktree = db.prepare('SELECT path FROM worktrees').get().path;
  vi.spyOn(GitHubClient.prototype, 'fetchPullRequestDiff').mockImplementation(() => new GitWorktreeManager(db).generateUnifiedDiff(worktree, remote));
  app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('config', config);
  app.set('githubToken', 'fixture');
  app.use(setupRoutes);
  app.use(prRoutes);
  app.use(reviewRoutes);
});

afterEach(async () => {
  activeAnalyses.clear();
  activeSetups.clear();
  reviewToAnalysisId.clear();
  closeTestDatabase(db);
  await fs.rm(root, { recursive: true, force: true });
});

describe('current remote revision review contract', () => {
  it('default setup reuse and direct browser load replace stale metadata/diff without replacing history or drafts', async () => {
    const draft = await seedHistory();
    await advance();
    const response = await request(app).post('/api/setup/pr/owner/repo/1').send({});
    expect(response.body.existing).not.toBe(true);
    const setup = activeSetups.get('pr:owner/repo/1');
    if (setup) await setup.promise;
    const loaded = await request(app).get('/api/pr/owner/repo/1');
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
    const metadata = await new PRMetadataRepository(db).getByPR(1, 'owner/repo');
    expect(metadata.head_sha).toBe(remote.head_sha);
    expect(metadata.pr_data_parsed.diff).toContain('const value = 3;');
    expect((await simpleGit(worktree).revparse(['HEAD'])).trim()).toBe(remote.head_sha);
    expect(db.prepare('SELECT body, commit_sha FROM comments WHERE id = ?').get(draft.id)).toEqual({ body: draft.body, commit_sha: oldHead });
    expect(db.prepare('SELECT diff FROM analysis_runs WHERE id = ?').get('old-run').diff).toBe('historical snapshot');
    await advance(4);
    const direct = await request(app).get('/api/pr/owner/repo/1');
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
    expect(direct.body.head_sha || direct.body.data?.head_sha).toBe(remote.head_sha);
  });

  it('keeps checkout, diff, metadata and the returned snapshot reserved through delayed persistence', async () => {
    const draft = await seedHistory();
    await advance();
    const firstHead = remote.head_sha;
    const paused = deferred();
    const release = deferred();
    const original = GitWorktreeManager.prototype.getChangedFiles;
    const spy = vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles').mockImplementation(async function (...args) {
      const files = await original.apply(this, args);
      paused.resolve();
      await release.promise;
      return files;
    });
    const params = { db, config, owner: 'owner', repo: 'repo', prNumber: 1, githubToken: 'fixture' };
    const first = refreshPRReview(params);
    try {
      await paused.promise;
      await advance(4);
      expect((await request(app).get('/api/pr/owner/repo/1')).status).toBe(409);
      await expect(setupPRReview(params)).rejects.toMatchObject({ statusCode: 409 });
      await expect(new AnalysisRunRepository(db).create({ id: 'conflicting-run', reviewId, headSha: firstHead })).rejects.toMatchObject({ statusCode: 409 });
      expect((await simpleGit(worktree).revparse(['HEAD'])).trim()).toBe(firstHead);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
    const snapshot = await first;
    expect(snapshot.prData.head_sha).toBe(firstHead);
    expect(snapshot.prMetadata.head_sha).toBe(firstHead);
    expect(snapshot.diff).toContain('const value = 3;');
    expect(snapshot.diff).not.toContain('const value = 4;');
    expect((await refreshPRReview(params)).prMetadata.head_sha).toBe(remote.head_sha);
    expect(snapshot.prMetadata.head_sha).toBe(firstHead);
    expect((await new PRMetadataRepository(db).getByPR(1, 'owner/repo')).head_sha).toBe(remote.head_sha);
    expect(db.prepare('SELECT body, commit_sha FROM comments WHERE id = ?').get(draft.id)).toEqual({ body: draft.body, commit_sha: oldHead });
    expect(db.prepare('SELECT * FROM worktree_locks').all()).toEqual([]);
  });

  it('reserves the actual selected pool checkout when it differs from the PR preparation path', async () => {
    const { WorktreePoolRepository } = require('../../src/database');
    const record = db.prepare('SELECT * FROM worktrees').get();
    const pool = new WorktreePoolRepository(db);
    await pool.create({ id: record.id, repository: 'owner/repo', path: worktree });
    db.prepare('UPDATE repo_settings SET pool_size = 1 WHERE repository = ?').run('owner/repo');
    config.repos['owner/repo'].pool_size = 1;
    await advance();
    remote.number = 2;
    await git.raw(['update-ref', 'refs/pull/2/head', remote.head_sha]);
    const params = { db, config, owner: 'owner', repo: 'repo', prNumber: 2, githubToken: 'fixture' };
    const locks = new WorktreeLockManager(db);
    expect(locks.acquire(worktree, 'external-removal')).toBe(true);
    try {
      await setupPRReview(params);
      const fallback = await new PRMetadataRepository(db).getByPR(2, 'owner/repo');
      const fallbackPath = await new GitWorktreeManager(db).getWorktreePath({ owner: 'owner', repo: 'repo', number: 2 });
      expect(fallbackPath).not.toBe(worktree);
      expect(fallback.head_sha).toBe(remote.head_sha);
      expect((await simpleGit(fallbackPath).revparse(['HEAD'])).trim()).toBe(remote.head_sha);
      expect((await pool.getPoolEntry(record.id)).status).toBe('available');
      expect((await simpleGit(worktree).revparse(['HEAD'])).trim()).toBe(oldHead);
    } finally {
      locks.release(worktree, 'external-removal');
    }
    remote.number = 3;
    await git.raw(['update-ref', 'refs/pull/3/head', remote.head_sha]);
    const paused = deferred();
    const release = deferred();
    const original = GitWorktreeManager.prototype.getChangedFiles;
    const spy = vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles').mockImplementation(async function (...args) {
      const files = await original.apply(this, args);
      paused.resolve();
      await release.promise;
      return files;
    });
    const preparation = setupPRReview({ ...params, prNumber: 3 });
    try {
      await paused.promise;
      expect(locks.acquire(worktree, 'foreign-operation', { repository: 'unrelated/repo', prNumber: 99 })).toBe(false);
      expect((await simpleGit(worktree).revparse(['HEAD'])).trim()).toBe(remote.head_sha);
    } finally {
      release.resolve();
      spy.mockRestore();
      await preparation;
    }
    expect((await new PRMetadataRepository(db).getByPR(3, 'owner/repo')).head_sha).toBe(remote.head_sha);
    expect(db.prepare('SELECT * FROM worktree_locks').all()).toEqual([]);
  });

  it.each([
    ['single', 'busy'], ['single', 'completed'],
    ['council', 'busy'], ['council', 'completed']
  ])('refuses %s analysis when a %s refresh wins the preparation-to-registration handoff', async (mode, refreshState) => {
    const metadata = await new PRMetadataRepository(db).getByPR(1, 'owner/repo');
    const atRegistration = deferred();
    const register = deferred();
    const originalCreate = AnalysisRunRepository.prototype.create;
    const createSpy = vi.spyOn(AnalysisRunRepository.prototype, 'create').mockImplementation(async function (data) {
      atRegistration.resolve();
      await register.promise;
      return originalCreate.call(this, data);
    });
    const Analyzer = require('../../src/ai/analyzer');
    const analyzer = new Analyzer(db, 'opus', 'claude');
    const running = (mode === 'single'
      ? analyzer.analyzeAllLevels(reviewId, worktree, metadata, null, null, null, { enabledLevels: { 1: true, 2: false, 3: false } })
      : analyzer.runReviewerCentricCouncil({ reviewId, worktreePath: worktree, prMetadata: metadata }, {
        voices: [{ provider: 'claude', model: 'opus' }], levels: { 1: true, 2: false, 3: false }
      })).then(result => ({ result }), error => ({ error }));
    const atSnapshot = deferred();
    const persist = deferred();
    const originalFiles = GitWorktreeManager.prototype.getChangedFiles;
    let filesSpy;
    let refreshing;
    try {
      await atRegistration.promise;
      await advance();
      filesSpy = vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles').mockImplementation(async function (...args) {
        const files = await originalFiles.apply(this, args);
        atSnapshot.resolve();
        await persist.promise;
        return files;
      });
      refreshing = refreshPRReview({ db, config, owner: 'owner', repo: 'repo', prNumber: 1, githubToken: 'fixture' });
      await atSnapshot.promise;
      if (refreshState === 'completed') {
        persist.resolve();
        await refreshing;
      }
      register.resolve();
      const outcome = await running;
      expect(outcome.error?.message).toMatch(refreshState === 'busy' ? /checkout|worktree/i : /not the current PR head/);
      expect(prompts).toHaveLength(0);
      const runs = db.prepare('SELECT status FROM analysis_runs').all();
      expect(runs).toEqual(refreshState === 'busy' ? [] : [{ status: 'failed' }]);
    } finally {
      register.resolve();
      persist.resolve();
      createSpy.mockRestore();
      filesSpy?.mockRestore();
      await running;
      if (refreshing) await refreshing;
    }
    expect((await simpleGit(worktree).revparse(['HEAD'])).trim()).toBe(remote.head_sha);
  });

  it('reassesses an overall review with no inline findings on the new head without manufacturing item outcomes', async () => {
    const runs = new AnalysisRunRepository(db);
    await runs.create({ id: 'summary-only-run', reviewId, provider: 'claude', model: 'opus',
      headSha: oldHead, status: 'completed', diff: 'saved prior diff' });
    await runs.update('summary-only-run', { summary: 'Prior zero-finding conclusion.' });
    db.prepare('UPDATE reviews SET summary = ?, draft_body = ? WHERE id = ?')
      .run('Prior zero-finding conclusion.', 'My authored overall review body.', reviewId);
    await advance();
    const id = await analyze({ provider: 'claude', model: 'opus', enabledLevels: { 1: true, 2: false, 3: false } });
    const instruction = prompts.find(prompt => prompt.includes('Required saved-feedback revision recheck'));
    expect(instruction).toContain('Prior zero-finding conclusion.');
    expect(instruction).toContain('My authored overall review body.');
    expect(instruction).toContain(`head ${remote.head_sha}`);
    const row = db.prepare('SELECT summary, draft_body, review_data FROM reviews WHERE id = ?').get(reviewId);
    expect(row.draft_body).toBe('My authored overall review body.');
    expect(row.summary).toBe('No new findings; explicitly reassessed saved feedback.');
    expect(JSON.parse(row.review_data).revision_rechecks[id]).toMatchObject({
      head_sha: remote.head_sha, prior_summary: 'Prior zero-finding conclusion.', draft_body: 'My authored overall review body.', items: {}
    });
    expect(db.prepare('SELECT summary, diff FROM analysis_runs WHERE id = ?').get('summary-only-run'))
      .toEqual({ summary: 'Prior zero-finding conclusion.', diff: 'saved prior diff' });
    expect((await request(app).get(`/api/reviews/${reviewId}/comments`)).body.comments).toEqual([]);
  });

  it('fresh analysis rechecks every saved item even with zero new findings, preserves human text, and blocks stale publication', async () => {
    const draft = await seedHistory();
    await advance();
    const runId = await analyze({ provider: 'claude', model: 'opus', enabledLevels: { 1: true, 2: false, 3: false }, excludePrevious: { feedback: true, github: true } });
    const run = await new AnalysisRunRepository(db).getById(runId, { includeDiff: true });
    expect(run.head_sha).toBe(remote.head_sha);
    expect(run.diff).toContain('const value = 3;');
    const orchestration = prompts.find(prompt => prompt.includes('Required saved-feedback revision recheck') && prompt.includes('Prior overall review conclusion.'));
    expect(orchestration).toContain('My overall pending review.');
    expect(orchestration).not.toContain('## Exclude Previously Identified Issues');
    const response = await request(app).get(`/api/reviews/${reviewId}/comments`);
    expect(response.body.comments[0]).toMatchObject({ body: draft.body, commit_sha: oldHead,
      revision_recheck: { head_sha: remote.head_sha, status: 'checked', relevance: 'changed', suggested_body: 'Suggested current wording, not an authored edit.' } });
    const findings = await request(app).get(`/api/reviews/${reviewId}/suggestions?allRuns=true`);
    expect(findings.body.suggestions.find(item => item.ai_run_id === 'old-run').revision_recheck.status).toBe('checked');
    const manifest = await buildSubmissionManifest({ db, reviewId, client: new GitHubClient('fixture'), target: { owner: 'owner', repo: 'repo', prNumber: 1 }, config });
    expect(manifest.comments[0].errors.some(message => message.includes('older head'))).toBe(true);
    expect(manifest.blockers.length).toBeGreaterThan(0);
  });

  it.each(['missing', 'failed'])('keeps %s semantic rechecks unverified instead of treating absent findings as fixed', async (mode) => {
    await seedHistory();
    await advance();
    omitRechecks = mode === 'missing';
    failProvider = mode === 'failed';
    await analyze({ provider: 'claude', model: 'opus', enabledLevels: { 1: true, 2: false, 3: false } });
    const response = await request(app).get(`/api/reviews/${reviewId}/comments`);
    expect(response.body.comments[0].revision_recheck).toMatchObject({ status: 'unverified', relevance: 'unverified', location: null });
  });

  it('explicit council analysis fetches a newer head before recording or launching its reviewers', async () => {
    await seedHistory();
    await advance();
    const runId = await analyze({ configType: 'council', councilConfig: { voices: [{ provider: 'claude', model: 'opus', tier: 'balanced' }], levels: { 1: true, 2: false, 3: false } } }, 'analyses/council');
    const run = await new AnalysisRunRepository(db).getById(runId, { includeDiff: true });
    expect(run.head_sha).toBe(remote.head_sha);
    expect(run.diff).toContain('const value = 3;');
    expect((await request(app).get(`/api/reviews/${reviewId}/comments`)).body.comments[0].revision_recheck.status).toBe('checked');
  });

  it('standalone headless analysis resolves latest remote metadata before reusing its checkout', async () => {
    await seedHistory();
    await advance();
    const { handleHeadlessAnalysis } = require('../../src/main');
    await handleHeadlessAnalysis(['https://github.com/owner/repo/pull/1'], config, db, { provider: 'claude', model: 'opus' }, null);
    const run = db.prepare("SELECT * FROM analysis_runs WHERE id != 'old-run' AND parent_run_id IS NULL ORDER BY rowid DESC LIMIT 1").get();
    expect(run.status).toBe('completed');
    expect(run.head_sha).toBe(remote.head_sha);
    expect(run.diff).toContain('const value = 3;');
    expect(JSON.parse(run.protocol_snapshot).comparison).toEqual({ baseSha: remote.base_sha, headSha: remote.head_sha });
    expect((await request(app).get(`/api/reviews/${reviewId}/comments`)).body.comments[0].revision_recheck.status).toBe('checked');
  });

  it('keeps an in-flight run pinned when the remote advances and exposes its rechecks as stale after reload', async () => {
    await seedHistory();
    await advance();
    const pinnedHead = remote.head_sha;
    let release;
    holdProvider = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { providerStarted = resolve; });
    const response = await request(app).post('/api/pr/owner/repo/1/analyses').send({ provider: 'claude', model: 'opus', enabledLevels: { 1: true, 2: false, 3: false } });
    expect(response.status).toBe(200);
    await started;
    await advance(4);
    release();
    for (let i = 0; i < 1000 && activeAnalyses.get(response.body.runId)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const run = await new AnalysisRunRepository(db).getById(response.body.runId, { includeDiff: true });
    expect(run.status).toBe('completed');
    expect(run.head_sha).toBe(pinnedHead);
    expect(run.diff).toContain('const value = 3;');
    expect(run.diff).not.toContain('const value = 4;');
    const loaded = await request(app).get('/api/pr/owner/repo/1');
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
    const comments = await request(app).get(`/api/reviews/${reviewId}/comments`);
    expect(comments.body.comments[0].revision_recheck).toMatchObject({ head_sha: remote.head_sha, status: 'unverified' });
  });

  it('preserves dirty and ignored user files and refuses a conflicting automatic checkout', async () => {
    await fs.writeFile(path.join(worktree, 'file.js'), 'unsaved user work\n');
    await advance();
    const dirty = await request(app).get('/api/pr/owner/repo/1');
    expect(dirty.status).toBeGreaterThanOrEqual(400);
    expect(await fs.readFile(path.join(worktree, 'file.js'), 'utf8')).toBe('unsaved user work\n');
    await simpleGit(worktree).checkout(['--', 'file.js']);
    await fs.writeFile(path.join(worktree, 'ignored.txt'), 'private ignored data\n');
    await git.checkout('feature');
    await fs.writeFile(path.join(source, 'ignored.txt'), 'remote tracked data\n');
    await git.add(['--force', 'ignored.txt']);
    await git.commit('track formerly ignored file');
    remote.head_sha = (await git.revparse(['HEAD'])).trim();
    await git.raw(['update-ref', 'refs/pull/1/head', remote.head_sha]);
    await git.checkout('main');
    const ignored = await request(app).post('/api/pr/owner/repo/1/analyses').send({ provider: 'claude', model: 'opus' });
    expect(ignored.status).toBeGreaterThanOrEqual(400);
    expect(await fs.readFile(path.join(worktree, 'ignored.txt'), 'utf8')).toBe('private ignored data\n');
    expect(prompts).toHaveLength(0);
  });

  it('does not switch a newer head beneath an active analysis or remove another operation lock', async () => {
    const runRepo = new AnalysisRunRepository(db);
    await runRepo.create({ id: 'busy', reviewId, headSha: oldHead });
    const same = await request(app).get('/api/pr/owner/repo/1');
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    await advance();
    const changed = await request(app).get('/api/pr/owner/repo/1');
    expect(changed.status).toBe(409);
    expect((await simpleGit(worktree).revparse(['HEAD'])).trim()).toBe(oldHead);
    await runRepo.update('busy', { status: 'completed' });
    const locks = new WorktreeLockManager(db);
    expect(locks.acquire(worktree, 'other-operation')).toBe(true);
    const locked = await request(app).post('/api/pr/owner/repo/1/analyses').send({ provider: 'claude' });
    expect(locked.status).toBe(409);
    expect(locks.isLocked(worktree)).toMatchObject({ holderId: 'other-operation' });
    locks.release(worktree, 'other-operation');
  });

  it('requires explicit current-anchor confirmation and rejects intervening draft edits without rewriting them', async () => {
    const draft = await seedHistory();
    await advance();
    const payload = { draft_key: draft.draft_key, expected_revision: draft.revision, head_sha: remote.head_sha,
      file: 'file.js', line_start: 2, line_end: 2, side: 'RIGHT', is_file_level: false };
    expect((await request(app).post(`/api/reviews/${reviewId}/comments/${draft.id}/reanchor`).send(payload)).status).toBe(428);
    db.prepare('UPDATE comments SET body = ? WHERE id = ?').run('Edited after inspection.', draft.id);
    expect((await request(app).post(`/api/reviews/${reviewId}/comments/${draft.id}/reanchor`).send({ ...payload, confirmed: true })).status).toBe(409);
    const current = db.prepare('SELECT * FROM comments WHERE id = ?').get(draft.id);
    const result = await request(app).post(`/api/reviews/${reviewId}/comments/${draft.id}/reanchor`).send({ ...payload, confirmed: true, expected_revision: current.revision });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.comment).toMatchObject({ body: 'Edited after inspection.', commit_sha: remote.head_sha });
  });
});
