// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A fresh executor keeps irreversible shutdown admission out of the test runner.
// The real child ignores SIGTERM, so completion requires owned-process escalation.
it.skipIf(process.platform === 'win32')('acknowledges owned child death before closing a run and never settles another executor', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'pair-review-shutdown-'));
  const script = String.raw`
    const { spawn } = require('node:child_process');
    const { once } = require('node:events');
    const { createTestDatabase, seedTestReview } = require('./tests/utils/schema');
    const { AnalysisRunRepository } = require('./src/database');
    const activity = require('./src/analysis-activity');
    const shared = require('./src/routes/shared');
    const db = createTestDatabase();
    const repo = new AnalysisRunRepository(db);
    const children = [];
    (async () => {
      try {
        const reviewId = seedTestReview(db);
        await repo.create({ id: 'owned', reviewId });
        await repo.create({ id: 'foreign', reviewId });
        db.prepare("UPDATE analysis_runs SET activity_state = json_set(activity_state, '$.instanceId', 'another-executor') WHERE id = 'foreign'").run();
        shared.activeAnalyses.set('owned', { id: 'owned', reviewId, status: 'running' });
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.send('term'));setInterval(()=>{},1000);process.send('ready')"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.push(child);
        await once(child, 'message');
        shared.registerProcess('owned', child);
        const terminal = once(child, 'close');
        const signalled = once(child, 'message');
        const stopping = shared.shutdownAnalyses();
        await signalled;
        const before = activity.snapshot(db).runs.find(run => run.analysisId === 'owned');
        const rawBefore = (await repo.getById('owned')).status;
        const late = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        children.push(late);
        const lateClosed = once(late, 'close');
        shared.registerProcess('owned', late);
        let admissionStatus;
        try { await repo.create({ id: 'late-run', reviewId }); } catch (error) { admissionStatus = error.status; }
        await stopping;
        const [, signal] = await terminal;
        await lateClosed;
        const after = activity.snapshot(db).runs.find(run => run.analysisId === 'owned');
        console.log(JSON.stringify({
          before: before.status, rawBefore, after: after.status,
          rawAfter: (await repo.getById('owned')).status, signal,
          remaining: shared.activeProcesses.size, admissionStatus,
          lateRunCreated: Boolean(await repo.getById('late-run')),
          foreign: (await repo.getById('foreign')).status
        }));
      } finally {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        db.close();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const worker = spawn(process.execPath, ['-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), detached: true,
    env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '', deadline;
  worker.stdout.on('data', chunk => { stdout += chunk; });
  worker.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const [code] = await Promise.race([
      once(worker, 'close'),
      new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('Shutdown did not acknowledge owned child termination')), 8000); })
    ]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      before: 'cancellation_requested', rawBefore: 'running', after: 'cancelled', rawAfter: 'cancelled',
      signal: 'SIGKILL', remaining: 0, admissionStatus: 503, lateRunCreated: false, foreign: 'running'
    });
  } finally {
    clearTimeout(deadline);
    try { process.kill(-worker.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);
