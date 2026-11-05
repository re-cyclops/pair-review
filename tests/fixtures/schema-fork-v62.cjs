// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// Frozen fork migrations from dc0e473a (versions 56–62); production never imports this.
const v55 = require('./schema-v55.cjs');
const SCHEMA_SQL = {
  "github_collection_observations": "\n    CREATE TABLE IF NOT EXISTS github_collection_observations (\n      collection TEXT NOT NULL,\n      source TEXT NOT NULL,\n      credential_hash TEXT,\n      fetched_at TEXT,\n      availability TEXT NOT NULL DEFAULT 'unavailable',\n      error TEXT,\n      request_id TEXT,\n      PRIMARY KEY (collection, source)\n    )\n  ",
  "worktree_locks": "\n    CREATE TABLE IF NOT EXISTS worktree_locks (\n      path TEXT PRIMARY KEY,\n      holder_id TEXT NOT NULL,\n      repository TEXT,\n      pr_number INTEGER,\n      locked_at TEXT NOT NULL\n    )\n  "
};
const tableExists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
const columnExists = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
const initializeSubmissionState = db => db.exec("\n    CREATE TABLE IF NOT EXISTS submission_attempts (\n      id TEXT PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,\n      target_key TEXT NOT NULL, manifest TEXT NOT NULL, digest TEXT NOT NULL,\n      state TEXT NOT NULL, phase TEXT NOT NULL, owner TEXT NOT NULL,\n      parent_id TEXT, remote_id TEXT, remote_database_id TEXT, remote_url TEXT,\n      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL\n    );\n    CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_open_target ON submission_attempts(target_key)\n      WHERE state NOT IN ('submitted', 'superseded');\n    CREATE INDEX IF NOT EXISTS idx_submission_review ON submission_attempts(review_id, created_at);\n    CREATE TABLE IF NOT EXISTS submission_items (\n      attempt_id TEXT NOT NULL REFERENCES submission_attempts(id) ON DELETE CASCADE,\n      ordinal INTEGER NOT NULL, local_id INTEGER NOT NULL, local_key TEXT NOT NULL,\n      state TEXT NOT NULL DEFAULT 'unattempted', remote_id TEXT, remote_database_id TEXT,\n      thread_id TEXT, error TEXT, PRIMARY KEY(attempt_id, ordinal)\n    );\n    CREATE TRIGGER IF NOT EXISTS review_submission_delete_guard BEFORE DELETE ON reviews\n    WHEN EXISTS (SELECT 1 FROM submission_attempts WHERE review_id = OLD.id AND state NOT IN ('submitted', 'superseded'))\n    BEGIN SELECT RAISE(ABORT, 'Resolve the pending submission before removing local review history'); END;\n    CREATE TRIGGER IF NOT EXISTS comment_submission_delete_guard BEFORE DELETE ON comments\n    WHEN EXISTS (SELECT 1 FROM submission_items i JOIN submission_attempts a ON a.id = i.attempt_id\n      WHERE i.local_id = OLD.id AND a.review_id = OLD.review_id AND a.state NOT IN ('submitted', 'superseded'))\n    BEGIN SELECT RAISE(ABORT, 'Resolve the pending submission before deleting its drafts'); END;\n    CREATE TRIGGER IF NOT EXISTS comment_submission_tombstone_guard BEFORE UPDATE OF deleted_at ON comments\n    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND EXISTS (\n      SELECT 1 FROM submission_items i JOIN submission_attempts a ON a.id = i.attempt_id\n      WHERE i.local_id = OLD.id AND a.review_id = OLD.review_id AND a.state NOT IN ('submitted', 'superseded'))\n    BEGIN SELECT RAISE(ABORT, 'Resolve the pending submission before deleting its drafts'); END;\n  ");
function initializeDraftTracking(db) {
  if (!tableExists(db, 'comments') || !tableExists(db, 'reviews')) return;
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_draft_key ON comments(draft_key);
    CREATE TRIGGER IF NOT EXISTS comments_draft_created AFTER INSERT ON comments
    WHEN NEW.source = 'user'
    BEGIN
      UPDATE comments SET draft_key = COALESCE(NEW.draft_key, lower(hex(randomblob(16)))) WHERE id = NEW.id;
      UPDATE reviews SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.review_id;
    END;
    CREATE TRIGGER IF NOT EXISTS comments_draft_changed
    AFTER UPDATE OF body, file, line_start, line_end, side, diff_position, commit_sha, is_file_level, status, included, deleted_at ON comments
    WHEN NEW.source = 'user' AND (
      NEW.body IS NOT OLD.body OR NEW.file IS NOT OLD.file OR
      NEW.line_start IS NOT OLD.line_start OR NEW.line_end IS NOT OLD.line_end OR
      NEW.side IS NOT OLD.side OR NEW.diff_position IS NOT OLD.diff_position OR
      NEW.commit_sha IS NOT OLD.commit_sha OR NEW.is_file_level IS NOT OLD.is_file_level OR
      NEW.status IS NOT OLD.status OR NEW.included IS NOT OLD.included OR NEW.deleted_at IS NOT OLD.deleted_at)
    BEGIN
      UPDATE comments SET revision = OLD.revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      UPDATE reviews SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.review_id;
    END;
    CREATE TRIGGER IF NOT EXISTS reviews_draft_changed AFTER UPDATE OF draft_body, draft_event ON reviews
    WHEN NEW.draft_body IS NOT OLD.draft_body OR NEW.draft_event IS NOT OLD.draft_event
    BEGIN
      UPDATE reviews SET draft_revision = OLD.draft_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
  `);
}
const MIGRATIONS = {
  56: (db) => {
    db.transaction(() => {
      if (tableExists(db, 'analysis_runs') && !columnExists(db, 'analysis_runs', 'activity_state')) {
        db.exec('ALTER TABLE analysis_runs ADD COLUMN activity_state TEXT');
      }
    })();
  },
  57: (db) => {
    db.transaction(() => {
      const additions = {
        comments: { draft_key: 'TEXT', revision: 'INTEGER NOT NULL DEFAULT 1', included: 'INTEGER NOT NULL DEFAULT 1 CHECK(included IN (0, 1))', deleted_at: 'TEXT' },
        reviews: { draft_body: "TEXT NOT NULL DEFAULT ''", draft_event: "TEXT NOT NULL DEFAULT 'COMMENT' CHECK(draft_event IN ('COMMENT', 'APPROVE', 'REQUEST_CHANGES'))", draft_revision: 'INTEGER NOT NULL DEFAULT 1' }
      };
      for (const [table, columns] of Object.entries(additions)) {
        if (!tableExists(db, table)) continue;
        for (const [column, definition] of Object.entries(columns)) {
          if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
      if (tableExists(db, 'comments')) {
        db.exec("UPDATE comments SET draft_key = lower(hex(randomblob(16))) WHERE source = 'user' AND draft_key IS NULL");
      }
      initializeDraftTracking(db);
    })();
  },
  58: (db) => {
    db.transaction(() => {
      if (tableExists(db, 'reviews') && !columnExists(db, 'reviews', 'associated_pr')) db.exec('ALTER TABLE reviews ADD COLUMN associated_pr TEXT');
      if (tableExists(db, 'reviews') && tableExists(db, 'comments')) initializeSubmissionState(db);
    })();
  },
  59: (db) => {
    db.exec(SCHEMA_SQL.github_collection_observations);
  },
  60: (db) => {
    db.transaction(() => {
      if (tableExists(db, 'reviews') && !columnExists(db, 'reviews', 'review_progress')) db.exec("ALTER TABLE reviews ADD COLUMN review_progress TEXT NOT NULL DEFAULT '{}'");
      if (tableExists(db, 'analysis_runs') && !columnExists(db, 'analysis_runs', 'review_baseline')) db.exec('ALTER TABLE analysis_runs ADD COLUMN review_baseline TEXT');
      if (!tableExists(db, 'reviews') || !tableExists(db, 'pr_metadata')) return;
      for (const row of db.prepare(`SELECT p.rowid AS metadata_id, p.pr_data, r.id AS review_id FROM pr_metadata p
        LEFT JOIN reviews r ON r.repository = p.repository COLLATE NOCASE AND r.pr_number = p.pr_number`).all()) {
        let data;
        try { data = JSON.parse(row.pr_data); } catch { continue; }
        if (!data || !Object.hasOwn(data, 'viewedFiles')) continue;
        // Legacy marks have no content/revision evidence; preserve them as
        // unverified history rather than silently certifying the current head.
        if (row.review_id && Array.isArray(data.viewedFiles)) {
          db.prepare("UPDATE reviews SET review_progress = json_set(review_progress, '$.legacyFiles', json(?)) WHERE id = ?")
            .run(JSON.stringify(data.viewedFiles.filter(file => typeof file === 'string')), row.review_id);
        }
        delete data.viewedFiles;
        db.prepare('UPDATE pr_metadata SET pr_data = ? WHERE rowid = ?').run(JSON.stringify(data), row.metadata_id);
      }
    })();
  },
  61: (db) => {
    if (tableExists(db, 'analysis_runs') && !columnExists(db, 'analysis_runs', 'protocol_snapshot')) db.exec('ALTER TABLE analysis_runs ADD COLUMN protocol_snapshot TEXT');
  },
  62: (db) => {
    db.exec(SCHEMA_SQL.worktree_locks);
  }
};

function createForkDatabase(db, version = 62) {
  db.pragma('foreign_keys = ON');
  for (const sql of Object.values(v55.SCHEMA_SQL)) db.exec(sql);
  for (const sql of v55.INDEX_SQL) db.exec(sql);
  db.pragma('user_version = 55');
  for (let current = 56; current <= version; current++) {
    MIGRATIONS[current](db);
    db.pragma(`user_version = ${current}`);
  }
  return db;
}
module.exports = { createForkDatabase };
