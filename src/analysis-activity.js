// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { computeDbId } = require('./utils/db-identity');
const { getDraftStateQuery } = require('./utils/stats-calculator');
const ws = require('./ws');
const { version } = require('../package.json');

const instanceId = randomUUID();
const context = new AsyncLocalStorage();
const owners = new Map();
const processCounts = new Map();
let stopping = false;
const setProcessCount = (id, count) => count ? processCounts.set(id, count) : processCounts.delete(id);
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const stages = { 1: 'Reading changed lines', 2: 'Reading file context', 3: 'Reading codebase', 4: 'Consolidating findings', exec: 'Running reviewer' };

const parse = value => {
  try { return JSON.parse(value || 'null'); } catch { return null; }
};

const identity = db => ({ instanceId, dbId: computeDbId(db.name), version });

const stageLabels = { level1: 'Level 1', 1: 'Level 1', level2: 'Level 2', 2: 'Level 2',
  level3: 'Level 3', 3: 'Level 3', consolidation: 'Consolidation', 4: 'Consolidation' };
const hasFailure = value => {
  if (typeof value === 'string') return ['failed', 'error', 'cancelled'].includes(value);
  return value && typeof value === 'object' && Object.values(value).some(hasFailure);
};
const partialStage = (outcomes, levels) => {
  const source = outcomes && typeof outcomes === 'object' ? outcomes : levels && typeof levels === 'object' ? levels : null;
  const failed = source ? Object.entries(source).filter(([key, val]) => stageLabels[key] && hasFailure(val)).map(([key]) => stageLabels[key]) : [];
  const unique = [...new Set(failed)];
  return unique.length ? `Partial results; ${unique.join(', ')} failed` : 'Partial results; one or more stages failed';
};

const read = (db, id) => parse(db.prepare('SELECT activity_state FROM analysis_runs WHERE id = ?').get(id)?.activity_state);

const publish = (db, state) => {
  if (state) ws.broadcast('index:analyses', { type: 'activity', ...identity(db), run: state });
  return state;
};

const save = (db, state) => {
  // Another process may acknowledge a result after the executor reads it.
  // Preserve those receipts and allocate the sequence from the current row.
  const row = db.prepare(`UPDATE analysis_runs SET activity_state = json_set(?,
    '$.seenAt', json_extract(activity_state, '$.seenAt'),
    '$.notificationClaimedAt', json_extract(activity_state, '$.notificationClaimedAt'),
    '$.sequence', COALESCE(json_extract(activity_state, '$.sequence'), 0) + 1)
    WHERE id = ? RETURNING activity_state`).get(JSON.stringify(state), state.analysisId);
  return publish(db, parse(row?.activity_state));
};

const begin = (db, id) => {
  const row = db.prepare(`SELECT a.*, r.repository, r.pr_number, r.review_type, r.name AS review_name, pm.host
    FROM analysis_runs a JOIN reviews r ON r.id = a.review_id
    LEFT JOIN pr_metadata pm ON pm.repository = r.repository COLLATE NOCASE AND pm.pr_number = r.pr_number
    WHERE a.id = ?`).get(id);
  if (!row) return null;
  const existing = parse(row.activity_state);
  if (existing) return existing;
  const imported = row.status === 'completed';
  const now = new Date().toISOString();
  const state = {
    analysisId: id, runId: id, parentRunId: row.parent_run_id, reviewId: row.review_id,
    reviewType: row.review_type, repository: row.review_type === 'local' ? path.basename(row.repository) : row.repository,
    prNumber: row.pr_number, host: row.host || null, name: row.review_name || null, headSha: row.head_sha,
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
  if (previous?.entryPoint === 'result-import' && previous.instanceId === null) {
    const row = db.prepare('SELECT total_suggestions FROM analysis_runs WHERE id = ?').get(id);
    if (!row || row.total_suggestions === previous.suggestionsCount) return previous;
    // Imported results have no observed executor; enrich counts, not lifecycle.
    return save(db, { ...previous, suggestionsCount: row.total_suggestions, lastEventAt: new Date().toISOString() });
  }
  if (!previous || previous.instanceId !== instanceId) return previous;
  // Late stream events cannot revive a settled run. Completion enrichment may refine it to partial.
  if (terminal.has(previous.status) && !['completed', 'failed', 'cancelled'].includes(progress.status)) return previous;
  if (previous.status === 'cancellation_requested' && (processCounts.has(id) || !['completed', 'failed', 'cancelled'].includes(progress.status))) return previous;
  const row = db.prepare('SELECT status, level_outcomes, total_suggestions FROM analysis_runs WHERE id = ?').get(id);
  if (!row) return previous;
  let status = previous.status === 'cancellation_requested' ? 'cancelled' : progress.status || previous.status;
  const outcomes = parse(row.level_outcomes);
  if (status === 'completed' && (hasFailure(progress.levels) || hasFailure(outcomes))) status = 'partial';
  if (terminal.has(previous.status) && status !== previous.status && !(previous.status === 'completed' && status === 'partial')) return previous;
  const runningLevel = Object.entries(progress.levels || {}).reverse().find(([, level]) => level?.status === 'running');
  const now = new Date().toISOString();
  const state = {
    ...previous, status, sequence: previous.sequence + 1, lastEventAt: now,
    stage: status === 'partial' ? partialStage(outcomes, progress.levels)
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

// Shutdown belongs to this executor, never to another process sharing the DB.
const cancelOwnedRuns = (acknowledged = false) => {
  stopping = true;
  for (const [id, owner] of owners) {
    const db = owner.deref();
    if (!db?.open) continue;
    const state = read(db, id);
    if (!state || state.instanceId !== instanceId || (terminal.has(state.status) && state.status !== 'cancelled')) continue;
    if (!acknowledged) {
      requestCancellation(db, id);
    } else if (!processCounts.has(id)) {
      db.prepare(`UPDATE analysis_runs SET status = 'cancelled',
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
        WHERE id = ? AND status <> 'cancelled'`).run(id);
      if (state.status !== 'cancelled') update(db, id, { status: 'cancelled' });
    }
  }
};

const snapshot = db => {
  const rows = db.prepare(`SELECT a.id, a.review_id, a.status, a.provider, a.model, a.head_sha,
    a.total_suggestions, a.level_outcomes,
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
    const outcomes = parse(row.level_outcomes);
    const stage = stored.status === 'partial' && stored.stage === 'Partial results; one or more stages failed'
      ? partialStage(outcomes) : stored.stage;
    return { ...stored, stage, levelOutcomes: outcomes,
      observation: terminal.has(stored.status) ? 'recorded' : owned ? 'live' : 'unavailable',
      suggestionsCount: stored.entryPoint === 'result-import' ? row.total_suggestions : stored.suggestionsCount,
      ...(terminal.has(stored.status) || owned ? {} : { status: 'unknown', stage: 'Owning executor is not observed on this instance' }) };
  });
  const draftCount = db.prepare(`SELECT COUNT(*) AS count FROM (${getDraftStateQuery()}) WHERE draft_count > 0 OR has_summary`).get().count;
  return { ...identity(db), observedAt: new Date().toISOString(), runs, draftCount,
    scope: 'connected-instance', limitation: 'Other processes and machines are not live-instrumented by this connection' };
};

const markSeen = (db, id, sequence) => {
  const state = read(db, id);
  if (!state || state.seenAt || state.sequence !== sequence || !terminal.has(state.status)) return false;
  const row = db.prepare(`UPDATE analysis_runs SET activity_state = json_set(activity_state,
    '$.seenAt', ?, '$.sequence', json_extract(activity_state, '$.sequence') + 1)
    WHERE id = ? AND json_extract(activity_state, '$.sequence') = ?
    AND json_extract(activity_state, '$.status') = ? AND json_extract(activity_state, '$.seenAt') IS NULL
    RETURNING activity_state`).get(new Date().toISOString(), id, sequence, state.status);
  return Boolean(publish(db, parse(row?.activity_state)));
};

const claimNotification = (db, id) => {
  const state = read(db, id);
  if (!state || !terminal.has(state.status) || state.seenAt || state.notificationClaimedAt) return false;
  const result = db.prepare(`UPDATE analysis_runs SET activity_state = json_set(activity_state, '$.notificationClaimedAt', ?)
    WHERE id = ? AND json_extract(activity_state, '$.notificationClaimedAt') IS NULL
    AND json_extract(activity_state, '$.seenAt') IS NULL`).run(new Date().toISOString(), id);
  return result.changes === 1;
};

// A recorded terminal status alone cannot acknowledge children still shutting
// down. Unobserved nonterminal rows also block removal; absence of ownership is
// not evidence that an executor stopped.
const reviewInProgress = (db, reviewId) => db.prepare(
  'SELECT id, status, activity_state FROM analysis_runs WHERE review_id = ?'
).all(reviewId).some(row => {
  const stored = parse(row.activity_state);
  return processCounts.has(row.id) || !terminal.has(row.status)
    || stored?.status && !terminal.has(stored.status);
});

module.exports = { acknowledgeCancellation, begin, cancelOwnedRuns, claimNotification, context, identity, instanceId,
  isStopping: () => stopping, markSeen, progress, requestCancellation, reviewInProgress, setProcessCount, snapshot, terminal, update };
