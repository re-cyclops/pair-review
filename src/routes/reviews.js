// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unified Review Comment Routes
 *
 * Provides a single set of comment CRUD endpoints under /api/reviews/:reviewId/comments
 * that work for both PR mode and Local mode. This replaces the previously separate
 * comment routes in comments.js (PR mode) and local.js (Local mode).
 */

const express = require('express');
const { query, queryOne, run, withTransaction, CommentRepository, ReviewRepository, AnalysisRunRepository, HunkSummaryRepository, TourRepository } = require('../database');
const { calculateStats, getStatsQuery, getDraftStateQuery } = require('../utils/stats-calculator');
const { activeAnalyses, reviewToAnalysisId } = require('./shared');
const logger = require('../utils/logger');
const { broadcastReviewEvent } = require('../events/review-events');
const { backgroundQueue } = require('../ai/background-queue');
const { ensureContextFileForComment } = require('../utils/auto-context');
const path = require('path');
const fs = require('fs').promises;
const simpleGit = require('simple-git');
const { GitWorktreeManager } = require('../git/worktree');
const { normalizeRepository } = require('../utils/paths');
const { resolveFormat, formatAdoptedComment: formatComment } = require('../utils/comment-formatter');
const { safeParseJson } = require('../utils/safe-parse-json');
const { resolveOriginalFileContentSpecs } = require('../utils/diff-file-content');
const validateReviewId = require('./middleware/validate-review-id');
const { reviewScope, scopeIncludes, includesBranch } = require('../local-scope');
const { findMergeBase } = require('../local-review');
const submission = require('../review-submission');
const { GitHubClient } = require('../github/client');
const { PRArgumentParser } = require('../github/parser');
const { resolveReviewBinding } = require('../utils/host-resolution');
const reviewProgress = require('../review-progress');

const router = express.Router();

// Cached metadata only: opening the inbox or command palette never prepares a worktree.
router.get('/api/reviews/recent', (req, res) => {
  const db = req.app.get('db');
  const decode = value => safeParseJson(Buffer.from(String(value), 'base64url').toString());
  const valid = cursor => cursor && Number.isFinite(cursor.at) && Number.isInteger(cursor.id);
  const before = req.query.before ? decode(req.query.before) : { at: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
  const through = req.query.through && req.query.through !== 'end' ? decode(req.query.through) : null;
  if (!valid(before) || req.query.through && req.query.through !== 'end' && !valid(through)) return res.status(400).json({ error: 'Invalid review cursor' });
  const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 200)));
  const rows = db.prepare(`SELECT r.id, r.repository, r.pr_number, r.review_type, r.name, r.updated_at, r.local_head_sha,
      p.title, p.host, p.pr_data, MAX(COALESCE(julianday(p.last_accessed_at), 0), julianday(r.updated_at)) AS touched,
      d.draft_count, d.has_summary, json_extract(r.review_progress, '$.reviewed.head') AS last_reviewed_head,
      (SELECT activity_state FROM analysis_runs a WHERE a.review_id = r.id AND a.parent_run_id IS NULL ORDER BY julianday(a.started_at) DESC, a.rowid DESC LIMIT 1) AS activity
    FROM reviews r LEFT JOIN pr_metadata p ON p.repository = r.repository COLLATE NOCASE AND p.pr_number = r.pr_number
    JOIN (${getDraftStateQuery()}) d ON d.review_id = r.id
    WHERE touched < ? OR (touched = ? AND r.id < ?) ORDER BY touched DESC, r.id DESC LIMIT ?`).all(before.at, before.at, before.id, limit + 1);
  const hasMore = rows.length > limit;
  const reviews = rows.slice(0, limit).map(row => {
    const pr = safeParseJson(row.pr_data) || {};
    const local = row.review_type === 'local';
    return { id: row.id, reviewType: row.review_type, repository: local ? path.basename(row.repository) : row.repository,
      number: row.pr_number, title: row.title || row.name || path.basename(row.repository),
      headSha: local ? row.local_head_sha : pr.head_sha || null, host: row.host || null,
      draftCount: row.draft_count, hasDraftSummary: Boolean(row.has_summary),
      lastReviewedHead: row.last_reviewed_head || null,
      updatedAt: row.updated_at, activity: safeParseJson(row.activity),
      url: local ? `/local/${row.id}` : `/pr/${row.repository.split('/').map(encodeURIComponent).join('/')}/${row.pr_number}${row.host ? `?host=${encodeURIComponent(row.host)}` : ''}` };
  });
  const last = rows[Math.min(rows.length, limit) - 1];
  // A refresh can walk to the previously loaded boundary, even if its last
  // record was deleted or moved to the front. Each response remains bounded.
  const covered = !hasMore || !!(through && last && (last.touched < through.at || last.touched === through.at && last.id <= through.id));
  res.json({ reviews, hasMore, covered, next: hasMore ? Buffer.from(JSON.stringify({ at: last.touched, id: last.id })).toString('base64url') : null });
});

router.get('/api/reviews/:reviewId/progress', validateReviewId, async (req, res) => {
  try { res.json(await reviewProgress.getProgress(req.app.get('db'), req.reviewId)); }
  catch (error) { submissionError(res, error); }
});

router.put('/api/reviews/:reviewId/progress', validateReviewId, async (req, res) => {
  try {
    res.json(await reviewProgress.updateProgress(req.app.get('db'), req.reviewId, req.body));
    broadcastReviewEvent(req.reviewId, { type: 'review:progress_changed' }, { sourceClientId: req.get('X-Client-ID') });
  } catch (error) { submissionError(res, error); }
});

router.get('/api/reviews/:reviewId/changes-since-reviewed', validateReviewId, async (req, res) => {
  try { res.json(await reviewProgress.compareReviewed(req.app.get('db'), req.reviewId, req.query.token)); }
  catch (error) { submissionError(res, error); }
});

async function submissionContext(req, recorded = null) {
  const db = req.app.get('db');
  const config = req.app.get('config') || {};
  const review = req.review;
  const associated = recorded || (review.review_type === 'local' ? safeParseJson(review.associated_pr) : null);
  if (review.review_type === 'local' && !associated) return { db, config, reviewId: review.id };
  const repository = associated?.repository || review.repository;
  const [owner, repo] = repository.split('/');
  const prNumber = associated?.number || review.pr_number;
  const resolved = await resolveReviewBinding({ db, config, repository, prNumber,
    recordedTarget: associated ? { host: associated.host === 'github.com' ? null : associated.host, recordedUrl: associated.url } : undefined,
    fallbackToken: req.app.get('githubToken') });
  return { db, config, reviewId: review.id, target: { owner, repo, prNumber },
    client: resolved ? new GitHubClient(resolved.binding) : null };
}

function submissionError(res, error) {
  const code = error.statusCode || error.status;
  res.status(Number.isInteger(code) && code >= 400 && code <= 599 ? code : 503)
    .json({ error: error.message, manifest: error.manifest, receipt: error.receipt });
}

router.get('/api/reviews/:reviewId/manifest', validateReviewId, async (req, res) => {
  try {
    const localOnly = req.query.local === 'true';
    const context = localOnly ? { db: req.app.get('db'), config: req.app.get('config') || {}, reviewId: req.reviewId, localOnly } : await submissionContext(req);
    res.json(await submission.buildSubmissionManifest({ ...context, mode: req.query.mode || 'submit' }));
  } catch (error) { submissionError(res, error); }
});

router.post('/api/reviews/:reviewId/submit', validateReviewId, async (req, res) => {
  try {
    const context = await submissionContext(req);
    const result = await submission.publishSubmission({ ...context, mode: req.body.mode || 'submit' }, req.body.digest);
    res.status(['submitted', 'draft_saved'].includes(result.state) ? 200 : 409).json({ receipt: result });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' });
  } catch (error) { submissionError(res, error); }
});

router.get('/api/reviews/:reviewId/submissions', validateReviewId, (req, res) => {
  res.json({ receipts: submission.listReceipts(req.app.get('db'), req.reviewId) });
});

router.post('/api/reviews/:reviewId/submissions/:attemptId/reconcile', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');
    const existing = submission.receipt(db, req.params.attemptId);
    if (!existing || existing.reviewId !== req.reviewId) return res.status(404).json({ error: 'Submission receipt not found' });
    const context = await submissionContext(req, existing.manifest.target);
    if (!context.client) return res.status(401).json({ error: 'Authentication is unavailable; the receipt is preserved' });
    const result = await submission.reconcileSubmission({ db, client: context.client, attemptId: existing.id });
    res.json({ receipt: result });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' });
  } catch (error) { submissionError(res, error); }
});

router.put('/api/reviews/:reviewId/association', validateReviewId, async (req, res) => {
  try {
    if (req.review.review_type !== 'local') return res.status(400).json({ error: 'Only local reviews need a PR association' });
    const db = req.app.get('db');
    if (submission.listReceipts(db, req.reviewId).some(item => !['submitted', 'superseded'].includes(item.state))) return res.status(409).json({ error: 'Resolve this review’s submission receipt before changing its target' });
    if (!Number.isInteger(req.body.expected_revision)) return res.status(428).json({ error: 'Expected draft revision required' });
    let association = null;
    if (req.body.url !== null) {
      let url;
      try { url = new URL(req.body.url); } catch { return res.status(400).json({ error: 'Use a valid pull-request URL' }); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return res.status(400).json({ error: 'Use a supported HTTP(S) pull-request URL without credentials' });
      const parsed = new PRArgumentParser(req.app.get('config') || {}).parsePRUrl(url.href);
      if (!parsed) return res.status(400).json({ error: 'Unsupported pull-request URL' });
      association = { repository: `${parsed.owner}/${parsed.repo}`, number: parsed.number, host: parsed.host ?? null, url: url.href };
      const context = await submissionContext(req, association);
      if (!context.client) return res.status(401).json({ error: 'Authentication unavailable for the selected host' });
      const pr = await context.client.fetchPullRequest(parsed.owner, parsed.repo, parsed.number);
      association = { ...association, host: context.client.binding.host || null, url: pr.html_url };
    }
    const changed = db.prepare(`UPDATE reviews SET associated_pr = ?, draft_revision = draft_revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND draft_revision = ? AND NOT EXISTS (
        SELECT 1 FROM submission_attempts WHERE review_id = reviews.id AND state NOT IN ('submitted', 'superseded'))`)
      .run(association ? JSON.stringify(association) : null, req.reviewId, req.body.expected_revision);
    if (!changed.changes) return res.status(409).json({ error: 'The review changed while its target was being checked. Reload before associating it.' });
    res.json({ association, draft: db.prepare('SELECT id, draft_body AS body, draft_event AS event, draft_revision AS revision FROM reviews WHERE id = ?').get(req.reviewId) });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' });
  } catch (error) { submissionError(res, error); }
});

router.put('/api/reviews/:reviewId/comments/:id/anchor', validateReviewId, async (req, res) => {
  try {
    const context = await submissionContext(req);
    const comment = await submission.reanchorDraft(context, { ...req.body, commentId: Number(req.params.id) });
    res.json({ comment });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) { submissionError(res, error); }
});


/**
 * Resolve the worktree path and base_sha for a PR-mode review.
 * Returns { worktreePath, baseSha } or throws with { status, error } on failure.
 */
async function resolveWorktreeForReview(review, db) {
  const prNumber = review.pr_number;
  const repository = review.repository;

  if (!prNumber || !repository) {
    const err = new Error('Review missing PR metadata');
    err.statusCode = 400;
    throw err;
  }

  const [owner, repo] = repository.split('/');
  const worktreeManager = new GitWorktreeManager(db);

  if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
    const err = new Error('Worktree not found for this PR. The PR may need to be reloaded.');
    err.statusCode = 404;
    throw err;
  }

  const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

  // Load cached PR metadata so callers can resolve exact diff blobs.
  const normalizedRepo = normalizeRepository(owner, repo);
  const prRecord = await queryOne(db, `
    SELECT pr_data FROM pr_metadata
    WHERE pr_number = ? AND repository = ? COLLATE NOCASE
  `, [prNumber, normalizedRepo]);

  const prData = safeParseJson(prRecord?.pr_data, null);
  if (prRecord?.pr_data && !prData) {
    logger.warn('Could not parse pr_data for review');
  }

  return { worktreePath, prData };
}

/**
 * GET /api/reviews/:reviewId/comments
 * Get all comments for a review.
 * Query params:
 *   - includeDismissed: if 'true', includes dismissed (inactive) comments
 */
router.get('/api/reviews/:reviewId/comments', validateReviewId, async (req, res) => {
  try {
    const { includeDismissed } = req.query;
    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    const comments = await commentRepo.getUserComments(req.reviewId, {
      includeDismissed: includeDismissed === 'true'
    });

    res.json({
      success: true,
      comments: comments || []
    });
  } catch (error) {
    logger.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

/**
 * POST /api/reviews/:reviewId/comments
 * Create a new comment. If line_start is present, creates a line-level comment;
 * otherwise creates a file-level comment.
 */
router.post('/api/reviews/:reviewId/comments', validateReviewId, async (req, res) => {
  try {
    const { file, line_start, line_end, diff_position, side, commit_sha, body, parent_id, type, title, draft_key, included } = req.body;

    if (typeof file !== 'string' || !file || typeof body !== 'string') {
      return res.status(400).json({
        error: 'Missing required fields: file, body'
      });
    }

    if (draft_key !== undefined && (typeof draft_key !== 'string' || !draft_key || draft_key.length > 128)) {
      return res.status(400).json({ error: 'Invalid draft identity' });
    }
    if (included !== undefined && typeof included !== 'boolean') return res.status(400).json({ error: 'Inclusion must be a boolean' });
    if (line_start != null && (!Number.isInteger(line_start) || line_start < 1) ||
        line_end != null && (!Number.isInteger(line_end) || line_end < (line_start || 1))) {
      return res.status(400).json({ error: 'Comment line range is invalid' });
    }
    if (!body.trim()) {
      return res.status(400).json({
        error: 'Comment body cannot be empty or whitespace only'
      });
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    let commentId;

    if (line_start) {
      // Line-level comment
      commentId = await commentRepo.createLineComment({
        review_id: req.reviewId,
        file,
        line_start,
        line_end,
        diff_position,
        side,
        commit_sha,
        body,
        draft_key,
        included,
        parent_id,
        type,
        title
      });
    } else {
      // File-level comment
      commentId = await commentRepo.createFileComment({
        review_id: req.reviewId,
        file,
        body,
        draft_key,
        included,
        commit_sha,
        type,
        title,
        parent_id
      });
    }

    res.json({
      success: true,
      commentId,
      comment: await commentRepo.getComment(commentId, 'user'),
      message: line_start ? 'Comment saved successfully' : 'File-level comment saved successfully'
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });

    // Fire-and-forget: auto-add context file for comments on files outside the diff
    try {
      const result = await ensureContextFileForComment(db, req.review, { file, line_start, line_end });
      if (result.created || result.expanded) {
        broadcastReviewEvent(req.reviewId, { type: 'review:context_files_changed' });
      }
    } catch (err) {
      logger.warn(`[AutoContext] Failed: ${err.message}`);
    }
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code, current: error.current });
    logger.error('Error creating comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to create comment'
    });
  }
});

/**
 * GET /api/reviews/:reviewId/comments/:id
 * Get a single comment, verifying it belongs to the review.
 */
router.get('/api/reviews/:reviewId/comments/:id', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    const comment = await commentRepo.getComment(id, 'user');

    if (!comment) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    if (comment.review_id !== req.reviewId) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    res.json(comment);
  } catch (error) {
    logger.error('Error fetching comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch comment'
    });
  }
});

/**
 * PUT /api/reviews/:reviewId/comments/:id
 * Update a comment, verifying it belongs to the review.
 */
router.put('/api/reviews/:reviewId/comments/:id', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const { body, included, expected_revision, draft_key } = req.body;

    if (body !== undefined && (typeof body !== 'string' || !body.trim())) {
      return res.status(400).json({
        error: 'Comment body cannot be empty'
      });
    }
    if ((body === undefined && included === undefined) || (included !== undefined && typeof included !== 'boolean')) {
      return res.status(400).json({ error: 'Provide comment text or a boolean inclusion choice' });
    }

    const db = req.app.get('db');

    // Verify the comment exists and belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [id, req.reviewId]);

    if (!comment) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    const commentRepo = new CommentRepository(db);
    const updated = await commentRepo.updateComment(id, { body, included, expected_revision, draft_key });

    res.json({
      success: true,
      comment: updated,
      message: 'Comment updated successfully'
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code, current: error.current });
    logger.error('Error updating comment:', error);

    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({
      error: error.message || 'Failed to update comment'
    });
  }
});

// Unlike dismissal, deletion clears local draft text and cannot be restored.
// Keep the identity tombstone so a late create/save cannot resurrect it.
router.delete('/api/reviews/:reviewId/comments/:id/draft', validateReviewId, (req, res) => {
  const db = req.app.get('db');
  const { expected_revision, draft_key } = req.body || {};
  if (!Number.isInteger(expected_revision) || typeof draft_key !== 'string') return res.status(428).json({ error: 'Draft identity and expected revision required' });
  try {
    db.transaction(() => {
      const current = db.prepare("SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'").get(req.params.id, req.reviewId);
      if (!current) throw Object.assign(new Error('Draft not found'), { statusCode: 404 });
      const result = db.prepare(`UPDATE comments SET body = '', deleted_at = CURRENT_TIMESTAMP, included = 0, status = 'inactive'
        WHERE id = ? AND draft_key = ? AND revision = ? AND deleted_at IS NULL AND status != 'submitted'`).run(current.id, draft_key, expected_revision);
      if (!result.changes) throw new Error('Draft changed or is already submitted/deleted');
      if (current.parent_id) db.prepare("UPDATE comments SET status = 'dismissed', adopted_as_id = NULL WHERE id = ? AND adopted_as_id = ?").run(current.parent_id, current.id);
    })();
    res.json({ success: true });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    res.status(error.statusCode || 409).json({ error: error.message, current: db.prepare('SELECT * FROM comments WHERE id = ? AND review_id = ?').get(req.params.id, req.reviewId) });
  }
});

router.get('/api/reviews/:reviewId/draft', validateReviewId, (req, res) => {
  res.json(req.app.get('db').prepare('SELECT id, draft_body AS body, draft_event AS event, draft_revision AS revision FROM reviews WHERE id = ?').get(req.reviewId));
});

router.put('/api/reviews/:reviewId/draft', validateReviewId, (req, res) => {
  const { body, event, expected_revision } = req.body;
  if (typeof body !== 'string' || !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) return res.status(400).json({ error: 'Invalid review body or decision' });
  if (!Number.isInteger(expected_revision)) return res.status(428).json({ error: 'Expected draft revision required' });
  const db = req.app.get('db');
  const outcome = db.transaction(() => {
    const result = db.prepare('UPDATE reviews SET draft_body = ?, draft_event = ? WHERE id = ? AND draft_revision = ?').run(body, event, req.reviewId, expected_revision);
    const current = db.prepare('SELECT id, draft_body AS body, draft_event AS event, draft_revision AS revision FROM reviews WHERE id = ?').get(req.reviewId);
    return { updated: result.changes > 0, current };
  })();
  if (!outcome.updated) return res.status(409).json({ error: 'Review body or decision changed in another editor', current: outcome.current });
  res.json(outcome.current);
  broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
});

/**
 * DELETE /api/reviews/:reviewId/comments/:id
 * Soft-delete a comment, verifying it belongs to the review.
 * If the comment was adopted from an AI suggestion, the parent suggestion
 * is automatically transitioned to 'dismissed' state.
 */
router.delete('/api/reviews/:reviewId/comments/:id', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.get('db');

    // Verify the comment exists and belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [id, req.reviewId]);

    if (!comment) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    const commentRepo = new CommentRepository(db);
    const result = await commentRepo.deleteComment(id);

    res.json({
      success: true,
      message: 'Comment deleted successfully',
      dismissedSuggestionId: result.dismissedSuggestionId
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
    if (result.dismissedSuggestionId) {
      broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });
    }
  } catch (error) {
    logger.error('Error deleting comment:', error);

    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({
      error: error.message || 'Failed to delete comment'
    });
  }
});

/**
 * PUT /api/reviews/:reviewId/comments/:id/restore
 * Restore a dismissed (inactive) comment, verifying it belongs to the review.
 */
router.put('/api/reviews/:reviewId/comments/:id/restore', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const commentId = parseInt(id, 10);

    if (isNaN(commentId)) {
      return res.status(400).json({ error: 'Invalid comment ID' });
    }

    const db = req.app.get('db');

    // Verify the comment exists and belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [commentId, req.reviewId]);

    if (!comment) {
      return res.status(404).json({ error: 'User comment not found' });
    }

    if (comment.deleted_at) return res.status(410).json({ error: 'This draft was deleted, not dismissed' });
    if (comment.status !== 'inactive') {
      return res.status(400).json({ error: 'Comment is not dismissed' });
    }

    const commentRepo = new CommentRepository(db);
    await commentRepo.restoreComment(commentId);

    // Get the restored comment to return
    const restoredComment = await commentRepo.getComment(commentId, 'user');

    res.json({
      success: true,
      message: 'Comment restored successfully',
      comment: restoredComment
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
  } catch (error) {
    logger.error('Error restoring comment:', error);

    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message && error.message.includes('not dismissed')) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({
      error: error.message || 'Failed to restore comment'
    });
  }
});

/**
 * DELETE /api/reviews/:reviewId/comments
 * Bulk delete all user comments for a review.
 * Also dismisses any AI suggestions that were parents of the deleted comments.
 */
router.delete('/api/reviews/:reviewId/comments', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');

    // Begin transaction to ensure atomicity
    await run(db, 'BEGIN TRANSACTION');

    try {
      const commentRepo = new CommentRepository(db);
      const result = await commentRepo.bulkDeleteComments(req.reviewId);

      await run(db, 'COMMIT');

      res.json({
        success: true,
        deletedCount: result.deletedCount,
        dismissedSuggestionIds: result.dismissedSuggestionIds,
        message: `Deleted ${result.deletedCount} user comment${result.deletedCount !== 1 ? 's' : ''}`
      });
      broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });
      if (result.dismissedSuggestionIds.length > 0) {
        broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });
      }
    } catch (transactionError) {
      await run(db, 'ROLLBACK');
      throw transactionError;
    }
  } catch (error) {
    logger.error('Error deleting comments:', error);
    res.status(500).json({
      error: error.message || 'Failed to delete comments'
    });
  }
});

// ==========================================================================
// AI Suggestion Routes
// ==========================================================================

/**
 * GET /api/reviews/:reviewId/suggestions/check
 * Check whether AI suggestions exist for a review and return summary stats.
 * Query params:
 *   - runId: specific analysis run ID. Default: latest run
 */
router.get('/api/reviews/:reviewId/suggestions/check', validateReviewId, async (req, res) => {
  try {
    const { runId } = req.query;
    const db = req.app.get('db');
    const reviewId = req.reviewId;

    // Check if any AI suggestions exist for this review
    // Exclude raw council voice suggestions (is_raw=1) — only count final/consolidated suggestions
    const result = await queryOne(db, `
      SELECT EXISTS(
        SELECT 1 FROM comments
        WHERE review_id = ? AND source = 'ai' AND (is_raw = 0 OR is_raw IS NULL)
      ) as has_suggestions
    `, [reviewId]);

    const hasSuggestions = result?.has_suggestions === 1;

    // Check if any analysis has been run using analysis_runs table
    let analysisHasRun = hasSuggestions;
    const analysisRunRepo = new AnalysisRunRepository(db);
    let selectedRun = null;
    try {
      // If runId is provided, fetch that specific run; otherwise get the latest
      if (runId) {
        selectedRun = await analysisRunRepo.getById(runId);
      } else {
        selectedRun = await analysisRunRepo.getLatestByReviewId(reviewId);
      }
      analysisHasRun = !!(selectedRun || hasSuggestions);
    } catch (e) {
      logger.debug('analysis_runs query failed, falling back to hasSuggestions:', e.message);
      analysisHasRun = hasSuggestions;
    }

    // Get AI summary from the selected analysis run if available, otherwise fall back to review summary
    const summary = selectedRun?.summary || req.review?.summary || null;

    // Get stats for AI suggestions (issues/suggestions/praise for final level only)
    // Filter by runId if provided, otherwise use the latest analysis run
    let stats = { issues: 0, suggestions: 0, praise: 0 };
    if (hasSuggestions) {
      try {
        const statsQuery = getStatsQuery(runId);
        const statsResult = await query(db, statsQuery.query, statsQuery.params(reviewId));
        stats = calculateStats(statsResult);
      } catch (e) {
        logger.warn('Error fetching AI suggestion stats:', e);
      }
    }

    res.json({
      hasSuggestions: hasSuggestions,
      analysisHasRun: analysisHasRun,
      summary: summary,
      stats: stats
    });
  } catch (error) {
    logger.error('Error checking for AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to check for AI suggestions'
    });
  }
});

/**
 * GET /api/reviews/:reviewId/suggestions
 * Get AI suggestions for a review.
 * Query params:
 *   - levels: comma-separated list of levels (e.g., 'final,1,2'). Default: 'final'
 *   - runId: specific analysis run ID. Default: latest run
 *   - allRuns: when 'true', return suggestions from all analysis runs instead of only the latest
 *   - excludeRunId: when used with allRuns=true, exclude suggestions from specific run ID(s). Supports comma-separated values (e.g., 'id1,id2')
 */
router.get('/api/reviews/:reviewId/suggestions', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');
    const reviewId = req.reviewId;

    // Parse levels query parameter (e.g., ?levels=final,1,2)
    // Default to 'final' (orchestrated suggestions only) if not specified
    const levelsParam = req.query.levels || 'final';
    const requestedLevels = levelsParam.split(',').map(l => l.trim());

    // Parse optional runId query parameter to fetch suggestions from a specific analysis run
    // If not provided, defaults to the latest run
    const runIdParam = req.query.runId;

    // Parse allRuns flag — when true, skip the "latest run only" filter
    const allRuns = req.query.allRuns === 'true';

    // Parse optional excludeRunId — when used with allRuns=true, exclude suggestions from these runs
    // Supports comma-separated values for excluding multiple run IDs (e.g., excludeRunId=id1,id2)
    const excludeRunIds = req.query.excludeRunId ? req.query.excludeRunId.split(',').filter(Boolean) : [];

    // Build level filter clause
    const levelConditions = [];
    requestedLevels.forEach(level => {
      if (level === 'final') {
        levelConditions.push('ai_level IS NULL');
      } else if (['1', '2', '3'].includes(level)) {
        levelConditions.push(`ai_level = ${parseInt(level)}`);
      }
    });

    // If no valid levels specified, default to final
    const levelFilter = levelConditions.length > 0
      ? `(${levelConditions.join(' OR ')})`
      : 'ai_level IS NULL';

    // Build the run ID filter clause
    // allRuns=true skips run filtering entirely — return suggestions from all runs
    // runId param targets a specific run
    // Default: subquery for the latest run only
    let runIdFilter;
    let queryParams;
    if (allRuns) {
      if (excludeRunIds.length > 0) {
        // Return suggestions from all runs except the excluded ones
        runIdFilter = `ai_run_id NOT IN (${excludeRunIds.map(() => '?').join(', ')})`;
        queryParams = [reviewId, ...excludeRunIds];
      } else {
        // No run ID filter — return suggestions from all analysis runs
        runIdFilter = '1 = 1';
        queryParams = [reviewId];
      }
    } else if (runIdParam) {
      runIdFilter = 'ai_run_id = ?';
      queryParams = [reviewId, runIdParam];
    } else {
      // Get AI suggestions from the comments table
      // Only return suggestions from the latest analysis run (ai_run_id)
      // This preserves history while showing only the most recent results
      //
      // Note: If no AI suggestions exist (subquery returns NULL), the ai_run_id = NULL
      // comparison returns no rows. This is intentional - we only show suggestions
      // when there's a matching analysis run.
      //
      // Note: reviewId is passed twice because SQLite requires separate parameters
      // for the outer WHERE clause and the subquery. A CTE could consolidate this but
      // adds complexity without meaningful benefit here.
      runIdFilter = `ai_run_id = (
          SELECT ai_run_id FROM comments
          WHERE review_id = ? AND source = 'ai' AND ai_run_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        )`;
      queryParams = [reviewId, reviewId];
    }

    const statusFilter = "status IN ('active', 'dismissed', 'adopted', 'draft', 'submitted')";

    const rows = await query(db, `
      SELECT
        id,
        source,
        author,
        ai_run_id,
        COALESCE(commit_sha, (SELECT head_sha FROM analysis_runs WHERE id = comments.ai_run_id)) AS analyzed_head,
        ai_level,
        ai_confidence,
        file,
        line_start,
        line_end,
        side,
        type,
        title,
        body,
        suggestion_text,
        reasoning,
        status,
        status_reason,
        is_file_level,
        severity,
        created_at,
        updated_at
      FROM comments
      WHERE review_id = ?
        AND source = 'ai'
        AND ${levelFilter}
        AND ${statusFilter}
        AND (is_raw = 0 OR is_raw IS NULL)
        AND ${runIdFilter}
      ORDER BY
        CASE
          WHEN ai_level IS NULL THEN 0
          WHEN ai_level = 1 THEN 1
          WHEN ai_level = 2 THEN 2
          WHEN ai_level = 3 THEN 3
          ELSE 4
        END,
        is_file_level DESC,
        file,
        line_start
    `, queryParams);

    // Resolve format config once for all suggestions
    const config = req.app.get('config') || {};
    const formatConfig = resolveFormat(config.comment_format);
    const revision = await queryOne(db, `SELECT CASE WHEN r.review_type = 'local' THEN r.local_head_sha
      WHEN json_valid(p.pr_data) THEN json_extract(p.pr_data, '$.head_sha') END AS head
      FROM reviews r LEFT JOIN pr_metadata p ON p.repository = r.repository COLLATE NOCASE AND p.pr_number = r.pr_number
      WHERE r.id = ?`, [reviewId]);

    const suggestions = rows.map(row => {
      const formattedBody = formatComment({
        body: row.body,
        suggestionText: row.suggestion_text,
        category: row.type,
        title: row.title,
        severity: row.severity
      }, formatConfig);

      return {
        ...row,
        revision: reviewProgress.revisionState(row.analyzed_head, revision?.head),
        reasoning: safeParseJson(row.reasoning),
        formattedBody
      };
    });

    res.json({ suggestions });

  } catch (error) {
    logger.error('Error fetching AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to fetch AI suggestions'
    });
  }
});

/**
 * POST /api/reviews/:reviewId/suggestions/:id/status
 * Update AI suggestion status (dismiss/restore).
 * Note: "adopted" is not allowed here — use the /edit endpoint instead.
 */
router.post('/api/reviews/:reviewId/suggestions/:id/status', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!['dismissed', 'active'].includes(status)) {
      if (status === 'adopted') {
        return res.status(400).json({
          error: 'Cannot set status to \'adopted\' directly. Use POST /suggestions/:id/adopt for adopt-as-is or POST /suggestions/:id/edit for adopt-with-edits.'
        });
      }
      return res.status(400).json({
        error: 'Invalid status. Must be "dismissed" or "active"'
      });
    }

    // A dismissal reason is only meaningful when dismissing. Reject it on restore
    // so callers can't silently attach a reason that would immediately be cleared.
    if (reason !== undefined && reason !== null && status !== 'dismissed') {
      return res.status(400).json({
        error: 'A reason may only be provided when status is "dismissed"'
      });
    }

    // Normalize the reason: coerce to string, trim, enforce max length, empty → null.
    const MAX_REASON_LENGTH = 2000;
    let normalizedReason = null;
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== 'string') {
        return res.status(400).json({ error: 'Reason must be a string' });
      }
      const trimmed = reason.trim();
      if (trimmed.length > MAX_REASON_LENGTH) {
        return res.status(400).json({
          error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer`
        });
      }
      normalizedReason = trimmed || null;
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Get the suggestion
    const suggestion = await commentRepo.getComment(id, 'ai');

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    // Verify suggestion belongs to this review
    if (suggestion.review_id !== req.reviewId) {
      return res.status(403).json({
        error: 'Suggestion does not belong to this review'
      });
    }

    // Update suggestion status using repository. Restoring to 'active' clears any
    // stored reason inside updateSuggestionStatus, so status_reason is always null then.
    await commentRepo.updateSuggestionStatus(id, status, null, normalizedReason);

    res.json({
      success: true,
      status,
      status_reason: status === 'dismissed' ? normalizedReason : null
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });

  } catch (error) {
    logger.error('Error updating suggestion status:', error);
    res.status(500).json({
      error: error.message || 'Failed to update suggestion status'
    });
  }
});

/**
 * POST /api/reviews/:reviewId/suggestions/:id/adopt
 * Adopt an AI suggestion as-is as a user comment.
 *
 * Atomically:
 *  1. Reads the suggestion from the DB
 *  2. Creates a user comment from the suggestion's body/type/title (with category prefix)
 *  3. Sets parent_id linkage on the new comment
 *  4. Sets suggestion status to 'adopted' in the DB
 *  5. Returns the new userCommentId
 *
 * Why this exists: adoption must create a linked user comment via parent_id,
 * which is why raw status-setting via POST /suggestions/:id/status cannot do it.
 * Use this endpoint for adopt-as-is; use POST /suggestions/:id/edit for adopt-with-edits.
 */
router.post('/api/reviews/:reviewId/suggestions/:id/adopt', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Get the suggestion to validate it exists
    const suggestion = await commentRepo.getComment(id, 'ai');

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    // Verify suggestion belongs to this review
    if (suggestion.review_id !== req.reviewId) {
      return res.status(403).json({
        error: 'Suggestion does not belong to this review'
      });
    }

    // Only active suggestions can be adopted
    if (suggestion.status !== 'active') {
      return res.status(400).json({
        error: suggestion.status === 'adopted'
          ? 'Suggestion has already been adopted'
          : `Cannot adopt suggestion with status '${suggestion.status}'. Restore it to active first.`
      });
    }

    // Format the body with category prefix using configurable formatter
    const config = req.app.get('config') || {};
    const formatConfig = resolveFormat(config.comment_format);
    const formattedBody = formatComment({
      body: suggestion.body,
      suggestionText: suggestion.suggestion_text,
      category: suggestion.type,
      title: suggestion.title,
      severity: suggestion.severity
    }, formatConfig);

    // Atomically adopt: create user comment and update suggestion status in one transaction
    const userCommentId = await withTransaction(db, async () => {
      const ucId = await commentRepo.adoptSuggestion(id, formattedBody);
      await commentRepo.updateSuggestionStatus(id, 'adopted', ucId);
      return ucId;
    });

    res.json({
      success: true,
      userCommentId,
      formattedBody,
      message: 'Suggestion adopted as user comment'
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });

  } catch (error) {
    logger.error('Error adopting suggestion:', error);
    res.status(500).json({
      error: error.message || 'Failed to adopt suggestion'
    });
  }
});

/**
 * POST /api/reviews/:reviewId/suggestions/:id/edit
 * Edit AI suggestion and adopt as user comment.
 */
router.post('/api/reviews/:reviewId/suggestions/:id/edit', validateReviewId, async (req, res) => {
  try {
    const { id } = req.params;
    const { editedText, action, draft } = req.body;

    if (action !== 'adopt_edited') {
      return res.status(400).json({
        error: 'Invalid action. Must be "adopt_edited"'
      });
    }

    if (typeof editedText !== 'string' || !editedText.trim()) {
      return res.status(400).json({
        error: 'Edited text cannot be empty'
      });
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Get the suggestion to validate it exists
    const suggestion = await commentRepo.getComment(id, 'ai');

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    // Verify suggestion belongs to this review
    if (suggestion.review_id !== req.reviewId) {
      return res.status(403).json({
        error: 'Suggestion does not belong to this review'
      });
    }

    // The user already edited the fully formatted text, so store it verbatim
    const formattedBody = editedText;

    // Atomically adopt: create user comment and update suggestion status in one transaction
    const userCommentId = await withTransaction(db, async () => {
      const ucId = await commentRepo.adoptSuggestion(id, formattedBody, draft);
      await commentRepo.updateSuggestionStatus(id, 'adopted', ucId);
      return ucId;
    });

    res.json({
      success: true,
      userCommentId,
      formattedBody,
      comment: await commentRepo.getComment(userCommentId, 'user'),
      message: 'Suggestion edited and adopted as user comment'
    });
    broadcastReviewEvent(req.reviewId, { type: 'review:suggestions_changed' }, { sourceClientId: req.get('X-Client-Id') });
    broadcastReviewEvent(req.reviewId, { type: 'review:comments_changed' }, { sourceClientId: req.get('X-Client-Id') });

  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code, current: error.current });
    logger.error('Error editing suggestion:', error);
    res.status(500).json({
      error: error.message || 'Failed to edit suggestion'
    });
  }
});

// ==========================================================================
// Analysis Status Route
// ==========================================================================

/**
 * GET /api/reviews/:reviewId/analyses/status
 * Check if an analysis is running for a given review.
 * Replaces both:
 *   - GET /api/pr/:owner/:repo/:number/analysis-status
 *   - GET /api/local/:reviewId/analysis-status
 */
router.get('/api/reviews/:reviewId/analyses/status', validateReviewId, async (req, res) => {
  try {
    const reviewId = req.reviewId;

    // 1. Check unified in-memory map
    const analysisId = reviewToAnalysisId.get(reviewId);

    if (analysisId) {
      const analysis = activeAnalyses.get(analysisId);

      if (analysis) {
        return res.json({
          running: true,
          analysisId,
          status: analysis
        });
      }

      // Clean up stale mapping
      reviewToAnalysisId.delete(reviewId);
    }

    // 2. Fall back to database — an analysis may have been started externally (e.g. via MCP)
    const db = req.app.get('db');
    const analysisRunRepo = new AnalysisRunRepository(db);
    const latestRun = await analysisRunRepo.getLatestByReviewId(reviewId);

    if (latestRun && latestRun.status === 'running') {
      return res.json({
        running: true,
        analysisId: latestRun.id,
        status: {
          id: latestRun.id,
          reviewId,
          status: 'running',
          startedAt: latestRun.started_at,
          progress: 'Analysis in progress...',
          levels: {
            1: { status: 'running', progress: 'Running...' },
            2: { status: 'running', progress: 'Running...' },
            3: { status: 'running', progress: 'Running...' },
            4: { status: 'pending', progress: 'Pending' }
          },
          filesAnalyzed: latestRun.files_analyzed || 0,
          filesRemaining: 0
        }
      });
    }

    // 3. Not running
    res.json({
      running: false,
      analysisId: null,
      status: null
    });

  } catch (error) {
    logger.error('Error checking review analysis status:', error);
    res.status(500).json({
      error: 'Failed to check analysis status'
    });
  }
});

// ==========================================================================
// Hunk Expansion Route
// ==========================================================================

/**
 * POST /api/reviews/:reviewId/expand-hunk
 * Broadcast a request to expand a hidden hunk in the diff view.
 * This is a transient UI command — no database writes.
 *
 * Body: { file, line_start, line_end, side? }
 *   - file: (string, required) path of the file whose hunk to expand
 *   - line_start: (integer, required) first line to reveal (>= 1)
 *   - line_end: (integer, required) last line to reveal (>= line_start)
 *   - side: ('left' | 'right', optional, default 'right')
 */
router.post('/api/reviews/:reviewId/expand-hunk', validateReviewId, async (req, res) => {
  try {
    const { file, line_start, line_end, side } = req.body;

    // --- validation ---
    if (!file || typeof file !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid required field: file' });
    }

    if (!Number.isInteger(line_start) || line_start < 1) {
      return res.status(400).json({ error: 'Missing or invalid required field: line_start (must be a positive integer)' });
    }

    if (!Number.isInteger(line_end) || line_end < line_start) {
      return res.status(400).json({ error: 'Missing or invalid required field: line_end (must be an integer >= line_start)' });
    }

    const resolvedSide = side || 'right';
    if (!['left', 'right'].includes(resolvedSide)) {
      return res.status(400).json({ error: 'Invalid value for side: must be "left" or "right"' });
    }

    // --- broadcast ---
    broadcastReviewEvent(req.reviewId, {
      type: 'review:expand_hunk',
      file,
      line_start,
      line_end,
      side: resolvedSide
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting expand-hunk event:', error);
    res.status(500).json({ error: 'Failed to broadcast expand-hunk event' });
  }
});

/**
 * GET /api/reviews/:reviewId/file-content/:fileName(*)
 * Fetch file content for context expansion and context files.
 * Replaces the legacy /api/file-content-original/ endpoint by using
 * the review record to determine local vs PR mode.
 */
router.get('/api/reviews/:reviewId/file-content/:fileName(*)', validateReviewId, async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);
    const review = req.review;
    const db = req.app.get('db');

    // Local mode: use local_path + local_head_sha
    if (review.review_type === 'local' || review.local_path) {
      const localPath = review.local_path;
      if (!localPath) {
        return res.status(404).json({ error: 'Local review missing path' });
      }

      const localHeadSha = review.local_head_sha;

      // Try git show for HEAD version (correct line numbers for diff)
      if (localHeadSha) {
        try {
          const git = simpleGit(localPath);
          const content = await git.show([`${localHeadSha}:${fileName}`]);
          const lines = content.split('\n');
          return res.json({ fileName, lines, totalLines: lines.length });
        } catch (gitError) {
          logger.debug(`Could not read file ${fileName} from HEAD: ${gitError.message}, falling back to working directory`);
        }
      }

      // Fallback: read from filesystem
      const filePath = path.join(localPath, fileName);
      try {
        const realFilePath = await fs.realpath(filePath);
        const realLocalPath = await fs.realpath(localPath);
        if (!realFilePath.startsWith(realLocalPath + path.sep) && realFilePath !== realLocalPath) {
          return res.status(403).json({ error: 'Access denied: path outside repository' });
        }
        const content = await fs.readFile(realFilePath, 'utf8');
        const lines = content.split('\n');
        return res.json({ fileName, lines, totalLines: lines.length });
      } catch (fileError) {
        if (fileError.code === 'ENOENT') {
          return res.status(404).json({ error: 'File not found in local repository' });
        } else if (fileError.code === 'EISDIR') {
          return res.status(400).json({ error: 'Path is a directory, not a file' });
        }
        throw fileError;
      }
    }

    // PR mode: use pr_number + repository to find worktree
    const prNumber = review.pr_number;
    const repository = review.repository;

    if (!prNumber || !repository) {
      return res.status(400).json({ error: 'Review missing PR metadata' });
    }

    const [owner, repo] = repository.split('/');
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({ error: 'Worktree not found for this PR. The PR may need to be reloaded.' });
    }

    // Prefer the exact blob from the cached diff snapshot. If that is unavailable,
    // fall back to repo-wide base_sha and finally the worktree filesystem.
    const normalizedRepo = normalizeRepository(owner, repo);
    const prRecord = await queryOne(db, `
      SELECT pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, normalizedRepo]);

    const prData = safeParseJson(prRecord?.pr_data, null);
    if (prRecord?.pr_data && !prData) {
      logger.warn('Could not parse pr_data for file-content route');
    }

    const contentSpecs = resolveOriginalFileContentSpecs(prData, fileName);

    if (contentSpecs.length > 0) {
      try {
        const git = simpleGit(worktreePath);
        for (const contentSpec of contentSpecs) {
          try {
            const content = await git.show([contentSpec.gitSpec]);
            const lines = content.split('\n');
            return res.json({ fileName, lines, totalLines: lines.length });
          } catch (gitError) {
            logger.debug(`Could not read file ${fileName} from ${contentSpec.source}: ${gitError.message}`);
          }
        }
      } catch (gitError) {
        logger.debug(`Could not initialize git for ${worktreePath}: ${gitError.message}`);
      }
    }

    // Fallback: read from filesystem
    const filePath = path.join(worktreePath, fileName);
    try {
      const realFilePath = await fs.realpath(filePath);
      const realWorktreePath = await fs.realpath(worktreePath);
      if (!realFilePath.startsWith(realWorktreePath + path.sep) && realFilePath !== realWorktreePath) {
        return res.status(403).json({ error: 'Access denied: path outside repository' });
      }
      const content = await fs.readFile(realFilePath, 'utf8');
      const lines = content.split('\n');
      return res.json({ fileName, lines, totalLines: lines.length });
    } catch (fileError) {
      if (fileError.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found in worktree' });
      } else if (fileError.code === 'EISDIR') {
        return res.status(400).json({ error: 'Path is a directory, not a file' });
      }
      throw fileError;
    }
  } catch (error) {
    logger.error('Error retrieving file content:', error);
    res.status(500).json({ error: 'Internal server error while retrieving file content' });
  }
});

// ==========================================================================
// Hunk Summaries Route
// ==========================================================================

/**
 * GET /api/reviews/:reviewId/hunk-summaries
 * Get all hunk summaries for a review (PR or Local).
 * Returns trivial-marker rows alongside generated summaries; the frontend filters.
 */
router.get('/api/reviews/:reviewId/hunk-summaries', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');
    const repo = new HunkSummaryRepository(db);
    const rows = await repo.getByReview(req.reviewId);
    // `generating` reflects whether the background queue is still working
    // on this review's summaries; the frontend uses it to show a "generating"
    // pulse on the toolbar toggle until `review:background_job_finished`
    // fires for jobType=`summaries:*`.
    const generating = backgroundQueue.hasActiveForReview(req.reviewId, 'summaries');
    res.json({
      summaries: rows.map((row) => ({
        file_path: row.file_path,
        content_hash: row.content_hash,
        summary_text: row.summary_text,
        trivial_reason: row.trivial_reason
      })),
      generating
    });
  } catch (error) {
    logger.error('Error fetching hunk summaries:', error);
    res.status(500).json({ error: 'Failed to fetch hunk summaries' });
  }
});

// ==========================================================================
// Tour Route
// ==========================================================================

/**
 * GET /api/reviews/:reviewId/tour
 * Get the persisted guided tour for a review (PR or Local).
 * Returns `{tour: null}` when no tour has been generated yet, otherwise
 * returns `{tour: {stops, diff_hash, stale, generating, provider, model, created_at}}`.
 *
 * `stale` is true when a `tour` job is currently in flight for this review,
 * meaning the persisted tour may be about to be replaced. `generating` is
 * true when there is no persisted tour yet but a job is in flight.
 */
router.get('/api/reviews/:reviewId/tour', validateReviewId, async (req, res) => {
  try {
    const db = req.app.get('db');
    const repo = new TourRepository(db);
    const row = await repo.get(req.reviewId);
    const generating = backgroundQueue.hasActiveForReview(req.reviewId, 'tour');

    if (!row) {
      return res.json({ tour: null, generating });
    }

    let stops;
    try {
      stops = JSON.parse(row.stops);
    } catch (err) {
      logger.warn(`Failed to parse tour.stops for review ${req.reviewId}: ${err.message}`);
      return res.status(500).json({ error: 'Tour data corrupt' });
    }

    res.json({
      tour: {
        stops,
        diff_hash: row.diff_hash,
        stale: generating,
        provider: row.provider,
        model: row.model,
        created_at: row.created_at
      },
      generating
    });
  } catch (error) {
    logger.error('Error fetching tour:', error);
    res.status(500).json({ error: 'Failed to fetch tour' });
  }
});

// ==========================================================================
// Background Job Cancellation
// ==========================================================================

// Only these prefixes are user-cancellable. We deliberately do NOT accept
// arbitrary jobKeys — that would let the UI cancel internal jobs we don't
// want to be cancellable from the toolbar (e.g. future scheduling work).
const CANCELLABLE_JOB_PREFIXES = new Set(['tour', 'summaries']);

/**
 * POST /api/reviews/:reviewId/jobs/:jobKey/cancel
 *
 * Cancel an in-flight background job (tour or summaries) for this review.
 * Aborts the per-job `AbortSignal`, which kills the upstream CLI child
 * process so we stop burning tokens immediately.
 *
 * Works for BOTH Local mode (`/local/:reviewId`) and PR mode (`/pr/...`)
 * because both modes write into the same `reviews` table and dispatch
 * jobs through the same `backgroundQueue` keyed by reviewId. The
 * separate `/api/local/...` cancel route below shares this handler so
 * the contract stays in one place.
 *
 * Request:
 *   - `jobKey` path param: bare prefix (`tour` | `summaries`) or full
 *     job key suffix (`summaries:<digest>`). Bare prefix cancels ALL
 *     matching variants — what the toolbar actually wants.
 *
 * Responses:
 *   - 200 `{ cancelled: true, count: N }`  - aborted N job(s)
 *   - 404 `{ cancelled: false }`           - nothing in flight
 *   - 400                                  - invalid jobKey
 */
async function handleJobCancel(req, res) {
  const rawKey = String(req.params.jobKey || '').trim();
  // Strip whitespace; reject if empty, contains slashes/control chars, or
  // does not start with an allow-listed prefix. We deliberately do NOT
  // accept arbitrary keys — see CANCELLABLE_JOB_PREFIXES comment.
  if (!rawKey || /[/\\\s]/.test(rawKey)) {
    return res.status(400).json({ error: 'Invalid jobKey' });
  }
  const prefix = rawKey.includes(':') ? rawKey.slice(0, rawKey.indexOf(':')) : rawKey;
  if (!CANCELLABLE_JOB_PREFIXES.has(prefix)) {
    return res.status(400).json({ error: `jobKey "${prefix}" is not cancellable` });
  }

  const { cancelled } = backgroundQueue.cancel(req.reviewId, rawKey);
  if (cancelled === 0) {
    logger.info(`Cancel request for ${req.reviewId}:${rawKey} matched no in-flight job`);
    return res.status(404).json({ cancelled: false });
  }
  logger.info(`Cancelled ${cancelled} background job(s) for ${req.reviewId}:${rawKey}`);
  res.json({ cancelled: true, count: cancelled });
}

router.post('/api/reviews/:reviewId/jobs/:jobKey/cancel', validateReviewId, handleJobCancel);

/**
 * GET /api/reviews/:reviewId/file-contents/:fileName(*)
 * Fetch old and new file contents for hunk expansion in @pierre/diffs.
 * Returns { fileName, oldContents, newContents } with string values (or null).
 */
const MAX_FILE_CONTENTS_SIZE = 2 * 1024 * 1024; // 2MB

router.get('/api/reviews/:reviewId/file-contents/:fileName(*)', validateReviewId, async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);
    const { status, oldPath } = req.query;
    const review = req.review;
    const db = req.app.get('db');

    // Validate fileName
    if (fileName.includes('\0')) {
      return res.status(400).json({ error: 'Invalid file name' });
    }

    const oldFilePath = oldPath || fileName;

    /**
     * Helper: read content via git show, return string or null on failure.
     */
    async function gitShow(repoPath, ref) {
      try {
        const git = simpleGit(repoPath);
        return await git.show([ref]);
      } catch {
        return null;
      }
    }

    /**
     * Helper: read file from filesystem with traversal guard.
     * Returns string or null on failure.
     */
    async function readFromFs(basePath, relPath) {
      const filePath = path.join(basePath, relPath);
      try {
        const realFilePath = await fs.realpath(filePath);
        const realBasePath = await fs.realpath(basePath);
        if (!realFilePath.startsWith(realBasePath + path.sep) && realFilePath !== realBasePath) {
          return null;
        }
        return await fs.readFile(realFilePath, 'utf8');
      } catch {
        return null;
      }
    }

    /**
     * Helper: check for binary content (null bytes) and size limits.
     * Returns a response object if content should be rejected, or null if OK.
     */
    function checkContent(oldContents, newContents) {
      const hasBinary = (s) => s != null && s.includes('\0');
      if (hasBinary(oldContents) || hasBinary(newContents)) {
        return { binary: true, oldContents: null, newContents: null };
      }
      const tooLarge = (s) => s != null && Buffer.byteLength(s, 'utf8') > MAX_FILE_CONTENTS_SIZE;
      if (tooLarge(oldContents) || tooLarge(newContents)) {
        return { tooLarge: true, oldContents: null, newContents: null };
      }
      return null;
    }

    let oldContents = null;
    let newContents = null;

    // --- Local mode ---
    if (review.review_type === 'local' || review.local_path) {
      const localPath = review.local_path;
      if (!localPath) {
        return res.status(404).json({ error: 'Local review missing path' });
      }

      // Determine old-side git ref based on scope
      const { start, end } = reviewScope(review);

      if (status !== 'added') {
        if (includesBranch(start)) {
          if (!review.local_base_branch) {
            // No base branch configured — old side unavailable
            oldContents = null;
          } else {
            try {
              const mergeBaseSha = await findMergeBase(localPath, review.local_base_branch);
              oldContents = await gitShow(localPath, `${mergeBaseSha}:${oldFilePath}`);
            } catch (mbError) {
              logger.warn(`Could not find merge-base for old file: ${mbError.message}`);
              oldContents = null;
            }
          }
        } else if (scopeIncludes(start, end, 'staged')) {
          // Staged is in scope but not branch — old is HEAD
          oldContents = await gitShow(localPath, `HEAD:${oldFilePath}`);
        } else {
          // Unstaged only — old is the index (staged version)
          oldContents = await gitShow(localPath, `:${oldFilePath}`);
        }
      }

      if (status !== 'deleted') {
        // New file: always from filesystem
        newContents = await readFromFs(localPath, fileName);
      }

      const rejection = checkContent(oldContents, newContents);
      if (rejection) return res.json({ fileName, ...rejection });

      return res.json({ fileName, oldContents, newContents });
    }

    // --- PR mode ---
    let worktreePath, prData;
    try {
      ({ worktreePath, prData } = await resolveWorktreeForReview(review, db));
    } catch (resolveErr) {
      return res.status(resolveErr.statusCode || 500).json({ error: resolveErr.message });
    }

    if (status !== 'added') {
      // Prefer the exact blob from the cached diff snapshot; fall back to base_sha.
      // Matches the /file-content endpoint so both stay consistent with stale PR metadata.
      const contentSpecs = resolveOriginalFileContentSpecs(prData, oldFilePath);
      for (const contentSpec of contentSpecs) {
        const content = await gitShow(worktreePath, contentSpec.gitSpec);
        if (content != null) {
          oldContents = content;
          break;
        }
        logger.debug(`Could not read old file ${oldFilePath} from ${contentSpec.source}`);
      }
    }

    if (status !== 'deleted') {
      newContents = await gitShow(worktreePath, `HEAD:${fileName}`);
    }

    const rejection = checkContent(oldContents, newContents);
    if (rejection) return res.json({ fileName, ...rejection });

    return res.json({ fileName, oldContents, newContents });
  } catch (error) {
    logger.error('Error retrieving file contents:', error);
    res.status(500).json({ error: 'Internal server error while retrieving file contents' });
  }
});

module.exports = router;
module.exports.handleJobCancel = handleJobCancel;
module.exports.CANCELLABLE_JOB_PREFIXES = CANCELLABLE_JOB_PREFIXES;
