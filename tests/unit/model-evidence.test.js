// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
const Database = require('better-sqlite3');
const { actualModelsForRun, modelsFromEvent, withModelEvidence } = require('../../src/ai/model-evidence');
const { accumulatePiResponseLine, finalizePiResponseParsing } = require('../../src/ai/pi-format');
const activity = require('../../src/analysis-activity');

const pair = (model, provider = 'openai-codex') => ({ provider, model });
const assistant = (model, extra = {}) => ({ type: 'message_end', message: {
  role: 'assistant', ...pair(model), stopReason: 'stop', content: [{ type: 'text', text: '{"suggestions":[]}' }], ...extra
} });
const state = () => ({ textContent: '', rawOutput: '', rawOutputTruncated: false, seenTexts: new Set() });
const consume = (event, response = state()) => {
  accumulatePiResponseLine(JSON.stringify(event), response, '[test]', 'OMP');
  return response;
};

describe('observed serving model evidence', () => {
  let db;
  const saved = id => db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(id);
  const insert = id => db.prepare('INSERT INTO analysis_runs VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, 'omp', 'default', JSON.stringify({ analysisId: id, instanceId: activity.instanceId, status: 'running', sequence: 1 }), 'running', null, 0);
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE analysis_runs (id TEXT PRIMARY KEY, provider TEXT, model TEXT,
      activity_state TEXT, status TEXT, level_outcomes TEXT, total_suggestions INTEGER)`);
    ['parent', 'child-a', 'child-b', 'next'].forEach(insert);
  });
  afterEach(() => db.close());

  it('captures real OMP default/fallback metadata without changing the requested alias', async () => {
    await withModelEvidence(db, 'parent', async () => {
      consume({ type: 'session', provider: 'requested', model: 'default' });
      const response = consume(assistant('gpt-6.1-sol'));
      const parsed = finalizePiResponseParsing(response, 1, '[test]', 'OMP');
      expect(parsed.actualModels).toEqual([pair('gpt-6.1-sol')]);
      expect(parsed.data).toEqual({ suggestions: [] });
    });
    expect(saved('parent').model).toBe('default');
    expect(saved('parent').provider).toBe('omp');
    expect(actualModelsForRun(saved('parent'))).toEqual([pair('gpt-6.1-sol')]);
  });

  it('records an explicit requested model falling back to a different serving provider', async () => {
    db.prepare('UPDATE analysis_runs SET model = ? WHERE id = ?').run('requested-opus', 'parent');
    await withModelEvidence(db, 'parent', async () => consume(assistant('gemini-flash', { provider: 'google' })));
    expect(saved('parent').model).toBe('requested-opus');
    expect(actualModelsForRun(saved('parent'))).toEqual([pair('gemini-flash', 'google')]);
  });

  it('aggregates concurrent council children and levels only into their own parent', async () => {
    await withModelEvidence(db, 'parent', async () => {
      await Promise.all([
        withModelEvidence(db, 'child-a', async () => {
          await Promise.resolve();
          consume(assistant('sol'));
          consume({ type: 'agent_end', messages: [assistant('sol').message] });
        }),
        withModelEvidence(db, 'child-b', async () => {
          consume(assistant('flash', { provider: 'google' }));
          await Promise.resolve();
          consume(assistant('muse', { provider: 'muse' }));
        })
      ]);
    });
    expect(actualModelsForRun(saved('parent'))).toHaveLength(3);
    expect(actualModelsForRun(saved('child-a'))).toEqual([pair('sol')]);
    expect(actualModelsForRun(saved('child-b'))).toEqual([pair('flash', 'google'), pair('muse', 'muse')]);
    await withModelEvidence(db, 'next', async () => consume(assistant('next-model')));
    expect(actualModelsForRun(saved('next'))).toEqual([pair('next-model')]);
    expect(actualModelsForRun(saved('parent'))).not.toContainEqual(pair('next-model'));
  });

  it('retains observed successful turns when later execution fails and lifecycle updates occur', async () => {
    await expect(withModelEvidence(db, 'parent', async () => {
      consume(assistant('served', { stopReason: 'toolUse' }));
      consume(assistant('failed-fallback', { stopReason: 'error', errorMessage: 'unavailable' }));
      consume(assistant('aborted-fallback', { stopReason: 'aborted' }));
      throw new Error('cancelled');
    })).rejects.toThrow('cancelled');
    activity.update(db, 'parent', { status: 'cancelled' });
    expect(actualModelsForRun(saved('parent'))).toEqual([pair('served')]);
    expect(JSON.parse(saved('parent').activity_state).status).toBe('cancelled');
  });

  it('keeps legacy runs unknown despite requested defaults and ignores model-authored result fields', async () => {
    expect(actualModelsForRun({ provider: 'omp', model: 'sol' })).toEqual([]);
    expect(actualModelsForRun({ activity_state: '{broken', model: 'default' })).toEqual([]);
    await withModelEvidence(db, 'parent', async () => {
      consume({ suggestions: [], actualModels: [pair('fabricated')] });
      consume(assistant(undefined, { provider: undefined }));
    });
    expect(actualModelsForRun(saved('parent'))).toEqual([]);
  });

  it('ignores delayed events from a settled execution scope', async () => {
    let release;
    let late;
    const gate = new Promise(resolve => { release = resolve; });
    await withModelEvidence(db, 'parent', async () => {
      consume(assistant('original'));
      late = gate.then(() => consume(assistant('too-late')));
    });
    release();
    await late;
    expect(actualModelsForRun(saved('parent'))).toEqual([pair('original')]);
  });

  it('supports Pi assistant turn/agent envelopes but rejects incomplete and failed messages', () => {
    const message = assistant('pi-served', { provider: 'anthropic' }).message;
    expect(modelsFromEvent({ type: 'turn_end', message })).toEqual([pair('pi-served', 'anthropic')]);
    expect(modelsFromEvent({ type: 'agent_end', messages: [message, message] })).toEqual([pair('pi-served', 'anthropic')]);
    expect(modelsFromEvent({ type: 'message_start', message })).toEqual([]);
    expect(modelsFromEvent({ type: 'message_update', message })).toEqual([]);
    expect(modelsFromEvent({ type: 'message_end', message: { ...message, role: 'user' } })).toEqual([]);
  });
});
