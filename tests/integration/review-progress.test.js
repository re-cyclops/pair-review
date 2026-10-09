// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import express from 'express';
import { createTestDatabase } from '../utils/schema.js';
const { AnalysisRunRepository, MIGRATIONS } = require('../../src/database');
const routes = require('../../src/routes/reviews');
const fsPromises = require('node:fs/promises');

describe('Human-reviewed revision and content-bound progress', () => {
  let db, directory, server, url, base;
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  }).trim();
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'Fixture revision'); };
  const snapshot = () => {
    const data = { head_sha: git('rev-parse', 'HEAD'), base_sha: base, diff: git('diff', '--no-ext-diff', '--full-index', `${base}...HEAD`) + '\n', worktree_path: directory };
    db.prepare("UPDATE pr_metadata SET pr_data = ? WHERE repository = 'owner/repo' AND pr_number = 1").run(JSON.stringify(data));
    return data;
  };
  const request = async (suffix = 'progress', input, reviewId = 1) => {
    const response = await fetch(`${url}/api/reviews/${reviewId}/${suffix}`, input ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : undefined);
    return { status: response.status, data: await response.json() };
  };
  const get = async () => (await request()).data;
  const update = async (state, action, extra = {}) => {
    const result = await request('progress', { token: state.token, action, ...extra });
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return result.data;
  };
  const compare = state => request(`changes-since-reviewed?token=${state.token}`);

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'review-progress-'));
    git('init', '-q', '--initial-branch=main');
    writeFileSync(join(directory, 'a.js'), 'const a = 1;\n');
    writeFileSync(join(directory, 'b.js'), 'const b = 1;\n');
    commit();
    base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'review');
    writeFileSync(join(directory, 'a.js'), 'const a = 2;\n');
    writeFileSync(join(directory, 'b.js'), 'const b = 2;\n');
    commit();
    db = createTestDatabase();
    db.prepare("INSERT INTO reviews (id, repository, pr_number) VALUES (1, 'owner/repo', 1)").run();
    db.prepare("INSERT INTO pr_metadata (repository, pr_number) VALUES ('owner/repo', 1)").run();
    snapshot();
    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.use(routes);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('separates opened, file-viewed, analyzed and explicitly reviewed revisions', async () => {
    let state = await get();
    expect(state.lastReviewed).toBeNull();
    state = await update(state, 'opened');
    state = await update(state, 'files', { changes: { 'a.js': true } });
    await new AnalysisRunRepository(db).create({ id: 'analysis', reviewId: 1, headSha: state.head, status: 'completed' });
    state = await get();
    expect(state).toMatchObject({ lastOpened: { head: state.head }, lastAnalyzedHead: state.head, lastReviewed: null, reviewedFiles: 1, visitedFiles: 1 });
    expect((await compare(state)).data.available).toBe(false);
    state = await update(state, 'reviewed');
    expect(state.lastReviewed).toMatchObject({ head: state.head, committed: true });
    expect(state.reviewedFiles).toBe(1);
    expect(db.prepare('SELECT review_baseline FROM analysis_runs WHERE id = ?').get('analysis').review_baseline).toBeNull();
  });

  it('retains only unchanged-file marks and compares the new committed content', async () => {
    let state = await get();
    state = await update(state, 'files', { changes: { 'a.js': true, 'b.js': true } });
    const reviewed = await update(state, 'reviewed');
    writeFileSync(join(directory, 'a.js'), 'const a = 3;\n');
    commit(); snapshot();
    state = await get();
    expect(state).toMatchObject({ files: ['b.js'], reviewedFiles: 1, newCommits: true, lastReviewed: { head: reviewed.head } });
    const result = (await compare(state)).data;
    expect(result).toMatchObject({ available: true, commitCount: 1, fullDiff: false });
    expect(result.files.map(file => file.file)).toEqual(['a.js']);
    expect(result.diff).toContain('-const a = 2;');
    expect(result.diff).toContain('+const a = 3;');
  });

  it('merges separate tab marks and refuses a stale content authorization', async () => {
    const first = await get();
    const second = await get();
    await update(first, 'files', { changes: { 'a.js': true } });
    await update(second, 'files', { changes: { 'b.js': true } });
    expect((await get()).files).toEqual(['a.js', 'b.js']);
    writeFileSync(join(directory, 'a.js'), 'const a = 4;\n');
    commit(); snapshot();
    expect((await request('progress', { token: first.token, action: 'files', changes: { 'a.js': true } })).status).toBe(409);
    expect((await get()).files).toEqual(['b.js']);
  });

  it('rejects metadata replaced during pinned-content verification without recording a mark', async () => {
    const data = snapshot();
    db.prepare("UPDATE reviews SET review_type = 'local', local_path = ?, local_head_sha = ? WHERE id = 1").run(directory, data.head_sha);
    db.prepare('INSERT INTO local_diffs (review_id, diff_text, digest) VALUES (1, ?, ?)').run(data.diff, 'fixture-digest');
    db.prepare("INSERT INTO context_files (review_id, file, line_start, line_end) VALUES (1, 'a.js', 1, 1)").run();
    const displayed = await get();
    const readFile = fsPromises.readFile.bind(fsPromises);
    const pinned = await fsPromises.realpath(join(directory, 'a.js'));
    let reads = 0;
    vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      const content = await readFile(...args);
      if (args[0] === pinned && ++reads === 2) {
        db.prepare('UPDATE reviews SET local_head_sha = ? WHERE id = 1').run(base);
      }
      return content;
    });
    const result = await request('progress', { token: displayed.token, action: 'files', changes: { 'context:a.js': true } });
    expect(result.status).toBe(409);
    expect((await get()).files).toEqual([]);
  });

  it('does not authorize an identical diff belonging to another review', async () => {
    const displayed = await get();
    const data = snapshot();
    db.prepare("INSERT INTO reviews (id, repository, pr_number) VALUES (2, 'owner/other', 1)").run();
    db.prepare("INSERT INTO pr_metadata (repository, pr_number, pr_data) VALUES ('owner/other', 1, ?)").run(JSON.stringify(data));
    const result = await request('progress', { token: displayed.token, action: 'reviewed' }, 2);
    expect(result.status).toBe(409);
    expect((await request('progress', undefined, 2)).data.lastReviewed).toBeNull();
  });

  it.each(['rename', 'delete', 'force-push', 'missing'])('falls back to the full diff after %s without advancing the baseline', async change => {
    const reviewed = await update(await get(), 'reviewed');
    if (change === 'rename') renameSync(join(directory, 'a.js'), join(directory, 'renamed.js'));
    if (change === 'delete') rmSync(join(directory, 'a.js'));
    if (change === 'force-push') { git('checkout', '--detach', base); writeFileSync(join(directory, 'a.js'), 'const a = 9;\n'); }
    if (change === 'missing') {
      const saved = JSON.parse(db.prepare('SELECT review_progress FROM reviews WHERE id = 1').get().review_progress);
      saved.reviewed.head = 'f'.repeat(40);
      db.prepare('UPDATE reviews SET review_progress = ? WHERE id = 1').run(JSON.stringify(saved));
    } else { commit(); snapshot(); }
    const state = await get();
    const result = (await compare(state)).data;
    expect(result).toMatchObject({ available: false, fullDiff: true });
    expect(result.baseline.head).toBe(change === 'missing' ? 'f'.repeat(40) : reviewed.head);
    expect((await get()).lastReviewed.head).toBe(result.baseline.head);
  });

  it('keeps local scope changes and uncommitted snapshots out of committed comparisons', async () => {
    const data = snapshot();
    db.prepare("UPDATE reviews SET review_type = 'local', local_path = ?, local_head_sha = ?, local_scope_start = 'branch', local_scope_end = 'unstaged', local_base_branch = 'main' WHERE id = 1").run(directory, data.head_sha);
    db.prepare('INSERT INTO local_diffs (review_id, diff_text, digest) VALUES (1, ?, ?)').run(data.diff, 'fixture-digest');
    let state = await update(await get(), 'reviewed');
    expect((await compare(state)).data.available).toBe(true);
    db.prepare("UPDATE reviews SET local_scope_start = 'unstaged' WHERE id = 1").run();
    state = await get();
    expect((await compare(state)).data).toMatchObject({ available: false, fullDiff: true });
    writeFileSync(join(directory, 'a.js'), 'const a = 8;\n');
    state = await update(state, 'reviewed');
    expect(state.lastReviewed.committed).toBe(false);
    expect((await compare(state)).data.available).toBe(false);
  });

  it('freezes the parent baseline for council children while later runs capture the newer review', async () => {
    const first = await update(await get(), 'reviewed');
    const runs = new AnalysisRunRepository(db);
    await runs.create({ id: 'parent', reviewId: 1, provider: 'council' });
    writeFileSync(join(directory, 'a.js'), 'const a = 7;\n');
    commit(); snapshot();
    const second = await update(await get(), 'reviewed');
    await runs.create({ id: 'child', reviewId: 1, parentRunId: 'parent' });
    await runs.create({ id: 'later', reviewId: 1 });
    expect(JSON.parse((await runs.getById('parent')).review_baseline).head).toBe(first.head);
    expect(JSON.parse((await runs.getById('child')).review_baseline).head).toBe(first.head);
    expect(JSON.parse((await runs.getById('later')).review_baseline).head).toBe(second.head);
  });

  it('marks old and unknown findings without changing their text or publication anchors', async () => {
    const oldHead = snapshot().head_sha;
    const runs = new AnalysisRunRepository(db);
    await runs.create({ id: 'known-head', reviewId: 1, headSha: oldHead });
    await runs.create({ id: 'unknown-head', reviewId: 1 });
    const insert = db.prepare(`INSERT INTO comments
      (review_id, source, ai_run_id, file, line_start, line_end, side, body, status, commit_sha)
      VALUES (1, ?, ?, 'a.js', 1, 1, 'RIGHT', ?, 'active', ?)`);
    const known = Number(insert.run('ai', 'known-head', 'Keep this original finding.', null).lastInsertRowid);
    const unknown = Number(insert.run('ai', 'unknown-head', 'Imported finding without a revision.', null).lastInsertRowid);
    const draft = Number(insert.run('user', null, 'Keep this human draft.', oldHead).lastInsertRowid);
    const findings = async () => {
      const response = await request('suggestions?allRuns=true');
      expect(response.status).toBe(200);
      return new Map(response.data.suggestions.map(finding => [finding.id, finding]));
    };
    expect((await findings()).get(known).revision).toEqual({ state: 'current', head: oldHead, currentHead: oldHead });
    writeFileSync(join(directory, 'a.js'), 'const a = 9;\n');
    commit();
    const currentHead = snapshot().head_sha;
    const changed = await findings();
    expect(changed.get(known)).toMatchObject({
      body: 'Keep this original finding.', status: 'active',
      revision: { state: 'stale', head: oldHead, currentHead }
    });
    expect(changed.get(unknown).revision).toEqual({ state: 'unknown', head: null, currentHead });
    expect((await get()).staleDrafts).toBe(1);
    expect(db.prepare('SELECT body, commit_sha, status FROM comments WHERE id = ?').get(draft))
      .toEqual({ body: 'Keep this human draft.', commit_sha: oldHead, status: 'active' });
  });

  it('migrates legacy viewed history without certifying unknown content or erasing metadata', async () => {
    const data = snapshot();
    db.prepare('UPDATE pr_metadata SET pr_data = ?').run(JSON.stringify({ ...data, viewedFiles: ['a.js', 'b.js'], title: 'Retained title' }));
    MIGRATIONS[60](db);
    expect(await get()).toMatchObject({ files: [], legacyViewedCount: 2, lastReviewed: null });
    const reviewed = await update(await get(), 'reviewed');
    MIGRATIONS[60](db);
    expect((await get()).lastReviewed).toEqual(reviewed.lastReviewed);
    const persisted = JSON.parse(db.prepare('SELECT pr_data FROM pr_metadata').get().pr_data);
    expect(persisted.title).toBe('Retained title');
    expect(persisted.viewedFiles).toBeUndefined();
  });
});
