// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const Database = require('better-sqlite3');
const { _setupSchema: setupSchema, runVersionedMigrations, MIGRATIONS, CommentRepository, WorktreePoolRepository } = require('../../src/database');
const { createForkDatabase } = require('../fixtures/schema-fork-v62.cjs');
const v55 = require('../fixtures/schema-v55.cjs');

const text = '  Keep `fieldIdentity` intact.\n\n```suggestion\nconst value = "original";\n```\n';
const at = '2026-10-01T00:00:00.000Z';
let db;
afterEach(() => { if (db?.open) db.close(); });

function legacyReceipt({ state = 'submitted', itemState = 'accepted', key = 'saved-key' } = {}) {
  const manifest = { event: 'COMMENT', body: 'Saved review body', pendingBody: 'Saved review body', selection: null,
    comments: [{ id: 1, key, source: 'user', revision: 7, body: text,
      wire: { path: 'a.js', body: text, start_line: 2, line: 4, side: 'LEFT', isFileLevel: false } }] };
  db.prepare(`INSERT INTO submission_attempts
    (id, review_id, target_key, manifest, digest, state, phase, owner, remote_id, remote_database_id, remote_url, created_at, updated_at)
    VALUES ('receipt', 1, 'target', ?, 'digest', ?, 'settled', 'old-executor', 'REVIEW_42', '42', 'https://example.test/review/42', ?, ?)`)
    .run(JSON.stringify(manifest), state, at, at);
  db.prepare(`INSERT INTO submission_items
    (attempt_id, ordinal, local_id, local_key, state, remote_id, remote_database_id, thread_id)
    VALUES ('receipt', 0, 1, ?, ?, 'COMMENT_7', '7', 'THREAD_7')`).run(key, itemState);
}

function seedFork(version = 62) {
  db = createForkDatabase(new Database(':memory:'), version);
  db.prepare("INSERT INTO reviews (id, pr_number, repository) VALUES (1, 1, 'owner/repo')").run();
  if (version >= 57) {
    db.prepare(`INSERT INTO comments
      (id, review_id, source, status, file, line_start, line_end, side, body, draft_key, revision, included)
      VALUES (1, 1, 'user', 'active', 'a.js', 2, 4, 'LEFT', ?, 'saved-key', 7, 0)`).run(text);
    db.prepare("UPDATE reviews SET draft_body = 'Saved review body', draft_event = 'REQUEST_CHANGES' WHERE id = 1").run();
  } else {
    db.prepare(`INSERT INTO comments (id, review_id, source, status, file, line_start, line_end, side, body)
      VALUES (1, 1, 'user', 'active', 'a.js', 2, 4, 'LEFT', ?)`).run(text);
  }
  return db;
}

describe('upgrade colliding upstream and fork migration histories', () => {
  it.each([56, 57, 58, 59, 60, 61, 62])('retains authored drafts and restores usable repositories from fork v%i', async version => {
    seedFork(version);
    const before = db.prepare('SELECT * FROM comments WHERE id = 1').get();
    const summary = db.prepare('SELECT * FROM reviews WHERE id = 1').get();
    setupSchema(db);
    const comments = new CommentRepository(db);
    const upgraded = await comments.getComment(1, 'user');
    expect(upgraded).toMatchObject({ body: text, file: 'a.js', line_start: 2, line_end: 4, side: 'LEFT', status: 'active' });
    if (version >= 57) {
      expect(upgraded).toMatchObject({ draft_key: before.draft_key, revision: before.revision, included: 0 });
      expect(db.prepare('SELECT draft_body, draft_event, draft_revision FROM reviews WHERE id = 1').get())
        .toEqual({ draft_body: summary.draft_body, draft_event: summary.draft_event, draft_revision: summary.draft_revision });
    }
    const changed = await comments.updateComment(1, { body: 'Explicit later edit', included: true,
      draft_key: upgraded.draft_key, expected_revision: upgraded.revision });
    expect(changed.body).toBe('Explicit later edit');
    await expect(comments.updateComment(1, { body: 'Stale overwrite', draft_key: upgraded.draft_key,
      expected_revision: upgraded.revision })).rejects.toMatchObject({ statusCode: 409 });
    expect((await comments.getComment(1)).body).toBe('Explicit later edit');
    const pools = new WorktreePoolRepository(db);
    await pools.create({ id: 'pool', repository: 'owner/repo', path: '/tmp/schema-upgrade-pool', prNumber: 1, holderPid: 123 });
    expect(await pools.markAvailable('pool', 456)).toBe(false);
    expect(await pools.markAvailable('pool', 123)).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('preserves upstream posting history and process holders while adding fork authoring', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const sql of Object.values(v55.SCHEMA_SQL)) db.exec(sql);
    for (const sql of v55.INDEX_SQL) db.exec(sql);
    db.prepare("INSERT INTO reviews (id, pr_number, repository) VALUES (1, 1, 'owner/repo')").run();
    db.prepare("INSERT INTO comments (id, review_id, source, status, body) VALUES (1, 1, 'user', 'draft', ?)").run(text);
    db.prepare("INSERT INTO github_reviews (id, review_id, github_node_id, state) VALUES (1, 1, 'REVIEW_42', 'pending')").run();
    for (const version of [56, 57, 58, 59]) MIGRATIONS[version](db);
    db.pragma('user_version = 59');
    db.prepare(`INSERT INTO worktree_pool (id, repository, path, status, current_pr_number, holder_pid, holder_claimed_at, created_at)
      VALUES ('pool', 'owner/repo', '/tmp/upstream-upgrade-pool', 'in_use', 1, 123, ?, ?)`).run(at, at);
    const posting = db.prepare('SELECT * FROM comment_postings').get();
    const pool = db.prepare('SELECT * FROM worktree_pool').get();
    setupSchema(db);
    expect(db.prepare('SELECT * FROM comment_postings').all()).toEqual([posting]);
    expect(db.prepare('SELECT * FROM worktree_pool').get()).toEqual(pool);
    const comments = new CommentRepository(db);
    const current = await comments.getComment(1);
    expect(current.publication.state).toBe('draft');
    const edited = await comments.updateComment(1, { body: 'Edit without reposting', draft_key: current.draft_key,
      expected_revision: current.revision });
    expect((await comments.getComment(edited.id)).publication.changed).toBe(true);
    expect(db.prepare(`SELECT id FROM comments c WHERE ${CommentRepository.pendingCommentSql()}`).all()).toEqual([]);
  });

  it('imports acknowledged wire snapshots rather than a later local edit, exactly once', async () => {
    seedFork();
    legacyReceipt();
    db.prepare("UPDATE comments SET body = 'Later local edit' WHERE id = 1").run();
    runVersionedMigrations(db);
    const publication = (await new CommentRepository(db).getComment(1)).publication;
    expect(publication).toMatchObject({ state: 'posted', changed: true, posting_count: 1 });
    expect(db.prepare('SELECT body, comment_body, line_start, line_end, side, github_comment_node_id FROM comment_postings').all())
      .toEqual([{ body: text, comment_body: text, line_start: 2, line_end: 4, side: 'LEFT', github_comment_node_id: 'COMMENT_7' }]);
    setupSchema(db);
    expect(db.prepare('SELECT body FROM comment_postings').all()).toEqual([{ body: text }]);
    expect(db.prepare('SELECT body FROM comments WHERE id = 1').get().body).toBe('Later local edit');
  });

  it('does not attach an old receipt to a reused local comment id', () => {
    seedFork();
    legacyReceipt();
    db.prepare('DELETE FROM comments WHERE id = 1').run();
    db.prepare(`INSERT INTO comments (id, review_id, source, status, body, draft_key)
      VALUES (1, 1, 'user', 'active', 'Unrelated new draft', 'replacement-key')`).run();
    runVersionedMigrations(db);
    expect(db.prepare('SELECT * FROM comment_postings').all()).toEqual([]);
    expect(db.prepare('SELECT body, draft_key FROM comments WHERE id = 1').get())
      .toEqual({ body: 'Unrelated new draft', draft_key: 'replacement-key' });
  });

  it('keeps unknown mutation outcomes unposted and preserves their durable receipt', () => {
    seedFork();
    legacyReceipt({ state: 'outcome_unknown', itemState: 'unknown' });
    const before = db.prepare('SELECT * FROM submission_attempts').get();
    runVersionedMigrations(db);
    expect(db.prepare('SELECT * FROM comment_postings').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM submission_attempts').get()).toEqual(before);
    expect(db.prepare('SELECT state, remote_id FROM submission_items').get())
      .toEqual({ state: 'unknown', remote_id: 'COMMENT_7' });
  });

  it('rolls a failed reconciliation back without changing its version or authored text', () => {
    seedFork();
    db.prepare("UPDATE comments SET status = 'submitted' WHERE id = 1").run();
    const before = db.prepare('SELECT * FROM comments WHERE id = 1').get();
    db.exec(`CREATE TRIGGER reject_upgrade BEFORE UPDATE OF status ON comments
      WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'fixture upgrade rejected'); END`);
    expect(() => runVersionedMigrations(db)).toThrow('fixture upgrade rejected');
    expect(db.pragma('user_version', { simple: true })).toBe(62);
    expect(db.prepare('SELECT * FROM comments WHERE id = 1').get()).toEqual(before);
    db.exec('DROP TRIGGER reject_upgrade');
    runVersionedMigrations(db);
    expect((db.prepare('SELECT body, status FROM comments WHERE id = 1').get())).toEqual({ body: text, status: 'active' });
    expect(db.prepare('SELECT body FROM comment_postings').all()).toEqual([{ body: text }]);
  });

  it('creates a recoverable online backup before upgrading an existing fork database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pair-review-upgrade-'));
    try {
      const dir = join(home, '.pair-review');
      await mkdir(dir);
      const file = join(dir, 'database.db');
      db = createForkDatabase(new Database(file));
      db.prepare("INSERT INTO reviews (id, pr_number, repository, draft_body) VALUES (1, 1, 'owner/repo', ?)").run(text);
      db.close();
      execFileSync(process.execPath, ['-e', "require('./src/database').initializeDatabase().then(db => db.close()).catch(error => { console.error(error); process.exitCode = 1; })"],
        { cwd: process.cwd(), env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
      const backups = (await readdir(dir)).filter(name => name.startsWith('database.db.schema-62-') && name.endsWith('.bak'));
      expect(backups).toHaveLength(1);
      const backup = new Database(join(dir, backups[0]), { readonly: true });
      try {
        expect(backup.pragma('user_version', { simple: true })).toBe(62);
        expect(backup.prepare('SELECT draft_body FROM reviews WHERE id = 1').get().draft_body).toBe(text);
      } finally { backup.close(); }
      db = new Database(file, { readonly: true });
      expect(db.pragma('user_version', { simple: true })).toBe(63);
      expect(db.prepare('SELECT draft_body FROM reviews WHERE id = 1').get().draft_body).toBe(text);
    } finally {
      if (db?.open) db.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
