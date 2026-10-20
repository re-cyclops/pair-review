// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test as base, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const Database = require('better-sqlite3');
const serverScript = require.resolve('../utils/workspace-server.js');

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
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'review-clarity-e2e-'));
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
        url, home, rows, ready,
        control: async changes => {
          const response = await fetch(`http://127.0.0.1:${ready.adminPort}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
          expect(response.ok).toBeTruthy();
          return response.json();
        },
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


// Browser traffic stays on this test's application. GitHub/provider transport is
// isolated by workspace-server, never replaced with application route responses.
test.beforeEach(async ({ context, workspace }) => {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'].includes(url.hostname)) return route.abort('blockedbyclient');
    if (url.origin !== workspace.url) throw new Error('Forbidden external browser request: ' + url);
    return route.continue();
  });
});

const prRow = (page, number) => page.locator('#recent-reviews-tbody tr[data-repo="alpha"][data-number="' + number + '"]');
const finding = { file: 'sample.js', line_start: 2, line_end: 2, old_or_new: 'NEW', type: 'bug', title: 'Changed assignment loses invariant', description: 'The changed value must retain the invariant.', confidence: 0.99 };

async function analyze(page, workspace, endpoint, suggestions = [finding]) {
  await workspace.control({ providerResult: { suggestions, provider: 'google-antigravity', model: 'gemini-3.8-flash', capture: true } });
  const response = await page.request.post(workspace.url + endpoint, { data: { provider: 'omp', model: 'default', enabledLevels: [1] } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const { analysisId } = await response.json();
  expect(analysisId).toBeTruthy();
  await expect.poll(() => workspace.rows().find(row => row.id === analysisId)?.status, { timeout: 60000 }).toBe('completed');
  return analysisId;
}

async function openFindings(page, count) {
  const action = page.locator('#ai-panel-toggle');
  await expect(action).toContainText(count + ' AI finding');
  await action.click();
  await expect(page.locator('#ai-panel')).not.toHaveClass(/collapsed/);
  await expect(page.locator('#findings-list .finding-item[data-item-type="finding"]')).toHaveCount(count);
}

test('Requested lane uses earliest direct history, labelled team fallback and unknown rather than PR dates', async ({ page, workspace }) => {
  await page.goto(workspace.url);
  await expect(page.locator('#recent-reviews-tbody tr[data-review-id]')).toHaveCount(4);
  await expect(page.getByRole('columnheader', { name: /requested/i })).toBeVisible();
  const snapshot = await (await page.request.get(workspace.url + '/api/pr/example/alpha/42/snapshot')).json();
  const request = snapshot.snapshot?.viewer?.reviewRequest || snapshot.viewer?.reviewRequest;
  expect(request.availability).toBe('known');
  expect(request.source).toBe('direct');
  const host = JSON.parse(await fs.readFile(path.join(workspace.home, 'synthetic-host.json'), 'utf8'));
  const original = host.prs.find(([key]) => key === 'example/alpha#42')[1];
  expect(request.firstRequestedAt).toBe(original.timeline[0].created_at);
  expect(request.firstRequestedAt).not.toBe(original.created_at);
  await expect(prRow(page, 42).locator('.col-requested [title]').first()).toHaveAttribute('title', new RegExp(request.firstRequestedAt));
  await expect(prRow(page, 42).locator('.col-requested')).toContainText('@maintainer');
  await expect(prRow(page, 43).locator('.col-requested')).toContainText(/team/i);
  await expect(prRow(page, 43).locator('.col-requested')).toContainText(/Maintainers/i);
  await expect(prRow(page, 44).locator('.col-requested time')).not.toHaveAttribute('datetime');
  await expect(prRow(page, 43).locator('.col-state .workspace-review-decisions')).toContainText('@maintainer');
  await expect(prRow(page, 42).locator('.col-actions')).not.toContainText('Review requested changes');
});

test('selected bulk AI lifecycle occupies its own lane and preserves actual served model evidence', async ({ page, workspace }) => {
  await page.goto(workspace.url);
  await expect(prRow(page, 42).locator('.col-ai [data-ai-state="unreviewed"]')).toBeVisible();
  await page.locator('[data-selection-tab="pr-tab"]').click();
  for (const number of [42, 43]) await prRow(page, number).locator('input[type="checkbox"]').check();
  await page.locator('#pr-tab .btn-bulk-analyze').click();
  await page.locator('#analysis-config-modal [data-tab="council"]').click();
  await page.selectOption('#vc-template-selector', 'four-model-focused');
  await page.locator('#analysis-config-modal [data-action="submit"]').click();
  await expect.poll(() => workspace.parents().map(row => row.status)).toEqual(['running', 'running']);
  await page.evaluate(() => window.reviewWorkspace.refresh());
  for (const number of [42, 43]) await expect(prRow(page, number).locator('.col-ai [data-ai-state="running"]')).toBeVisible();
  await workspace.release();
  await expect.poll(() => workspace.parents().map(row => row.status), { timeout: 60000 }).toEqual(['completed', 'completed']);
  await page.evaluate(() => window.reviewWorkspace.refresh());
  for (const number of [42, 43]) {
    await expect(prRow(page, number).locator('.col-ai [data-ai-state="reviewed"]')).toBeVisible();
    await expect(prRow(page, number).locator('.col-ai')).toContainText('gemini-3.8-flash');
  }
  expect((await workspace.captures()).length).toBeGreaterThanOrEqual(8);
});

for (const mode of ['PR', 'Local']) {
  test(mode + ' findings action distinguishes not reviewed, zero and actionable findings', async ({ page, workspace }) => {
    const localId = workspace.ready.localReview.sessionId;
    const target = mode === 'PR' ? '/pr/example/alpha/42' : '/local/' + localId;
    const endpoint = mode === 'PR' ? '/api/pr/example/alpha/42/analyses' : '/api/local/' + localId + '/analyses';
    await page.goto(workspace.url + target);
    await expect(page.locator('#ai-panel-toggle')).toContainText(/Not reviewed/);
    await expect(page.getByRole('button', { name: 'Mark revision reviewed…', exact: true })).toBeEnabled();
    await analyze(page, workspace, endpoint, []);
    await page.reload();
    await openFindings(page, 0);
    await expect(page.locator('#findings-list')).not.toContainText('Ready for AI Review');
    const line = mode === 'Local' ? 41 : 2;
    await analyze(page, workspace, endpoint, [{
      ...finding, line_start: line, line_end: line,
      description: Array.from({ length: 12 }, () => finding.description).join('\n\n')
    }]);
    await page.reload();
    await openFindings(page, 1);
    const item = page.locator('#findings-list .finding-item[data-item-type="finding"]');
    await expect(item).toHaveAttribute('data-file', 'sample.js');
    await expect(item).toHaveAttribute('data-line', String(line));
    const id = await item.getAttribute('data-id');
    await item.click();
    const codeFinding = page.locator('.ai-suggestion[data-suggestion-id="' + id + '"]');
    await expect(codeFinding).toBeVisible();
    await expect(codeFinding.locator('xpath=ancestor::*[@data-file-name][1]')).toHaveAttribute('data-file-name', 'sample.js');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#ai-panel')).toBeVisible();
    await item.click();
    await expect(page.locator('#ai-panel')).toBeHidden();
    await expect(codeFinding).toBeInViewport();
    const action = page.locator('#ai-panel-toggle');
    const bounds = await action.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await action.click();
    await expect(page.locator('#ai-panel')).toBeVisible();
    await expect(action).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#ai-panel .ai-panel-close').click();
    await expect(page.locator('#diff-container')).toBeVisible();
    await expect(action).toBeFocused();
    for (const [width, reducedMotion] of [[1440, 'no-preference'], [390, 'reduce']]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion });
      await codeFinding.locator('.ai-action-edit').click();
      const editor = page.locator(`.user-comment-form[data-annotation-id="edit-suggestion-${id}"]`);
      await expect(editor.locator('textarea')).toBeFocused();
      await expect(editor.locator('.comment-form-header')).toBeInViewport({ ratio: 1 });
      await expect.poll(() => editor.evaluate(element => {
        const header = element.closest('.d2h-file-wrapper').querySelector('.d2h-file-header');
        return element.getBoundingClientRect().top >= header.getBoundingClientRect().bottom - 2;
      })).toBe(true);
      await editor.locator('.cancel-comment-btn').click();
      await expect(editor).toHaveCount(0);
      await expect(codeFinding.locator('.ai-action-edit')).toBeVisible();
    }
  });
}

test('explicit stale update retains draft/history and historical findings open their saved code', async ({ page, workspace }) => {
  const runId = await analyze(page, workspace, '/api/pr/example/alpha/42/analyses');
  const before = await workspace.control({});
  const ordinary = await (await page.request.get(workspace.url + '/api/analyses/runs/' + runId)).json();
  expect(ordinary.run).not.toHaveProperty('diff');
  const historical = await (await page.request.get(workspace.url + '/api/analyses/runs/' + runId + '?includeDiff=true')).json();
  expect(historical.run.diff).toBe(workspace.rows().find(row => row.id === runId).diff);
  expect(historical.run.diff).toContain('const value2 = 101;');
  const drafts = before.comments.filter(comment => comment.review_id === 1);
  expect(drafts.length).toBeGreaterThan(0);
  const repo = path.join(workspace.home, 'repository');
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, HOME: workspace.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git(['checkout', '-q', 'review-head']);
  await fs.writeFile(path.join(repo, 'sample.js'), 'const revisedOnly = true;\n');
  git(['add', 'sample.js']);
  git(['commit', '-qm', 'Advance synthetic PR']);
  const head = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/pull/42/head', head]);
  await workspace.control({ pr: { head: { ref: 'review-head', sha: head } } });
  await page.goto(workspace.url + '/pr/example/alpha/42');
  const banner = page.locator('#stale-badge');
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Update to latest commits' }).click();
  await expect(banner).toBeHidden();
  await expect(page.locator('#diff-container')).toContainText('revisedOnly');
  await expect(page.getByRole('button', { name: 'Mark revision reviewed…', exact: true })).toBeEnabled();
  const after = await workspace.control({});
  expect(after.comments.filter(comment => comment.review_id === 1)).toEqual(drafts);
  expect(workspace.parents().map(row => row.id)).toEqual([runId]);
  await expect(page.locator('#ai-panel-toggle')).toContainText(/Historical/);
  await page.locator('#ai-panel-toggle').click();
  await expect(page.locator('.ai-revision-notice')).toBeVisible();
  await page.locator('#findings-list .finding-item[data-item-type="finding"]').click();
  const saved = page.locator('.historical-diff-dialog');
  await expect(saved).toBeVisible();
  await expect(saved.locator('.historical-diff-target')).toContainText('const value2 = 101;');
  await expect(saved).not.toContainText('revisedOnly');
  await workspace.control({ importResult: 'legacy-without-saved-diff' });
  const legacy = await (await page.request.get(workspace.url + '/api/analyses/runs/legacy-without-saved-diff?includeDiff=true')).json();
  expect(legacy.run.diff).toBeNull();
});
