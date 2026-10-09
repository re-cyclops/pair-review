// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { WorktreeRepository } = require('../../src/database');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema');

// ============================================================================
// WorktreeRepository.findAllByRepository
// ============================================================================

describe('WorktreeRepository.findAllByRepository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new WorktreeRepository(db);
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  function insertWorktree(id, prNumber, repository, branch = 'feature', path = `/tmp/wt/${id}`) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, prNumber, repository, branch, path, now, now);
  }

  it('returns worktrees for the specified repository', async () => {
    insertWorktree('wt-1', 1, 'owner/repo', 'branch-a');
    insertWorktree('wt-2', 2, 'owner/repo', 'branch-b');
    insertWorktree('wt-3', 3, 'other/repo', 'branch-c');

    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toHaveLength(2);
    const ids = results.map(r => r.id);
    expect(ids).toContain('wt-1');
    expect(ids).toContain('wt-2');
    expect(ids).not.toContain('wt-3');
  });

  it('matches case-insensitively', async () => {
    insertWorktree('wt-1', 1, 'Owner/Repo', 'branch-a');
    insertWorktree('wt-2', 2, 'owner/repo', 'branch-b');

    const results = await repo.findAllByRepository('OWNER/REPO');

    expect(results).toHaveLength(2);
    expect(results.map(r => r.id)).toEqual(expect.arrayContaining(['wt-1', 'wt-2']));
  });

  it('returns empty array when no worktrees exist for the repository', async () => {
    insertWorktree('wt-1', 1, 'other/repo', 'branch-a');

    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toEqual([]);
  });

  it('returns empty array when no worktrees exist at all', async () => {
    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toEqual([]);
  });

  it('returns results ordered by last_accessed_at DESC', async () => {
    const earlier = '2026-01-01T00:00:00.000Z';
    const later = '2026-01-02T00:00:00.000Z';

    db.prepare(`
      INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('wt-old', 1, 'owner/repo', 'old', '/tmp/wt/old', earlier, earlier);

    db.prepare(`
      INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('wt-new', 2, 'owner/repo', 'new', '/tmp/wt/new', later, later);

    const results = await repo.findAllByRepository('owner/repo');

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('wt-new');
    expect(results[1].id).toBe('wt-old');
  });

});
