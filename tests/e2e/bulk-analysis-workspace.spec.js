// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const Database = require('better-sqlite3');
const serverScript = require.resolve('../utils/workspace-server.js');
const voices = [
  'zai/glm-5.3-flash:high',
  'google-antigravity/gemini-3.8-flash:high',
  'muse-code/muse-wonder-full-1.0:high',
  'openai-codex/gpt-6.1-sol:high'
];

// Reserve both adjacent ports, not a worker-derived port that could hit a live workspace.
async function availablePorts() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const app = net.createServer();
    const admin = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        app.once('error', reject);
        app.listen(0, '127.0.0.1', resolve);
      });
      const port = app.address().port;
      if (port === 65535) continue;
      await new Promise((resolve, reject) => {
        admin.once('error', reject);
        admin.listen(port + 1, '127.0.0.1', resolve);
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    } finally {
      await Promise.all([app, admin].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    }
  }
  throw new Error('Unable to reserve an isolated workspace port pair');
}

const test = base.extend({
  workspace: async ({}, use, testInfo) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-analysis-e2e-'));
    let child;
    let db;
    let logs = '';
    try {
      const port = await availablePorts();
      child = spawn(process.execPath, [serverScript], {
        detached: true,
        env: { ...process.env, WORKSPACE_TEST_HOME: home, WORKSPACE_TEST_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Workspace did not become ready:\n${logs}`)), 30000);
        const fail = error => { clearTimeout(timer); reject(error); };
        child.once('error', fail);
        child.once('exit', code => fail(new Error(`Workspace exited (${code}):\n${logs}`)));
        child.stderr.on('data', chunk => { logs += chunk.toString(); });
        let pending = '';
        child.stdout.on('data', chunk => {
          logs += chunk.toString();
          pending += chunk.toString();
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) {
            try {
              const value = JSON.parse(line);
              if (value.fixtureReady) { clearTimeout(timer); resolve(value); }
            } catch { /* Application logs are not fixture signals. */ }
          }
        });
      });
      db = new Database(path.join(home, '.pair-review/workspace.db'), { readonly: true, fileMustExist: true });
      const url = `http://127.0.0.1:${ready.port}`;
      const rows = () => db.prepare(`SELECT a.*, r.repository, r.pr_number, r.review_type
        FROM analysis_runs a JOIN reviews r ON r.id = a.review_id ORDER BY a.rowid`).all();
      await use({
        url, home, rows,
        parents: () => rows().filter(row => !row.parent_run_id),
        checkout: number => JSON.parse(db.prepare('SELECT pr_data FROM pr_metadata WHERE repository = ? AND pr_number = ?').get('example/alpha', number).pr_data).worktree_path,
        release: async () => {
          const response = await fetch(`http://127.0.0.1:${ready.adminPort}/control`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerResult: { suggestions: [], provider: 'google-antigravity', model: 'gemini-3.8-flash', capture: true } })
          });
          expect(response.ok).toBeTruthy();
        },
        captures: async () => (await fs.readFile(path.join(home, 'provider-result.json.requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      });
    } finally {
      db?.close();
      if (child?.pid) {
        // A detached process group includes every OMP/provider descendant, even on assertion failure.
        const exited = child.exitCode !== null || child.signalCode !== null;
        const exit = exited ? Promise.resolve() : once(child, 'exit').catch(() => {});
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await exit;
      }
      if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('workspace-server.log', { body: logs, contentType: 'text/plain' });
      await fs.rm(home, { recursive: true, force: true });
    }
  }
});

test.setTimeout(120000);

async function inbox(page, workspace) {
  const handoffs = [];
  page.context().on('page', () => handoffs.push('new browser tab'));
  page.on('request', request => {
    if (/\/api\/(bulk-open|bulk-analysis-configs)(?:\?|$)/.test(new URL(request.url()).pathname)) handoffs.push(request.url());
  });
  await page.goto(workspace.url);
  await expect(page.locator('#recent-reviews-tbody tr[data-review-id]')).toHaveCount(4);
  return handoffs;
}

async function selectPrs(page, numbers) {
  await page.locator('[data-selection-tab="pr-tab"]').click();
  for (const [repo, number] of numbers) {
    await page.locator(`#recent-reviews-tbody tr[data-owner="example"][data-repo="${repo}"][data-number="${number}"] input[type="checkbox"]`).check();
  }
  await page.locator('#pr-tab .btn-bulk-analyze').click();
}

async function submitCouncil(page) {
  await expect(page.locator('#analysis-config-modal')).toBeVisible();
  await page.locator('#analysis-config-modal [data-tab="council"]').click();
  await page.selectOption('#vc-template-selector', 'four-model-focused');
  await page.locator('#analysis-config-modal [data-action="submit"]').click();
  const progress = page.getByRole('region', { name: 'Bulk analysis progress' });
  if (await progress.locator('details').getAttribute('open') === null) await progress.locator('summary').click();
  return progress;
}

async function refresh(page) {
  await page.evaluate(() => window.reviewWorkspace.refresh());
}

test('NO_OPEN bulk council starts ready and first-time PRs in place with four real voices and durable completion', async ({ page, workspace }) => {
  const handoffs = await inbox(page, workspace);
  expect(workspace.parents()).toHaveLength(0);
  expect(workspace.checkout(42)).toBeTruthy();
  expect(workspace.checkout(43)).toBeUndefined();
  await selectPrs(page, [['alpha', 42], ['alpha', 43]]);
  const progress = await submitCouncil(page);
  await expect(progress.locator('li')).toHaveCount(2);
  await expect.poll(() => workspace.parents().map(row => `${row.repository}#${row.pr_number}:${row.status}`).sort()).toEqual([
    'example/alpha#42:running', 'example/alpha#43:running'
  ]);
  const parents = workspace.parents();
  expect(parents.every(row => row.config_type === 'council')).toBeTruthy();
  for (const parent of parents) {
    await expect.poll(() => workspace.rows().filter(row => row.parent_run_id === parent.id).map(row => row.model).sort()).toEqual([...voices].sort());
    const children = workspace.rows().filter(row => row.parent_run_id === parent.id);
    expect(children.every(row => row.provider === 'omp' && row.status === 'running')).toBeTruthy();
  }
  await refresh(page);
  await expect(progress.locator('li[data-state="running"]')).toHaveCount(2);
  for (const number of [42, 43]) {
    await expect(page.locator(`#recent-reviews-tbody tr[data-repo="alpha"][data-number="${number}"] .workspace-ai-pill`)).toHaveAttribute('data-ai-state', 'running');
  }
  // Retrying the same active targets must retain their existing runs, not launch again.
  await page.locator('#pr-tab .btn-bulk-analyze').click();
  await submitCouncil(page);
  await expect(page.locator('#pr-tab .btn-bulk-analyze')).toBeEnabled();
  await refresh(page);
  await expect(progress.locator('li[data-state="running"]')).toHaveCount(2);
  expect(workspace.parents().map(row => row.id)).toEqual(parents.map(row => row.id));
  expect(handoffs).toEqual([]);
  await expect(page).toHaveURL(workspace.url + '/');

  await workspace.release();
  await expect.poll(() => workspace.parents().map(row => row.status), { timeout: 60000 }).toEqual(['completed', 'completed']);
  await refresh(page);
  await expect(progress.locator('li[data-state="completed"]')).toHaveCount(2);
  for (const parent of parents) {
    const children = workspace.rows().filter(row => row.parent_run_id === parent.id);
    expect(children.map(row => row.model).sort()).toEqual([...voices].sort());
    expect(children.every(row => row.status === 'completed')).toBeTruthy();
  }
  const captures = await workspace.captures();
  for (const model of voices) expect(captures.filter(capture => capture.args.includes(model)).length).toBeGreaterThanOrEqual(2);
  const recent = await (await page.request.get(workspace.url + '/api/reviews/recent')).json();
  for (const number of [42, 43]) {
    const review = recent.reviews.find(row => row.repository === 'example/alpha' && row.number === number);
    expect(review.aiRunCount).toBe(1);
    expect(review.latestAiRun.status).toBe('completed');
    await expect(page.locator(`#recent-reviews-tbody tr[data-repo="alpha"][data-number="${number}"] .workspace-ai-pill`)).toHaveAttribute('data-ai-state', 'reviewed');
  }
  expect(handoffs).toEqual([]);
});

test('real checkout HTTP failure preserves the accepted PR run and exposes the failed target', async ({ page, workspace }) => {
  const handoffs = await inbox(page, workspace);
  // Keep the actual acceptance response unchanged, but make the shared checkout
  // unavailable before the next target reaches the actual application APIs.
  await page.route('**/api/pr/example/alpha/42/analyses/council', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    // Acceptance precedes asynchronous diff/provider preparation. Wait until
    // every voice has entered the external provider before faulting the checkout.
    await expect.poll(async () => {
      try {
        const starts = (await fs.readFile(path.join(workspace.home, 'provider-result.json.started.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        // A voice may start more than one analysis level; require every actual
        // council model, rather than racing an exact process count.
        return [...new Set(starts.map(({ args }) => args[args.indexOf('--model') + 1]))].sort();
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    }, { timeout: 60000 }).toEqual([...voices].sort());
    await fs.rename(path.join(workspace.home, 'worktree'), path.join(workspace.home, 'held-worktree'));
    await fs.writeFile(path.join(workspace.home, 'worktree'), 'Checkout temporarily unavailable');
    await route.fulfill({ response });
  });
  const failures = [];
  page.on('response', async response => {
    if (response.status() >= 400 && /\/api\/(setup\/|pr\/example\/beta\/42\/analyses)/.test(new URL(response.url()).pathname)) {
      failures.push({ status: response.status(), body: await response.json() });
    }
  });
  await selectPrs(page, [['alpha', 42], ['beta', 42]]);
  const progress = await submitCouncil(page);
  await expect.poll(() => failures.length, { timeout: 60000 }).toBeGreaterThan(0);
  await expect(progress.locator('li[data-state="failed"]')).toHaveCount(1);
  await fs.rm(path.join(workspace.home, 'worktree'));
  await fs.rename(path.join(workspace.home, 'held-worktree'), path.join(workspace.home, 'worktree'));
  await expect.poll(() => workspace.parents().length).toBe(1);
  await refresh(page);
  await expect(progress.locator('li[data-state="failed"]')).toHaveCount(1);
  await expect(progress.locator('li[data-state="running"]')).toHaveCount(1);
  expect(workspace.parents()[0].status).toBe('running');
  await workspace.release();
  await expect.poll(() => workspace.parents()[0].status, { timeout: 60000 }).toBe('completed');
  await refresh(page);
  await expect(progress.locator('li[data-state="completed"]')).toHaveCount(1);
  await expect(progress.locator('li[data-state="failed"]')).toHaveCount(1);
  expect(workspace.parents()).toHaveLength(1);
  expect(handoffs).toEqual([]);
});

test('Local bulk Analyze starts and completes a real council without navigating away', async ({ page, workspace }) => {
  const handoffs = await inbox(page, workspace);
  await page.locator('#unified-tab-bar [data-tab="local-tab"]').click();
  await expect(page.locator('#local-reviews-tbody tr[data-session-id]')).toHaveCount(1);
  await page.locator('[data-selection-tab="local-tab"]').click();
  await page.locator('#local-reviews-container .select-all-checkbox').check();
  await page.locator('#local-tab .btn-bulk-analyze').click();
  const progress = await submitCouncil(page);
  await expect.poll(() => workspace.parents().map(row => row.review_type)).toEqual(['local']);
  expect(workspace.parents()[0].status).toBe('running');
  await refresh(page);
  await expect(page.locator('#local-reviews-tbody .workspace-ai-pill')).toHaveAttribute('data-ai-state', 'running');
  await workspace.release();
  await expect.poll(() => workspace.parents()[0].status, { timeout: 60000 }).toBe('completed');
  await refresh(page);
  await expect(progress.locator('li[data-state="completed"]')).toHaveCount(1);
  await expect(page.locator('#local-reviews-tbody .workspace-ai-pill')).toHaveAttribute('data-ai-state', 'reviewed');
  expect(handoffs).toEqual([]);
  await expect(page).toHaveURL(workspace.url + '/');
});
