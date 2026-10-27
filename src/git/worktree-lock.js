// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs');
const path = require('node:path');

// Resolve existing ancestors too: the same checkout key must survive removal
// of its leaf directory (including /var -> /private/var on macOS).
function canonicalPath(value) {
  const absolute = path.resolve(value);
  try { return fs.realpathSync(absolute); } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
  }
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Checkout reservations shared by processes using the same database.
 *
 * A reservation has no timeout: owner disappearance does not acknowledge its
 * Git subprocesses. Only its holder releases it after the operation settles.
 */
class WorktreeLockManager {
  constructor(db) {
    this.db = db;
  }

  _findLock(worktreePath, { repository, prNumber } = {}) {
    const checkout = worktreePath ? canonicalPath(worktreePath) : null;
    return this.db.prepare('SELECT * FROM worktree_locks').all().find(lock =>
      checkout && (containsPath(lock.path, checkout) || containsPath(checkout, lock.path))
      || repository && prNumber != null && lock.repository?.toLowerCase() === repository.toLowerCase() && lock.pr_number === prNumber);
  }

  acquire(worktreePath, holderId, identity = {}) {
    const checkout = canonicalPath(worktreePath);
    return this.db.transaction(() => {
      const existing = this._findLock(checkout, identity);
      if (existing) return existing.path === checkout && existing.holder_id === holderId;
      this.db.prepare(`INSERT INTO worktree_locks (path, holder_id, repository, pr_number, locked_at)
        VALUES (?, ?, ?, ?, ?)`).run(checkout, holderId, identity.repository ?? null, identity.prNumber ?? null, new Date().toISOString());
      return true;
    }).immediate();
  }

  release(worktreePath, holderId) {
    return this.db.prepare('DELETE FROM worktree_locks WHERE path = ? AND holder_id = ?')
      .run(canonicalPath(worktreePath), holderId).changes === 1;
  }

  isLocked(worktreePath, identity) {
    const existing = this._findLock(worktreePath, identity);
    return existing ? { locked: true, holderId: existing.holder_id } : { locked: false };
  }
}

module.exports = { WorktreeLockManager, canonicalPath };
