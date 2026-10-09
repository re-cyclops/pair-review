// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { computeDbId } = require('./utils/db-identity');
const ws = require('./ws');
const { version } = require('../package.json');

const instanceId = randomUUID();
const context = new AsyncLocalStorage();
const owners = new Map();
const processCounts = new Map();
const setProcessCount = (id, count) => count ? processCounts.set(id, count) : processCounts.delete(id);
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const stages = { 1: 'Reading changed lines', 2: 'Reading file context', 3: 'Reading codebase', 4: 'Consolidating findings', exec: 'Running reviewer' };

const parse = value => {
  try { return JSON.parse(value || 'null'); } catch { return null; }
};

const identity = db => ({ instanceId, dbId: computeDbId(db.name), version });

const hasFailure = value => {
  if (typeof value === 'string') return ['failed', 'error', 'cancelled'].includes(value);
  return value && typeof value === 'object' && Object.values(value).some(hasFailure);
};

const read = (db, id) => parse(db.prepare('SELECT activity_state FROM analysis_runs WHERE id = ?').get(id)?.activity_state);

const save = (db, state) => {
  db.prepare('UPDATE analysis_runs SET activity_state = ? WHERE id = ?').run(JSON.stringify(state), state.analysisId);
  // One topic and immutable per-run sequence cover snapshot/event races and concurrent runs.
  ws.broadcast('index:analyses', { type: 'activity', ...identity(db), run: state });
  return state;
};

const begin = (db, id) => {
  const row = db.prepare(`SELECT a.*, r.repository, r.pr_number, r.review_type, r.name AS review_name
    FROM analysis_runs a JOIN reviews r ON r.id = a.review_id WHERE a.id = ?`).get(id);
  if (!row) return null;
  const existing = parse(row.activity_state);
  if (existing) return existing;
  const imported = row.status === 'completed';
  const now = new Date().toISOString();
  const state = {
    analysisId: id, runId: id, parentRunId: row.parent_run_id, reviewId: row.review_id,
    reviewType: row.review_type, repository: row.review_type === 'local' ? path.basename(row.repository) : row.repository,
    prNumber: row.pr_number, name: row.review_name || null, headSha: row.head_sha,
    provider: row.provider, model: row.model, instanceId: imported ? null : instanceId,
    entryPoint: imported ? 'result-import' : (context.getStore()?.entryPoint || 'standalone'),
    status: row.status, stage: imported ? 'Results imported; execution was not observed' : 'Starting analysis',
    startedAt: imported ? null : now, completedAt: imported ? now : null,
    lastEventAt: now, sequence: 1, seenAt: null, notificationClaimedAt: null,
    suggestionsCount: imported ? row.total_suggestions : null
  };
  if (!imported) owners.set(id, new WeakRef(db));
  return save(db, state);
};

const update = (db, id, progress = {}) => {
  const previous = read(db, id);
  if (!previous || previous.instanceId !== instanceId) return previous;
  // Late stream events cannot revive a settled run. Completion enrichment may refine it to partial.
  if (terminal.has(previous.status) && !['completed', 'failed', 'cancelled'].includes(progress.status)) return previous;
  if (previous.status === 'cancellation_requested' && (processCounts.has(id) || !['completed', 'failed', 'cancelled'].includes(progress.status))) return previous;
  const row = db.prepare('SELECT status, level_outcomes, total_suggestions FROM analysis_runs WHERE id = ?').get(id);
  if (!row) return previous;
  let status = previous.status === 'cancellation_requested' ? 'cancelled' : progress.status || previous.status;
  if (status === 'completed' && (hasFailure(progress.levels) || hasFailure(parse(row.level_outcomes)))) status = 'partial';
  if (terminal.has(previous.status) && status !== previous.status && !(previous.status === 'completed' && status === 'partial')) return previous;
  const runningLevel = Object.entries(progress.levels || {}).reverse().find(([, level]) => level?.status === 'running');
  const now = new Date().toISOString();
  const state = {
    ...previous, status, sequence: previous.sequence + 1, lastEventAt: now,
    stage: status === 'partial' ? 'Partial results; one or more stages failed'
      : terminal.has(status) ? `Analysis ${status}`
        : status === 'cancellation_requested' ? 'Waiting for executor cancellation acknowledgement'
          : runningLevel ? (stages[runningLevel[0]] || 'Running reviewer') : previous.stage,
    completedAt: terminal.has(status) ? (previous.completedAt || now) : null,
    suggestionsCount: terminal.has(status) ? row.total_suggestions : previous.suggestionsCount
  };
  return save(db, state);
};

const progress = (id, value) => {
  const db = owners.get(id)?.deref();
  if (!db?.open) { owners.delete(id); return null; }
  return update(db, id, value);
};

const requestCancellation = (db, id) => {
  const current = read(db, id);
  if (!current || current.instanceId !== instanceId || terminal.has(current.status)) return false;
  update(db, id, { status: 'cancellation_requested' });
  return true;
};

const acknowledgeCancellation = id => progress(id, { status: 'cancelled' });

const snapshot = db => {
  const rows = db.prepare(`SELECT a.id, a.review_id, a.status, a.provider, a.model, a.head_sha,
    a.started_at, a.completed_at, a.parent_run_id, a.activity_state, r.review_type, r.pr_number, r.repository
    FROM analysis_runs a JOIN reviews r ON r.id = a.review_id WHERE a.parent_run_id IS NULL
    AND (a.status = 'running' OR (a.activity_state IS NOT NULL AND
      (json_extract(a.activity_state, '$.seenAt') IS NULL OR julianday(a.completed_at) > julianday('now', '-1 day'))))
    ORDER BY julianday(COALESCE(a.completed_at, a.started_at)) DESC, a.rowid DESC`).all();
  const runs = rows.map(row => {
    const stored = parse(row.activity_state);
    if (!stored) return {
      analysisId: row.id, runId: row.id, reviewId: row.review_id, status: 'unknown',
      observation: 'unavailable', stage: 'Executor ownership was not recorded', sequence: 0,
      reviewType: row.review_type, repository: row.review_type === 'local' ? path.basename(row.repository) : row.repository,
      prNumber: row.pr_number, provider: row.provider, model: row.model, startedAt: row.started_at,
      lastEventAt: null, seenAt: null
    };
    const owned = stored.instanceId === instanceId && owners.get(row.id)?.deref() === db;
    return { ...stored, observation: terminal.has(stored.status) ? 'recorded' : owned ? 'live' : 'unavailable',
      ...(terminal.has(stored.status) || owned ? {} : { status: 'unknown', stage: 'Owning executor is not observed on this instance' }) };
  });
  const draftCount = db.prepare("SELECT COUNT(DISTINCT review_id) AS count FROM comments WHERE source = 'user' AND status IN ('active', 'inactive')").get().count;
  return { ...identity(db), observedAt: new Date().toISOString(), runs, draftCount,
    scope: 'connected-instance', limitation: 'Other processes and machines are not live-instrumented by this connection' };
};

const markSeen = (db, id, sequence) => {
  const state = read(db, id);
  if (!state || state.sequence !== sequence || !terminal.has(state.status)) return false;
  save(db, { ...state, seenAt: new Date().toISOString(), sequence: state.sequence + 1 });
  return true;
};

const claimNotification = (db, id) => {
  const state = read(db, id);
  if (!state || !terminal.has(state.status) || state.seenAt || state.notificationClaimedAt) return false;
  const result = db.prepare(`UPDATE analysis_runs SET activity_state = json_set(activity_state, '$.notificationClaimedAt', ?)
    WHERE id = ? AND json_extract(activity_state, '$.notificationClaimedAt') IS NULL
    AND json_extract(activity_state, '$.seenAt') IS NULL`).run(new Date().toISOString(), id);
  return result.changes === 1;
};

module.exports = { acknowledgeCancellation, begin, claimNotification, context, identity, instanceId,
  markSeen, progress, requestCancellation, setProcessCount, snapshot, terminal, update };
