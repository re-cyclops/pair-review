// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
const Analyzer = require('../../src/ai/analyzer');
const { AnalysisRunRepository } = require('../../src/database');
const { actualModelsForRun } = require('../../src/ai/model-evidence');

// Only the external CLI boundary is synthetic: real analyzers, provider spawn,
// JSONL parsing, SQLite persistence, and council child execution all run.
describe('real analyzer serving-model attribution', () => {
  let root;
  let repo;
  let db;
  let reviewId;
  let metadata;
  let overrides;
  const servedA = { provider: 'openai-codex', model: 'gpt-6.1-sol' };
  const servedB = { provider: 'google', model: 'gemini-flash' };
  const saved = id => db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(id);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-model-evidence-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
    vi.stubEnv('PAIR_REVIEW_NO_OPEN', '1');
    vi.stubEnv('PAIR_REVIEW_OMP_CMD', `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve(__dirname, '../utils/model-attribution-provider.js'))}`);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    git('config', 'core.hooksPath', '/dev/null');
    fs.writeFileSync(path.join(repo, 'file.js'), 'const value = 1;\n');
    git('add', 'file.js');
    git('commit', '-m', 'fixture');
    const head = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'file.js'), 'const value = 2;\n');
    for (const [alias, evidence] of [['default', servedA], ['requested-a', servedA], ['requested-b', servedB]]) {
      fs.writeFileSync(path.join(root, `${alias}.json`), JSON.stringify({ ...evidence, capture: true }));
    }
    overrides = {
      env: { HOME: home, MODEL_ATTRIBUTION_FIXTURES: root },
      models: ['requested-a', 'requested-b'].map(id => ({ id, cli_model: id, name: id, tier: 'balanced' }))
    };
    db = createTestDatabase();
    reviewId = Number(db.prepare(`INSERT INTO reviews (repository, review_type, status, local_path, local_head_sha)
      VALUES (?, 'local', 'draft', ?, ?)`).run(repo, repo, head).lastInsertRowid);
    metadata = { reviewType: 'local', repository: repo, title: 'Fixture review', description: '', head_sha: head };
  });

  afterEach(() => {
    if (db) closeTestDatabase(db);
    vi.unstubAllEnvs();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['default', 'requested-b'])('persists actual serving metadata through a real %s single-model run', async requested => {
    const analyzer = new Analyzer(db, requested, 'omp', overrides);
    const result = await analyzer.analyzeAllLevels(reviewId, repo, metadata, null, null, ['file.js'], {
      enabledLevels: { 1: true, 2: false, 3: false }, timeout: 10000
    });
    expect(saved(result.runId)).toMatchObject({ status: 'completed', provider: 'omp', model: requested });
    expect(actualModelsForRun(saved(result.runId))).toEqual([requested === 'default' ? servedA : servedB]);
    // This file exists only if the actual external provider process ran.
    expect(fs.readFileSync(path.join(root, `${requested}.json.requests.jsonl`), 'utf8')).toContain('file.js');
  }, 30000);

  it('aggregates real reviewer-centric council children and creates its parent when no runId is supplied', async () => {
    const analyzer = new Analyzer(db, 'default', 'omp', overrides);
    const result = await analyzer.runReviewerCentricCouncil({
      reviewId, worktreePath: repo, prMetadata: metadata, changedFiles: ['file.js'], instructions: null
    }, {
      voices: ['requested-a', 'requested-b'].map(model => ({ provider: 'omp', model })),
      levels: { 1: true, 2: false, 3: false },
      consolidation: { provider: 'omp', model: 'default' },
      orchestration: { provider: 'omp', model: 'default' }
    }, { timeout: 10000 });
    expect(saved(result.runId)).toMatchObject({ status: 'completed', config_type: 'council' });
    expect(actualModelsForRun(saved(result.runId))).toEqual(expect.arrayContaining([servedA, servedB]));
    expect(actualModelsForRun(saved(result.runId))).toHaveLength(2);
    const children = db.prepare('SELECT * FROM analysis_runs WHERE parent_run_id = ?').all(result.runId);
    expect(children).toHaveLength(2);
    for (const child of children) expect(actualModelsForRun(child)).toEqual([child.model === 'requested-a' ? servedA : servedB]);
    const next = await new Analyzer(db, 'requested-b', 'omp', overrides).analyzeAllLevels(
      reviewId, repo, metadata, null, null, ['file.js'], { enabledLevels: { 1: true, 2: false, 3: false }, timeout: 10000 });
    expect(actualModelsForRun(saved(next.runId))).toEqual([servedB]);
  }, 30000);

  it('captures level-centric council execution without a caller-created analysis scope', async () => {
    const runId = 'level-council';
    await new AnalysisRunRepository(db).create({ id: runId, reviewId, provider: 'council', model: 'levels', configType: 'council' });
    const analyzer = new Analyzer(db, 'default', 'omp', overrides);
    await analyzer.runCouncilAnalysis({ reviewId, worktreePath: repo, prMetadata: metadata, changedFiles: ['file.js'] }, {
      levels: { 1: { enabled: true, voices: [{ provider: 'omp', model: 'requested-b' }] } }
    }, { runId });
    expect(actualModelsForRun(saved(runId))).toEqual([servedB]);
    expect(fs.existsSync(path.join(root, 'requested-b.json.requests.jsonl'))).toBe(true);
  }, 30000);
});
