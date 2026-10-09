// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
const { createTestDatabase, seedTestReview } = require('../utils/schema');
const { AnalysisRunRepository } = require('../../src/database');
const activity = require('../../src/analysis-activity');
const shared = require('../../src/routes/shared');

let db;
let repo;
let reviewId;
beforeEach(() => {
  db = createTestDatabase();
  reviewId = seedTestReview(db);
  repo = new AnalysisRunRepository(db);
});
afterEach(() => {
  shared.activeAnalyses.clear();
  shared.activeProcesses.clear();
  db.close();
});
const start = (id, options = {}) => activity.context.run({ entryPoint: 'mcp' }, () => repo.create({ id, reviewId, provider: 'omp', model: 'default', ...options }));

describe('durable activity', () => {
  it('keeps concurrent runs independent and refuses late resurrection after completion', async () => {
    await start('first');
    await start('second');
    await repo.update('first', { status: 'completed', totalSuggestions: 0 });
    shared.broadcastProgress('first', { status: 'running', levels: { 1: { status: 'running' } } });
    const rows = activity.snapshot(db).runs;
    expect(rows.find(r => r.runId === 'first')).toMatchObject({ status: 'completed', suggestionsCount: 0, observation: 'recorded' });
    expect(rows.find(r => r.runId === 'second')).toMatchObject({ status: 'running', observation: 'live', entryPoint: 'mcp' });
  });

  it('shows consolidation failure as partial rather than completed success', async () => {
    await start('partial');
    await repo.update('partial', { status: 'completed', totalSuggestions: 3, levelOutcomes: { 1: 'success', consolidation: 'failed' } });
    shared.broadcastProgress('partial', { status: 'completed', levels: {} });
    expect(activity.snapshot(db).runs[0]).toMatchObject({ status: 'partial', suggestionsCount: 3 });
  });

  it('does not infer liveness or failure from a stale database row', async () => {
    await start('old');
    db.prepare("UPDATE analysis_runs SET started_at = '2020-01-01', activity_state = json_set(activity_state, '$.instanceId', 'previous-process') WHERE id = 'old'").run();
    expect(activity.snapshot(db).runs[0]).toMatchObject({ status: 'unknown', observation: 'unavailable' });
    expect(db.prepare("SELECT status FROM analysis_runs WHERE id = 'old'").get().status).toBe('running');
  });

  it('waits for every owned child to acknowledge cancellation', async () => {
    await start('cancel');
    shared.activeAnalyses.set('cancel', { status: 'running', id: 'cancel', reviewId });
    const first = new EventEmitter();
    const second = new EventEmitter();
    first.kill = second.kill = () => true;
    first.pid = 10001;
    second.pid = 10002;
    shared.registerProcess('cancel', first);
    shared.registerProcess('cancel', second);
    shared.activeAnalyses.set('cancel', { status: 'cancellation_requested', id: 'cancel', reviewId });
    activity.requestCancellation(db, 'cancel');
    expect(shared.killProcesses('cancel')).toBe(2);
    // An early shell exit must not pretend inherited child pipes have closed.
    await repo.update('cancel', { status: 'cancelled' });
    expect(activity.snapshot(db).runs[0].status).toBe('cancellation_requested');
    first.emit('close');
    expect(activity.snapshot(db).runs[0].status).toBe('cancellation_requested');
    second.emit('close');
    expect(activity.snapshot(db).runs[0].status).toBe('cancelled');
  });

  it('claims notifications once and requires the seen receipt to match the terminal revision', async () => {
    await start('notify');
    const running = activity.snapshot(db).runs[0];
    expect(activity.claimNotification(db, 'notify')).toBe(false);
    await repo.update('notify', { status: 'failed' });
    expect(activity.markSeen(db, 'notify', running.sequence)).toBe(false);
    expect(activity.claimNotification(db, 'notify')).toBe(true);
    expect(activity.claimNotification(db, 'notify')).toBe(false);
    const finished = activity.snapshot(db).runs[0];
    expect(activity.markSeen(db, 'notify', finished.sequence)).toBe(true);
    expect(activity.snapshot(db).runs[0].seenAt).toEqual(expect.any(String));
  });

  it('does not misrepresent imported findings as an observed AI execution', async () => {
    await start('imported', { status: 'completed' });
    expect(activity.snapshot(db).runs[0]).toMatchObject({ status: 'completed', startedAt: null, instanceId: null, entryPoint: 'result-import' });
  });
});
