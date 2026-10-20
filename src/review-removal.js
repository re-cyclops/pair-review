// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const activity = require('./analysis-activity');
const { backgroundQueue } = require('./ai/background-queue');
const { WorktreeLockManager, canonicalPath } = require('./git/worktree-lock');

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const containsPath = (parent, child) => {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function assertReviewIdle(db, reviewId) {
  if (activity.reviewInProgress(db, reviewId)) {
    throw conflict('Analysis is active or its termination is unconfirmed. Cancel explicitly and wait for acknowledgement before removing local history or its checkout.');
  }
  if (db.prepare("SELECT 1 FROM chat_sessions WHERE review_id = ? AND status = 'active' LIMIT 1").get(reviewId)) {
    throw conflict('Close the active chat before removing local history or its checkout.');
  }
  if (backgroundQueue.hasUnsettledForReview(reviewId)) {
    throw conflict('Background work is still queued or running. Wait for it to finish before removing local history or its checkout.');
  }
  if (db.prepare("SELECT 1 FROM submission_attempts WHERE review_id = ? AND state NOT IN ('submitted', 'superseded') LIMIT 1").get(reviewId)) {
    throw conflict('Resolve the pending submission before removing local history or its checkout.');
  }
}

function reviewsForWorktree(db, record) {
  return db.prepare(`SELECT r.id, r.review_type, r.repository, r.pr_number, r.local_path, w.path AS worktree_path FROM reviews r LEFT JOIN worktrees w
    ON r.review_type = 'pr' AND w.repository = r.repository COLLATE NOCASE AND w.pr_number = r.pr_number`).all()
    .filter(review => review.id === record.current_review_id || (review.review_type === 'local'
      ? review.local_path && containsPath(record.path, review.local_path)
      : review.repository.toLowerCase() === record.repository.toLowerCase() && review.pr_number === (record.pr_number ?? record.current_pr_number)
        || review.worktree_path && containsPath(record.path, review.worktree_path)));
}

function assertCheckoutAvailable(db, checkout, identity) {
  if (new WorktreeLockManager(db).isLocked(checkout, identity).locked) {
    throw conflict('Checkout removal is active or unconfirmed. No new work was started.');
  }
}

function assertReviewAvailable(db, reviewId) {
  const review = db.prepare(`SELECT r.local_path, r.repository, r.pr_number, w.path FROM reviews r LEFT JOIN worktrees w
    ON r.review_type = 'pr' AND w.repository = r.repository COLLATE NOCASE AND w.pr_number = r.pr_number WHERE r.id = ?`).get(reviewId);
  if (!review) throw Object.assign(new Error('Review no longer exists; no new work was started'), { statusCode: 404 });
  assertCheckoutAvailable(db, review.local_path || review.path, {
    repository: review.repository, prNumber: review.pr_number
  });
}

async function withWorktreeRemoval(db, record, operation) {
  const checkout = canonicalPath(record.path);
  const holder = `remove:${randomUUID()}`;
  const locks = new WorktreeLockManager(db);
  db.transaction(() => {
    if (!locks.acquire(checkout, holder, {
      repository: record.repository, prNumber: record.pr_number ?? record.current_pr_number
    })) throw conflict('Checkout removal is active or unconfirmed. Nothing was removed.');
    const pool = db.prepare('SELECT status, current_review_id FROM worktree_pool WHERE id = ?').get(record.id);
    if (pool && ['creating', 'switching'].includes(pool.status)) throw conflict(`The pool checkout is ${pool.status}. Nothing was removed.`);
    for (const review of reviewsForWorktree(db, { ...record, current_review_id: pool?.current_review_id ?? record.current_review_id })) assertReviewIdle(db, review.id);
  }).immediate();
  try {
    return await operation();
  } finally {
    locks.release(checkout, holder);
  }
}

function sharedCheckout(db, record) {
  return db.prepare('SELECT id, path FROM worktrees WHERE id != ?').all(record.id)
    .some(other => containsPath(record.path, other.path) || containsPath(other.path, record.path))
    || db.prepare("SELECT local_path FROM reviews WHERE review_type = 'local'").all()
      .some(review => review.local_path && (containsPath(record.path, review.local_path) || containsPath(review.local_path, record.path)));
}

module.exports = { assertCheckoutAvailable, assertReviewAvailable, assertReviewIdle, conflict, sharedCheckout, withWorktreeRemoval };
