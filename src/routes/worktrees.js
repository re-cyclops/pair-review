// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Worktree Management Routes
 *
 * Handles all worktree-related endpoints:
 * - Creating worktrees from PR URLs
 * - Getting recent worktrees
 * - Deleting worktrees
 */

const express = require('express');
const { query, queryOne, run, ReviewRepository, WorktreeRepository, WorktreePoolRepository, RepoSettingsRepository } = require('../database');
const { setupPRReview } = require('../setup/pr-setup');
const { GitHubApiError } = require('../github/client');
const { GitWorktreeManager } = require('../git/worktree');
const { assertReviewIdle, conflict, sharedCheckout, withWorktreeRemoval } = require('../review-removal');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { resolvePoolConfig } = require('../config');
const { resolveRepoLinks } = require('../links/repo-links');
const {
  resolveRecordedHost,
  resolveBindingRepositoryForHost,
  setupHostParam
} = require('../utils/host-resolution');

const router = express.Router();

/**
 * Create worktree from PR URL (for web UI start review)
 * Creates worktree, fetches PR data from GitHub, stores in database
 */
router.post('/api/worktrees/create', async (req, res) => {
  try {
    const { owner, repo, prNumber } = req.body;

    // Validate required parameters
    if (!owner || !repo || !prNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: owner, repo, prNumber'
      });
    }

    const parsedPrNumber = parseInt(prNumber, 10);
    if (isNaN(parsedPrNumber) || parsedPrNumber <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pull request number'
      });
    }

    const db = req.app.get('db');
    const config = req.app.get('config');

    // Validate GitHub token. Pass the owner/repo so alt-host repos
    // resolve their own per-repo token.
    const { getGitHubToken } = require('../config');
    const githubToken = getGitHubToken(config, `${owner}/${repo}`);
    if (!githubToken) {
      return res.status(500).json({
        success: false,
        error: 'GitHub token not configured. Please set github_token in ~/.pair-review/config.json'
      });
    }

    logger.section(`Web UI Start Review - PR #${parsedPrNumber}`);

    const { reviewUrl, title } = await setupPRReview({
      db,
      owner,
      repo,
      prNumber: parsedPrNumber,
      githubToken,
      config,
      poolLifecycle: req.app.get('poolLifecycle'),
      onProgress: (progress) => {
        logger.info(`[Setup] ${progress.step}: ${progress.message}`);
      }
    });

    logger.success(`Review ready at ${reviewUrl}`);

    res.json({
      success: true,
      reviewUrl,
      prNumber: parsedPrNumber,
      repository: `${owner}/${repo}`,
      title
    });

  } catch (error) {
    logger.error('Error creating worktree from web UI:', error);

    // GitHubApiError carries a numeric HTTP status from the GitHub client,
    // so we can route errors precisely without fragile string matching.
    if (error instanceof GitHubApiError) {
      const statusCode = error.status;
      if (statusCode === 401 || statusCode === 403) {
        return res.status(401).json({
          success: false,
          error: 'GitHub authentication failed. Please check your token.'
        });
      } else if (statusCode === 429) {
        return res.status(429).json({
          success: false,
          error: 'GitHub API rate limit exceeded. Please try again later.'
        });
      } else if (statusCode === 503) {
        return res.status(503).json({
          success: false,
          error: 'Network error. Please check your internet connection.'
        });
      } else if (statusCode === 404) {
        return res.status(404).json({
          success: false,
          error: error.message
        });
      }
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create worktree'
    });
  }
});

/**
 * Get recently reviewed PRs with cursor-based pagination.
 * Lists from pr_metadata (source of truth) and includes storage status
 * based on whether a local worktree directory exists.
 *
 * Query parameters:
 *   limit  - Number of reviews to return (default 10, max 50)
 *   before - ISO timestamp cursor: return reviews accessed before this time.
 *            For subsequent pages, send the last_accessed_at of the last item
 *            from the previous page. Omit for the initial load.
 *
 * Response includes:
 *   reviews - Array of review objects with storage_status
 *   hasMore - Whether more reviews are available beyond this page
 */
router.get('/api/worktrees/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const before = req.query.before || null;
    const db = req.app.get('db');
    const config = req.app.get('config') || {};

    // Fetch limit + 1 to determine hasMore
    const fetchCount = limit + 1;

    const params = before ? [before, fetchCount] : [fetchCount];
    const rows = await query(db, `
      SELECT
        pm.id,
        pm.repository,
        pm.pr_number,
        pm.title,
        pm.author,
        pm.base_branch,
        pm.head_branch,
        pm.last_accessed_at,
        pm.created_at,
        json_extract(pm.pr_data, '$.html_url') as html_url,
        json_extract(pm.pr_data, '$.head_sha') as head_sha,
        pm.host,
        w.id as worktree_id,
        w.path as worktree_path,
        w.branch,
        (SELECT r.id FROM reviews r WHERE r.pr_number = pm.pr_number AND r.repository = pm.repository COLLATE NOCASE ORDER BY r.updated_at DESC LIMIT 1) as review_id
      FROM pr_metadata pm
      LEFT JOIN worktrees w ON pm.pr_number = w.pr_number AND pm.repository = w.repository COLLATE NOCASE
      WHERE pm.title IS NOT NULL AND pm.title != ''
        ${before ? 'AND pm.last_accessed_at < ?' : ''}
      ORDER BY pm.last_accessed_at DESC
      LIMIT ?
    `, params);

    // Determine storage status for each entry
    const reviews = [];
    for (const row of rows) {
      let storageStatus = 'cached';
      if (row.worktree_path) {
        try {
          await fs.access(row.worktree_path);
          storageStatus = 'local';
        } catch {
          // Worktree dir missing — clean up stale record asynchronously on first page,
          // but only if it's not a pool worktree (pool worktrees are managed separately)
          if (!before) {
            setImmediate(async () => {
              try {
                const poolRepo = new WorktreePoolRepository(db);
                const isPool = await poolRepo.isPoolWorktree(row.worktree_id);
                if (!isPool) {
                  await run(db, 'DELETE FROM worktrees WHERE id = ?', [row.worktree_id]);
                  logger.info(`Cleaned up stale worktree record ${row.worktree_id}`);
                }
              } catch (err) {
                logger.warn(`Failed to cleanup stale worktree: ${err.message}`);
              }
            });
          }
        }
      }
      const [owner, repo] = row.repository.split('/');
      // Host stamping (schema v50) was never backfilled, so a stored NULL can
      // mean "github.com" OR "recorded before stamping existed".
      // `resolveRecordedHost` upgrades a NULL to the alt host only where the
      // recorded html_url proves it; an unprovable legacy row resolves to
      // `null` (github.com), the stored convention, rather than to a host this
      // row's click would not bind. Links, navigation, and the /pr binding all
      // derive from this one value.
      const host = resolveRecordedHost(
        config,
        resolveBindingRepositoryForHost(owner, repo, config, undefined),
        row.host,
        row.html_url
      );
      // With the host settled, resolve links and navigation from it through the
      // same helpers the setup route uses, so the row's icon and its click
      // cannot reach different systems. /pr's applyHostQueryCorrection also
      // stamps the value on the way through, healing the legacy NULL.
      const bindingRepository = resolveBindingRepositoryForHost(owner, repo, config, host);
      const repoLinks = resolveRepoLinks(config, bindingRepository, host);
      const setupHost = setupHostParam(config, owner, repo, host);
      reviews.push({
        id: row.id,
        repository: row.repository,
        pr_number: row.pr_number,
        pr_title: row.title,
        author: row.author || null,
        head_branch: row.head_branch || row.branch || null,
        base_branch: row.base_branch || null,
        last_accessed_at: row.last_accessed_at,
        created_at: row.created_at,
        storage_status: storageStatus,
        html_url: row.html_url || null,
        head_sha: row.head_sha || null,
        host: host,
        setup_host: setupHost,
        repo_links: repoLinks,
        review_id: row.review_id || null
      });
    }

    // Take the first `limit` results; anything beyond means hasMore
    const hasMore = reviews.length > limit;
    const pageReviews = hasMore ? reviews.slice(0, limit) : reviews;

    res.json({
      success: true,
      reviews: pageReviews,
      hasMore
    });

  } catch (error) {
    logger.error('Error fetching recent reviews:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent reviews'
    });
  }
});

/**
 * Delete a single review by pr_metadata ID.
 * Cleans up: worktree directory, worktree record, comments, reviews, and pr_metadata.
 *
 * @param {object} db - Database handle
 * @param {number} metadataId - pr_metadata.id
 * @param {import('../git/worktree-pool-lifecycle').WorktreePoolLifecycle} [poolLifecycle] - Pool lifecycle manager (optional)
 * @returns {{ success: boolean, message: string }}
 * @throws {Error} if deletion fails
 */
async function deleteReviewById(db, metadataId, poolLifecycle, config = {}) {
  const metadata = await queryOne(db, "SELECT *, json_extract(pr_data, '$.html_url') AS html_url FROM pr_metadata WHERE id = ?", [metadataId]);
  if (!metadata) return { success: false, message: 'Review not found' };
  const { pr_number: prNumber, repository } = metadata;
  const worktree = await queryOne(db, `
    SELECT * FROM worktrees WHERE pr_number = ? AND repository = ? COLLATE NOCASE
  `, [prNumber, repository]);
  const poolRepo = poolLifecycle?.poolRepo || new WorktreePoolRepository(db);
  const pool = worktree ? await poolRepo.getPoolEntry(worktree.id) : null;
  if (pool && ['creating', 'switching'].includes(pool.status)) {
    throw conflict('The pool checkout is being prepared. Wait for that operation to finish; nothing was removed.');
  }
  if (pool && poolLifecycle?.getActiveAnalyses(worktree.id).size) {
    throw conflict('The pool checkout is still in use. Cancel analysis explicitly and wait for acknowledgement; nothing was removed.');
  }
  if (pool && !poolLifecycle) throw conflict('The pool owner is unavailable. Nothing was removed.');

  const removeHistory = db.transaction(() => {
    const reviews = db.prepare('SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE').all(prNumber, repository);
    for (const review of reviews) assertReviewIdle(db, review.id);
    // Cascade from the review only after every guard passes. In particular, do
    // not erase active chat rows before checking whether the review is idle.
    db.prepare('DELETE FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE').run(prNumber, repository);
    db.prepare('DELETE FROM pr_metadata WHERE id = ?').run(metadataId);
    const parts = repository.split('/');
    if (parts.length === 2) {
      const host = resolveRecordedHost(config, resolveBindingRepositoryForHost(parts[0], parts[1], config, undefined), metadata.host, metadata.html_url);
      db.prepare('DELETE FROM github_pr_cache WHERE owner = ? AND repo = ? AND number = ? AND host IS ?')
        .run(parts[0], parts[1], prNumber, host ?? null);
    }
  });

  let retainedCheckout = false;
  let warning = null;
  if (!worktree) {
    removeHistory.immediate();
  } else if (!pool && sharedCheckout(db, worktree)) {
    // This review does not own the other recorded reviews' checkout.
    removeHistory.immediate();
    db.prepare('DELETE FROM worktrees WHERE id = ?').run(worktree.id);
    retainedCheckout = true;
  } else {
    await withWorktreeRemoval(db, worktree, async () => {
      const manager = new GitWorktreeManager(db);
      if (!pool) await manager.removeWorktree(worktree.path, { dryRun: true });
      removeHistory.immediate();
      if (pool) {
        await poolLifecycle.releaseForDeletion(worktree.id);
        retainedCheckout = true;
      } else {
        try {
          await manager.removeWorktree(worktree.path);
          db.prepare('DELETE FROM worktrees WHERE id = ?').run(worktree.id);
        } catch (error) {
          retainedCheckout = true;
          warning = `Local history was removed, but the checkout and its registry were retained: ${error.message}`;
          logger.warn(warning);
        }
      }
    });
  }
  logger.success(`Removed local history for ${repository} #${prNumber}`);
  return { success: true, retainedCheckout, warning,
    message: `Local history and drafts for ${repository} #${prNumber} removed. Remote review unchanged.${retainedCheckout ? ' Checkout retained.' : ''}` };
}

/**
 * Delete a review and all associated data.
 * Cleans up: worktree directory, worktree record, comments, reviews, and pr_metadata.
 *
 * :id is the pr_metadata.id (integer primary key)
 */
router.delete('/api/worktrees/:id', async (req, res) => {
  try {
    const metadataId = parseInt(req.params.id, 10);

    if (!metadataId || isNaN(metadataId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const poolLifecycle = req.app.get('poolLifecycle');
    const result = await deleteReviewById(db, metadataId, poolLifecycle, req.app.get('config'));

    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.message
      });
    }

    res.json(result);

  } catch (error) {
    logger.error('Error deleting review:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: 'Failed to delete review: ' + error.message
    });
  }
});

/**
 * Bulk delete reviews by pr_metadata IDs.
 * Accepts { ids: number[] } in request body. Max 50 IDs per request.
 * Each deletion is independent — partial failures are reported per-ID.
 */
router.post('/api/worktrees/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Request body must contain a non-empty "ids" array'
      });
    }

    if (ids.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 50 IDs per request'
      });
    }

    const parsedIds = ids.map(id => parseInt(id, 10));
    if (parsedIds.some(id => isNaN(id) || id <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'All IDs must be positive integers'
      });
    }

    const db = req.app.get('db');
    const poolLifecycle = req.app.get('poolLifecycle');
    let deleted = 0;
    const errors = [];
    const warnings = [];

    for (const id of parsedIds) {
      try {
        const result = await deleteReviewById(db, id, poolLifecycle, req.app.get('config'));
        if (result.success) {
          deleted++;
          if (result.warning) warnings.push({ id, message: result.warning });
        } else {
          errors.push({ id, error: result.message });
        }
      } catch (err) {
        errors.push({ id, error: err.message });
      }
    }

    if (deleted > 0) logger.success(`Bulk deleted ${deleted} review(s)`);

    res.json({
      success: deleted > 0 || errors.length === 0,
      deleted,
      failed: errors.length,
      errors,
      warnings
    });

  } catch (error) {
    logger.error('Error in bulk delete:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process bulk delete: ' + error.message
    });
  }
});


/**
 * List all worktrees for a repository with pool configuration info.
 */
router.get('/api/repos/:owner/:repo/worktrees', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');
    const config = req.app.get('config');

    const worktreeRepo = new WorktreeRepository(db);
    const poolRepo = new WorktreePoolRepository(db);
    const repoSettingsRepo = new RepoSettingsRepository(db);

    const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
    const { poolSize, poolFetchIntervalMinutes: fetchInterval } = resolvePoolConfig(config, repository, repoSettings);

    const [allWorktrees, poolEntries] = await Promise.all([
      worktreeRepo.findAllByRepository(repository),
      poolRepo.findAllForRepo(repository),
    ]);

    const poolMap = new Map(poolEntries.map(p => [p.id, p]));

    const worktrees = await Promise.all(allWorktrees.map(async (wt) => {
      const poolEntry = poolMap.get(wt.id);
      let diskExists = false;
      if (wt.path) {
        try {
          await fs.access(wt.path);
          diskExists = true;
        } catch { /* missing */ }
      }

      return {
        id: wt.id,
        is_pool: !!poolEntry,
        status: poolEntry ? poolEntry.status : 'active',
        pr_number: poolEntry ? poolEntry.current_pr_number : wt.pr_number,
        branch: wt.branch,
        path: wt.path,
        last_fetched_at: poolEntry ? poolEntry.last_fetched_at : null,
        last_accessed_at: wt.last_accessed_at,
        created_at: poolEntry ? poolEntry.created_at : wt.created_at,
        disk_exists: diskExists,
      };
    }));

    // Include pool entries that have no corresponding worktrees record
    // (e.g. 'creating' placeholders)
    for (const poolEntry of poolEntries) {
      if (!allWorktrees.some(wt => wt.id === poolEntry.id)) {
        worktrees.push({
          id: poolEntry.id,
          is_pool: true,
          status: poolEntry.status,
          pr_number: poolEntry.current_pr_number,
          branch: null,
          path: poolEntry.path,
          last_fetched_at: poolEntry.last_fetched_at,
          last_accessed_at: null,
          created_at: poolEntry.created_at,
          disk_exists: false,
        });
      }
    }

    res.json({
      pool: {
        configured: poolSize > 0,
        size: poolSize,
        fetch_interval_minutes: fetchInterval,
        current_count: poolEntries.length,
      },
      worktrees,
    });
  } catch (error) {
    logger.error('Error listing worktrees:', error);
    res.status(500).json({ error: 'Failed to list worktrees: ' + error.message });
  }
});

async function removeRegisteredWorktree(db, record, poolLifecycle) {
  if (sharedCheckout(db, record)) throw conflict('Another recorded checkout or local review shares this directory. Nothing was removed.');
  await withWorktreeRemoval(db, record, async () => {
    if (await new WorktreePoolRepository(db).isPoolWorktree(record.id)) {
      if (!poolLifecycle) throw conflict('The pool owner is unavailable. Nothing was removed.');
      await poolLifecycle.destroyPoolWorktree(record.id);
    } else {
      await new GitWorktreeManager(db).removeWorktree(record.path);
      await new WorktreeRepository(db).delete(record.id);
    }
  });
}

/**
 * Delete a single worktree by ID (pool or non-pool).
 * Removes from disk and database entirely.
 */
router.delete('/api/repos/:owner/:repo/worktrees/:worktreeId', async (req, res) => {
  try {
    const { owner, repo, worktreeId } = req.params;
    const db = req.app.get('db');
    const record = await new WorktreeRepository(db).findById(worktreeId)
      || await new WorktreePoolRepository(db).getPoolEntry(worktreeId);
    if (!record || record.repository.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      return res.status(404).json({ error: 'Worktree not found for this repository' });
    }
    await removeRegisteredWorktree(db, record, req.app.get('poolLifecycle'));
    res.json({ success: true, message: 'Checkout removed. Local review history, drafts, and remote reviews unchanged.' });
  } catch (error) {
    logger.error('Error deleting worktree:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

/**
 * Delete all worktrees for a repository.
 * Removes each from disk and database. Partial failures reported per-ID.
 */
router.delete('/api/repos/:owner/:repo/worktrees', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');
    const poolLifecycle = req.app.get('poolLifecycle');

    const worktreeRepo = new WorktreeRepository(db);
    const poolRepo = new WorktreePoolRepository(db);

    const [allWorktrees, poolEntries] = await Promise.all([
      worktreeRepo.findAllByRepository(repository),
      poolRepo.findAllForRepo(repository),
    ]);

    const records = new Map(poolEntries.map(record => [record.id, { ...record, pr_number: record.current_pr_number }]));
    for (const record of allWorktrees) records.set(record.id, record);
    let deleted = 0;
    const errors = [];
    for (const record of records.values()) {
      try {
        await removeRegisteredWorktree(db, record, poolLifecycle);
        deleted++;
      } catch (error) {
        errors.push({ id: record.id, error: error.message });
      }
    }

    if (deleted > 0) logger.success(`Deleted ${deleted} worktree(s) for ${repository}`);

    res.json({
      success: deleted > 0 || errors.length === 0,
      deleted,
      failed: errors.length,
      errors,
    });
  } catch (error) {
    logger.error('Error deleting all worktrees:', error);
    res.status(500).json({ error: 'Failed to delete worktrees: ' + error.message });
  }
});

module.exports = router;
