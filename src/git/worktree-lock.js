// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const preparation = new AsyncLocalStorage();
const currentPreparation = db => {
  const owner = preparation.getStore();
  return owner?.active && owner.db === db ? owner : null;
};

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

  _findLock(worktreePath, { repository, prNumber } = {}, excludeHolder = null) {
    const checkout = worktreePath ? canonicalPath(worktreePath) : null;
    return this.db.prepare('SELECT * FROM worktree_locks').all().find(lock => lock.holder_id !== excludeHolder && (
      checkout && (containsPath(lock.path, checkout) || containsPath(checkout, lock.path))
      || repository && prNumber != null && lock.repository?.toLowerCase() === repository.toLowerCase() && lock.pr_number === prNumber));
  }

  acquire(worktreePath, holderId, identity = {}) {
    const checkout = canonicalPath(worktreePath);
    const owner = currentPreparation(this.db)?.holderId || holderId;
    return this.db.transaction(() => {
      if (this._findLock(checkout, identity, owner)) return false;
      const existing = this.db.prepare('SELECT holder_id FROM worktree_locks WHERE path = ?').get(checkout);
      if (existing) return existing.holder_id === owner;
      this.db.prepare(`INSERT INTO worktree_locks (path, holder_id, repository, pr_number, locked_at)
        VALUES (?, ?, ?, ?, ?)`).run(checkout, owner, identity.repository ?? null, identity.prNumber ?? null, new Date().toISOString());
      return true;
    }).immediate();
  }

  release(worktreePath, holderId) {
    return this.db.prepare('DELETE FROM worktree_locks WHERE path = ? AND holder_id = ?')
      .run(canonicalPath(worktreePath), holderId).changes === 1;
  }

  isLocked(worktreePath, identity) {
    const existing = this._findLock(worktreePath, identity, currentPreparation(this.db)?.holderId);
    return existing ? { locked: true, holderId: existing.holder_id } : { locked: false };
  }

  // Nested checkout/pool operations share this owner; only the complete
  // preparation releases it, after its immutable snapshot and metadata exist.
  async withReservation(worktreePath, identity, operation) {
    const parent = currentPreparation(this.db);
    if (parent) {
      if (!this.acquire(worktreePath, parent.holderId, identity)) throw Object.assign(new Error('Worktree is in use by another operation'), { statusCode: 409 });
      return operation(() => {});
    }
    const holderId = `prepare:${randomUUID()}`;
    if (!this.acquire(worktreePath, holderId, identity)) throw Object.assign(new Error('Worktree is in use by another operation'), { statusCode: 409 });
    const owner = { db: this.db, holderId, active: true };
    const release = () => {
      if (!owner.active) return;
      owner.active = false;
      this.db.prepare('DELETE FROM worktree_locks WHERE holder_id = ?').run(holderId);
    };
    try { return await preparation.run(owner, () => operation(release)); }
    finally { release(); }
  }
}

module.exports = { WorktreeLockManager, canonicalPath };
