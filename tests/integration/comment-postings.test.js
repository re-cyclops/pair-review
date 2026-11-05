// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const Database = require('better-sqlite3');
const { createTestDatabase, seedTestReview } = require('../utils/schema');
const { MIGRATIONS, GitHubReviewRepository, CommentPostingRepository, CommentRepository, _setupSchema: setupSchema } = require('../../src/database');
const { isPendingComment } = require('../../public/js/utils/posted-comment');
const v55 = require('../fixtures/schema-v55.cjs');

describe('comment posting storage and legacy upgrade', () => {
  let db;
  beforeEach(async () => { db = await createTestDatabase(); });
  afterEach(() => { db.close(); });

  it('backfills by status and time, with unknown-review fallback and idempotence', async () => {
    const review = await seedTestReview(db);
    const other = await seedTestReview(db, { prNumber: 999 });
    db.prepare(`INSERT INTO github_reviews (id, review_id, state, created_at) VALUES
      (1, ?, 'submitted', '2026-01-01 00:00:00'),
      (2, ?, 'submitted', '2026-01-02 00:00:00'),
      (3, ?, 'pending', '2026-01-03 00:00:00')`).run(review, review, review);
    const insert = db.prepare(`INSERT INTO comments
      (id, review_id, source, body, status, updated_at) VALUES (?, ?, 'user', 'snapshot', ?, ?)`);
    insert.run(1, review, 'submitted', '2026-01-01 00:00:01');
    insert.run(2, review, 'submitted', '2026-01-02 00:00:01');
    insert.run(3, review, 'draft', '2026-01-03 00:00:01');
    insert.run(4, review, 'inactive', '2026-01-03 00:00:01');
    insert.run(5, other, 'submitted', '2026-01-03 00:00:01');
    MIGRATIONS[56](db);
    MIGRATIONS[56](db);
    expect(db.prepare('SELECT comment_id, github_review_row_id FROM comment_postings ORDER BY comment_id').all()).toEqual([
      { comment_id: 1, github_review_row_id: 1 },
      { comment_id: 2, github_review_row_id: 2 },
      { comment_id: 3, github_review_row_id: 3 },
      { comment_id: 5, github_review_row_id: null }
    ]);
    expect(db.prepare('SELECT * FROM comment_postings').all().every(p => p.backfilled === 1 && p.body === p.comment_body)).toBe(true);
  });

  it('upserts one GitHub identity, preserves draft body/url, and propagates state to legacy duplicates', async () => {
    const review = await seedTestReview(db);
    const repo = new GitHubReviewRepository(db);
    const a = await repo.create(review, { github_node_id: 'NODE', state: 'pending', body: 'original', github_url: 'https://example.test/review' });
    const b = await repo.create(review, { github_node_id: 'NODE', state: 'pending', body: 'original', github_url: 'https://example.test/review' });
    const draft = await repo.upsertForSubmission(review, { github_node_id: 'NODE', state: 'pending', body: 'ignored', github_url: null });
    expect(draft.id).toBe(b.id);
    expect(draft.body).toBe('original');
    expect(draft.github_url).toBe('https://example.test/review');
    await repo.upsertForSubmission(review, { github_node_id: 'NODE', state: 'submitted', event: 'APPROVE', submitted_at: '2026-01-04' });
    expect((await repo.getById(a.id)).state).toBe('submitted');
    expect((await repo.findByReviewId(review))).toHaveLength(2);
  });

  it('upgrades a real v55 database through v57 and publishes every legacy duplicate immediately', async () => {
    db.close();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const sql of Object.values(v55.SCHEMA_SQL)) db.exec(sql);
    for (const sql of v55.INDEX_SQL) db.exec(sql);
    db.pragma('user_version = 55');
    const review = seedTestReview(db);
    db.prepare(`INSERT INTO github_reviews (id, review_id, github_node_id, state) VALUES
      (1, ?, 'NODE', 'pending'), (2, ?, 'NODE', 'pending')`).run(review, review);
    db.prepare(`INSERT INTO comments (id, review_id, source, status, body) VALUES
      (1, ?, 'user', 'draft', 'draft user'), (2, ?, 'ai', 'draft', 'draft AI'),
      (3, ?, 'user', 'inactive', 'dismissed')`).run(review, review, review);
    // Exercise the real startup CREATE IF NOT EXISTS loop before migrations.
    setupSchema(db);
    expect(db.prepare('SELECT status FROM comments ORDER BY id').all().map(c => c.status)).toEqual(['active', 'submitted', 'inactive']);
    // Link one legacy posting to each duplicate before Approve.
    db.prepare('UPDATE comment_postings SET github_review_row_id = 1 WHERE comment_id = 1').run();
    const repo = new GitHubReviewRepository(db);
    await repo.upsertForSubmission(review, { github_node_id: 'NODE', state: 'submitted', event: 'APPROVE' });
    const commentRepo = new CommentRepository(db);
    expect((await commentRepo.getComment(1)).publication.state).toBe('posted');
    expect((await commentRepo.getComment(2)).publication.state).toBe('posted');
    MIGRATIONS[57](db);
    expect(db.prepare('SELECT COUNT(*) n FROM comment_postings').get().n).toBe(2);
  });


  it('pins SQL pending predicate to the frontend mirror across lifecycle/publication combinations', async () => {
    const reviewId = seedTestReview(db);
    const github = await new GitHubReviewRepository(db).create(reviewId, { state: 'pending' });
    let id = 0;
    for (const status of ['active', 'inactive', 'submitted', 'adopted', 'dismissed']) {
      for (const publication of ['none', 'draft', 'posted', 'unknown']) {
        id++;
        db.prepare('INSERT INTO comments (id, review_id, source, body, status) VALUES (?, ?, \'user\', \'body\', ?)').run(id, reviewId, status);
        if (publication !== 'none') {
          const row = publication === 'draft' ? github : publication === 'unknown' ? null : await new GitHubReviewRepository(db).create(reviewId, { state: 'dismissed' });
          await new CommentPostingRepository(db).insertMany([{ comment_id: id, github_review_row_id: row?.id, body: 'snapshot' }]);
        }
      }
    }
    const repo = new CommentRepository(db);
    const js = [];
    for (let i = 1; i <= id; i++) if (isPendingComment(await repo.getComment(i))) js.push({ id: i });
    expect(db.prepare(`SELECT id FROM comments c WHERE ${CommentRepository.pendingCommentSql()} ORDER BY id`).all()).toEqual(js);
    expect(js).toEqual([{ id: 1 }]);
  });

  it('cascades comment deletion and retains history when a GitHub row is deleted', async () => {
    const review = await seedTestReview(db);
    const github = await new GitHubReviewRepository(db).create(review);
    db.prepare(`INSERT INTO comments (id, review_id, source, body) VALUES (1, ?, 'user', 'body')`).run(review);
    const postings = new CommentPostingRepository(db);
    await postings.insertMany([{ comment_id: 1, github_review_row_id: github.id, body: 'sent' }]);
    db.prepare('DELETE FROM github_reviews WHERE id = ?').run(github.id);
    expect((await postings.listByComment(1))[0].github_review_row_id).toBeNull();
    db.prepare('DELETE FROM comments WHERE id = 1').run();
    expect(await postings.listByComment(1)).toEqual([]);
  });
});
