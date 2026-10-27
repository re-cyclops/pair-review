// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';

const stamp = '2026-10-20T10:00:00Z';
const collectionPrs = [1, 2].map(number => ({ owner: 'test-owner', repo: 'test-repo', number, title: `Review request ${number}`, author: 'alice', updated_at: stamp, html_url: `https://github.com/test-owner/test-repo/pull/${number}` }));
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function prepare(page) {
  const forbidden = [];
  page.on('popup', () => forbidden.push('popup'));
  await page.route('**/api/bulk-open', route => { forbidden.push('bulk-open'); return json(route, { success: true, opened: 0 }); });
  await page.route('**/api/bulk-analysis-configs', route => { forbidden.push('config relay'); return json(route, { error: 'Inbox must launch directly' }, 500); });
  await page.route('**/api/github/review-requests**', route => json(route, { prs: collectionPrs, fetched_at: stamp }));
  await page.route('**/api/repos/test-owner/test-repo/settings', route => json(route, { repository: 'test-owner/test-repo', default_provider: 'claude', default_model: 'sonnet-4.6' }));
  await page.addInitScript(() => localStorage.clear());
  return forbidden;
}

async function selectRequests(page) {
  await page.goto('/');
  await page.click('#unified-tab-bar [data-tab="review-requests-tab"]');
  await expect(page.locator('#review-requests-tbody .collection-pr-row')).toHaveCount(2);
  await page.click('[data-selection-tab="review-requests-tab"]');
  await page.check('#review-requests-container .select-all-checkbox');
  await page.locator('#review-requests-tab .btn-bulk-analyze').click();
  await expect(page.locator('#analysis-config-modal')).toBeVisible();
}

test('NO_OPEN inbox launches selected PRs directly and retains partial failure and authoritative progress', async ({ page }) => {
  const forbidden = await prepare(page);
  const launches = [];
  let releaseSetup;
  const setupGate = new Promise(resolve => { releaseSetup = resolve; });
  await page.route('**/api/setup/pr/test-owner/test-repo/*', async route => {
    await setupGate;
    return json(route, { setupId: `setup-${route.request().url().split('/').pop()}` });
  });
  await page.route('**/api/setup/setup-*/status', route => json(route, { status: 'complete' }));
  await page.route('**/api/pr/test-owner/test-repo/*/analyses', route => {
    launches.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.request().url().includes('/1/analyses') ? json(route, { analysisId: 'bulk-pr-1' }) : json(route, { error: 'Provider credentials unavailable' }, 503);
  });
  let runs = [];
  await page.route('**/api/analyses/activity', async route => {
    const response = await route.fetch();
    const data = await response.json();
    return json(route, { ...data, runs });
  });
  await selectRequests(page);
  await page.fill('#custom-instructions', 'Check every selected change.');
  await page.click('#analysis-config-modal [data-action="submit"]');
  const progress = page.getByRole('region', { name: 'Bulk analysis progress' });
  await expect(progress.locator('li')).toHaveCount(2);
  await expect(progress).toContainText('Keep this page open');
  await expect(page.locator('#review-requests-tbody .workspace-ai-pill').first()).toContainText('Preparing');
  await expect(page.locator('#review-requests-tab .btn-bulk-analyze')).toBeDisabled();
  releaseSetup();
  await expect(progress).toContainText('Provider credentials unavailable');
  await expect(progress).toContainText('Accepted by server');
  expect(launches).toHaveLength(2);
  expect(launches[0].body).toMatchObject({ provider: 'claude', model: 'sonnet-4.6', customInstructions: 'Check every selected change.' });
  expect(forbidden).toEqual([]);
  runs = [{ analysisId: 'bulk-pr-1', reviewId: 1, reviewType: 'pr', repository: 'test-owner/test-repo', prNumber: 1, host: null, status: 'running', stage: 'Reviewing repository context', observation: 'live', sequence: 1, startedAt: stamp }];
  await page.evaluate(() => window.reviewWorkspace.refresh());
  await expect(progress).toContainText('Reviewing repository context');
  runs = [{ ...runs[0], status: 'completed', stage: 'Complete', sequence: 2, completedAt: stamp }];
  await page.evaluate(() => window.reviewWorkspace.refresh());
  await expect(progress).toContainText('completed · Complete');
  await progress.locator('summary').click();
  await expect(progress.getByRole('link', { name: 'test-owner/test-repo #1', exact: true })).toHaveAttribute('href', '/pr/test-owner/test-repo/1');
  await progress.getByRole('button', { name: 'Open Activity' }).click();
  await expect(page.locator('[data-run-id="bulk-pr-1"]')).toContainText('completed');
});

test('Local inbox dispatches the selected saved council and never opens a review tab', async ({ page }) => {
  const forbidden = await prepare(page);
  const launches = [];
  const councilConfig = { voices: [{ provider: 'claude', model: 'sonnet-4.6', tier: 'balanced' }], levels: { '1': true, '2': true, '3': true }, consolidation: { provider: 'claude', model: 'sonnet-4.6', tier: 'balanced' } };
  await page.route('**/api/councils', route => json(route, { councils: [{ id: 'bulk-saved', name: 'Inbox council', type: 'council', config: councilConfig }] }));
  await page.route('**/api/local/sessions?*', route => json(route, { success: true, sessions: [{ id: 42, repository: 'test-owner/test-repo', name: 'Local checkout', local_path: '/isolated/checkout', updated_at: stamp }], hasMore: false }));
  await page.route('**/api/local/42/check-stale', route => json(route, { isStale: false }));
  await page.route('**/api/local/42/analyses/council', route => {
    launches.push(route.request().postDataJSON());
    return json(route, { analysisId: 'bulk-local-42' });
  });
  await page.goto('/');
  await page.click('#unified-tab-bar [data-tab="local-tab"]');
  await expect(page.locator('#local-reviews-tbody tr')).toHaveCount(1);
  await page.click('[data-selection-tab="local-tab"]');
  await page.check('#local-reviews-container .select-all-checkbox');
  await page.locator('#local-tab .btn-bulk-analyze').click();
  await page.locator('#analysis-config-modal [data-tab="council"]').click();
  await page.selectOption('#vc-council-selector', 'bulk-saved');
  await page.fill('#vc-custom-instructions', 'Check local boundaries.');
  await page.click('#analysis-config-modal [data-action="submit"]');
  const progress = page.getByRole('region', { name: 'Bulk analysis progress' });
  await expect(progress).toContainText('Accepted by server');
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({ councilId: 'bulk-saved', configType: 'council', customInstructions: 'Check local boundaries.', councilConfig: { voices: [{ provider: 'claude', model: 'sonnet-4.6' }] } });
  await expect(page.locator('#local-reviews-tbody .workspace-ai-pill')).toContainText('Accepted by server');
  expect(forbidden).toEqual([]);
});
