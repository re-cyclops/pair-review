// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { publicationTest as test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

const url = '/pr/test-owner/test-repo/1';
const saved = server => JSON.parse(server.db.prepare('SELECT review_progress FROM reviews WHERE id = 1').get().review_progress);
const checkbox = (page, file) => page.locator(`.d2h-file-wrapper[data-file-name="${file}"] .file-viewed-checkbox`);
const moveHead = server => {
  const row = server.db.prepare("SELECT pr_data FROM pr_metadata WHERE repository = 'test-owner/test-repo' AND pr_number = 1").get();
  const data = { ...JSON.parse(row.pr_data), head_sha: 'b'.repeat(40) };
  server.db.prepare("UPDATE pr_metadata SET pr_data = ? WHERE repository = 'test-owner/test-repo' AND pr_number = 1").run(JSON.stringify(data));
};

test('retains legacy browser history until acknowledgement without certifying viewed content', async ({ page, testServer }) => {
  await page.goto(url);
  await waitForDiffToRender(page);
  const key = await page.evaluate(() => {
    const key = PRManager.getRepoStorageKey('pair-review-viewed', 'test-owner', 'test-repo') + ':1';
    localStorage.setItem(key, JSON.stringify(['src/main.js']));
    return key;
  });
  await page.route('**/api/reviews/1/progress', route => {
    if (route.request().method() === 'PUT' && route.request().postDataJSON()?.action === 'import-history') {
      return route.fulfill({ status: 503, json: { error: 'Fixture save unavailable' } });
    }
    return route.continue();
  });
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture save unavailable' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('["src/main.js"]');
  await page.unroute('**/api/reviews/1/progress');
  await page.reload();
  await expect.poll(() => saved(testServer).legacyFiles).toEqual(['src/main.js']);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  await expect(checkbox(page, 'src/main.js')).not.toBeChecked();
  expect(saved(testServer).reviewed).toBeUndefined();
  expect(testServer.reviewHost.state.calls).toEqual([]);
});

test('merges viewed marks across tabs without implicitly reviewing the revision', async ({ page, context, testServer }) => {
  await page.goto(url);
  await waitForDiffToRender(page);
  const peer = await context.newPage();
  try {
    await peer.goto(page.url());
    await waitForDiffToRender(peer);
    await checkbox(page, 'src/main.js').check();
    await checkbox(peer, 'src/utils.js').check();
    await expect.poll(() => Object.keys(saved(testServer).files || {}).sort()).toEqual(['src/main.js', 'src/utils.js']);
    await expect(checkbox(page, 'src/utils.js')).toBeChecked();
    await expect(checkbox(peer, 'src/main.js')).toBeChecked();
    expect(saved(testServer).reviewed).toBeUndefined();
    await page.getByRole('button', { name: 'Mark revision reviewed…', exact: true }).click();
    await page.keyboard.press('Escape');
    expect(saved(testServer).reviewed).toBeUndefined();
    await page.getByRole('button', { name: 'Mark revision reviewed…', exact: true }).click();
    await page.getByRole('button', { name: 'Mark this revision reviewed', exact: true }).click();
    await expect.poll(() => saved(testServer).reviewed?.head).toBe(testServer.reviewHost.state.head);
    expect(testServer.reviewHost.state.calls).toEqual([]);
  } finally { await peer.close(); }
});

test('rejects confirmation after the head moves without advancing the baseline', async ({ page, testServer }) => {
  await page.goto(url);
  await waitForDiffToRender(page);
  await page.getByRole('button', { name: 'Mark revision reviewed…', exact: true }).click();
  moveHead(testServer);
  await page.getByRole('button', { name: 'Mark this revision reviewed', exact: true }).click();
  await expect(page.locator('#review-progress-confirm [role="alert"]')).toBeVisible();
  expect(saved(testServer).reviewed).toBeUndefined();
  expect(testServer.reviewHost.state.calls).toEqual([]);
});

test('does not authorize a newer revision behind an already loaded older diff', async ({ page, testServer }) => {
  let moved = false;
  await page.route('**/api/reviews/1/progress', async route => {
    if (!moved && route.request().method() === 'GET') { moveHead(testServer); moved = true; }
    await route.continue();
  });
  await page.goto(url);
  await waitForDiffToRender(page);
  await expect(page.getByRole('button', { name: 'Mark revision reviewed…', exact: true })).toBeDisabled();
  await expect(page.locator('.workspace-review-progress [role="alert"]')).toContainText('displayed diff');
  expect(saved(testServer).reviewed).toBeUndefined();
  expect(testServer.reviewHost.state.calls).toEqual([]);
});

test('shows old and unknown finding revisions without rewriting the findings', async ({ page, testServer }) => {
  moveHead(testServer);
  testServer.db.prepare(`INSERT INTO analysis_runs (id, review_id, status)
    VALUES ('revision-history', 1, 'completed')`).run();
  const insert = testServer.db.prepare(`INSERT INTO comments
    (review_id, source, ai_run_id, file, is_file_level, type, title, body, status, commit_sha)
    VALUES (1, 'ai', 'revision-history', 'src/main.js', 1, 'bug', ?, ?, 'active', ?)`);
  const old = Number(insert.run('Prior revision finding', 'Original finding text.', 'c'.repeat(40)).lastInsertRowid);
  const unknown = Number(insert.run('Unrecorded revision finding', 'Imported finding text.', null).lastInsertRowid);
  await page.goto(url);
  await waitForDiffToRender(page);
  await page.getByRole('button', { name: 'Toggle Review panel', exact: true }).click();
  const oldFinding = page.locator(`.finding-item[data-id="${old}"]`);
  const unknownFinding = page.locator(`.finding-item[data-id="${unknown}"]`);
  await expect(oldFinding.locator('.ai-revision-warning')).toBeVisible();
  await expect(oldFinding).toContainText('Older revision');
  await expect(unknownFinding.locator('.ai-revision-warning')).toBeVisible();
  await expect(unknownFinding).toContainText('Revision unknown');
  await oldFinding.click();
  await expect(page.locator(`#diff-container [data-suggestion-id="${old}"] .ai-suggestion-header .ai-revision-warning`)).toBeVisible();
  expect(testServer.db.prepare('SELECT body, commit_sha FROM comments WHERE id = ?').get(old))
    .toEqual({ body: 'Original finding text.', commit_sha: 'c'.repeat(40) });
  expect(testServer.reviewHost.state.calls).toEqual([]);
});

test('keeps refreshed findings on the selected run when an older response arrives late', async ({ page, testServer }) => {
  const seed = (id, day, body) => {
    testServer.db.prepare(`INSERT INTO analysis_runs (id, review_id, status, provider, model, completed_at)
      VALUES (?, 1, 'completed', 'omp', ?, ?)`).run(id, id, `2026-01-${day}T00:00:00.000Z`);
    testServer.db.prepare(`INSERT INTO comments
      (review_id, source, ai_run_id, file, line_start, line_end, side, type, title, body, status)
      VALUES (1, 'ai', ?, 'src/main.js', 21, 21, 'RIGHT', 'bug', ?, ?, 'active')`).run(id, id, body);
  };
  seed('older-result', '01', 'Earlier finding text.');
  await page.goto(url);
  await waitForDiffToRender(page);
  await page.getByRole('button', { name: 'Toggle Review panel', exact: true }).click();
  await expect(page.locator('#diff-container')).toContainText('Earlier finding text.');
  let release, requested;
  const held = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { requested = resolve; });
  let intercept = true;
  await page.route('**/api/reviews/1/suggestions?*', async route => {
    if (!intercept) return route.continue();
    intercept = false;
    const response = await route.fetch();
    requested();
    await held;
    await route.fulfill({ response });
  });
  const earlierLoad = page.evaluate(() => window.prManager.loadAISuggestions(null, 'older-result'));
  try {
    await arrived;
    seed('newer-result', '02', 'Current finding text.');
    await page.evaluate(() => window.prManager.analysisHistoryManager.refresh({ switchToNew: true }));
    await expect(page.getByRole('button', { name: /newer-result/ })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh PR', exact: true }).click();
    await expect(page.locator('#diff-container')).toContainText('Current finding text.');
    release();
    await earlierLoad;
    await expect(page.locator('#diff-container')).toContainText('Current finding text.');
    await expect(page.locator('#diff-container')).not.toContainText('Earlier finding text.');
  } finally {
    release();
    await earlierLoad;
  }
  // A lazy diff expansion must not discard a newer render while the older one waits.
  await page.evaluate(async () => {
    const manager = window.prManager;
    const older = await (await fetch('/api/reviews/1/suggestions?runId=older-result')).json();
    const newer = await (await fetch('/api/reviews/1/suggestions?runId=newer-result')).json();
    const original = manager.ensureFileBodyRendered;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    manager.ensureFileBodyRendered = async function(file) {
      manager.ensureFileBodyRendered = original;
      await held;
      return original.call(manager, file);
    };
    const olderRender = manager.displayAISuggestions(older.suggestions);
    try {
      await manager.displayAISuggestions(newer.suggestions);
    } finally {
      release();
      await olderRender;
      manager.ensureFileBodyRendered = original;
    }
  });
  await expect(page.locator('#diff-container')).toContainText('Current finding text.');
  await expect(page.locator('#diff-container')).not.toContainText('Earlier finding text.');
});
