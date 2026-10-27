// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';
const analyses = require('../../src/routes/analyses');
const reviews = require('../../src/routes/reviews');
const { withModelEvidence } = require('../../src/ai/model-evidence');
const { accumulatePiResponseLine } = require('../../src/ai/pi-format');

describe('serving model evidence in review and analysis APIs', () => {
  let db;
  let server;
  beforeEach(async () => {
    db = createTestDatabase();
    const app = express();
    app.set('db', db);
    // Today's default must not become attribution for any saved run.
    app.set('config', { providers: { omp: { default_model: 'today-not-the-reviewer' } } });
    app.use(analyses, reviews);
    server = await listenOnLoopback(app);
  });
  afterEach(async () => {
    await closeServer(server);
    closeTestDatabase(db);
  });

  it.each(['pr', 'local'])('returns persisted fallback/council evidence and unknown legacy models in %s mode', async reviewType => {
    const reviewId = Number(db.prepare(`INSERT INTO reviews (repository, pr_number, review_type, status)
      VALUES (?, ?, ?, 'draft')`).run(reviewType === 'local' ? '/isolated/project' : 'owner/repo', reviewType === 'local' ? null : 42, reviewType).lastInsertRowid);
    db.prepare(`INSERT INTO analysis_runs (id, review_id, provider, model, status, started_at)
      VALUES (?, ?, 'omp', 'requested-opus', 'completed', ?)`).run('legacy', reviewId, '2020-01-01 00:00:00');
    db.prepare(`INSERT INTO analysis_runs (id, review_id, provider, model, status, started_at, activity_state)
      VALUES (?, ?, 'omp', 'default', 'completed', ?, '{}')`).run('observed', reviewId, '2020-01-02 00:00:00');
    await withModelEvidence(db, 'observed', async () => {
      for (const [provider, model] of [['google', 'gemini-flash'], ['openai-codex', 'gpt-6.1-sol']]) {
        accumulatePiResponseLine(JSON.stringify({ type: 'message_end', message: {
          role: 'assistant', provider, model, stopReason: 'stop', content: [{ type: 'text', text: '{"suggestions":[]}' }]
        } }), { textContent: '', rawOutput: '', seenTexts: new Set() }, '[test]', 'OMP');
      }
    });
    const expected = [{ provider: 'google', model: 'gemini-flash' }, { provider: 'openai-codex', model: 'gpt-6.1-sol' }];
    const history = await request(server).get('/api/analyses/runs').query({ reviewId });
    expect(history.status).toBe(200);
    expect(history.body.runs.find(run => run.id === 'observed')).toMatchObject({
      provider: 'omp', model: 'default', requestedProvider: 'omp', requestedModel: 'default', actualModels: expected
    });
    expect(history.body.runs.find(run => run.id === 'legacy')).toMatchObject({ requestedModel: 'requested-opus', actualModels: [] });
    const recent = await request(server).get('/api/reviews/recent');
    expect(recent.status).toBe(200);
    expect(recent.body.reviews.find(review => review.id === reviewId).latestAiRun).toMatchObject({
      id: 'observed', requestedProvider: 'omp', requestedModel: 'default', actualModels: expected
    });
    const latest = await request(server).get('/api/analyses/runs/latest').query({ reviewId });
    expect(latest.status).toBe(200);
    expect(latest.body.run.actualModels).toEqual(expected);
    const legacy = await request(server).get('/api/analyses/runs/legacy');
    expect(legacy.status).toBe(200);
    expect(legacy.body.run.actualModels).toEqual([]);
  });
});
