// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { publicationTest as test, expect } from './fixtures.js';
import { openReviewAuthoring } from './helpers.js';

const url = '/pr/test-owner/test-repo/1';
const body = 'The guard must remain intact\n\n    preserveIndentation();\n';

for (const [decision, event] of [['COMMENT', 'COMMENT'], ['APPROVE_WITH_COMMENT', 'APPROVE'], ['REQUEST_CHANGES', 'REQUEST_CHANGES']]) {
  test(`publishes only the explicitly confirmed ${decision} body, without a hidden rewrite`, async ({ page, testServer }) => {
    await page.goto(url);
    await openReviewAuthoring(page);
    await page.locator('#review-body-modal').fill(body);
    await expect(page.locator(`#review-decision option[value="${decision}"]`)).toBeEnabled();
    await page.locator('#review-decision').selectOption(decision);
    await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
    const confirm = page.getByRole('checkbox', { name: 'Confirm this exact submission manifest' });
    await expect(confirm).toBeEnabled();
    expect(testServer.reviewHost.state.calls).toEqual([]);
    await confirm.check();
    await page.keyboard.press('ControlOrMeta+Enter');
    expect(testServer.reviewHost.state.calls).toEqual([]);
    await page.getByRole('button', { name: /^Publish .* · 0 comments$/ }).click();
    await expect.poll(() => testServer.db.prepare("SELECT state FROM submission_attempts").all()).toEqual([{ state: 'submitted' }]);
    expect(testServer.reviewHost.state.calls.map(call => call.operation)).toEqual(['create', 'submit']);
    expect(testServer.reviewHost.state.calls.at(-1)).toMatchObject({ event, body });
    await expect(page.locator('#review-body-modal')).toHaveValue(body);
  });
}

test('keeps the exact body in a host draft without submitting its decision', async ({ page, testServer }) => {
  await page.goto(url);
  await openReviewAuthoring(page);
  await page.locator('#review-body-modal').fill(body);
  await page.locator('#review-publication-mode').selectOption('draft');
  await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Confirm this exact submission manifest' }).check();
  await page.getByRole('button', { name: /^Save host draft · 0 comments$/ }).click();
  await expect.poll(() => testServer.db.prepare('SELECT state FROM submission_attempts').all()).toEqual([{ state: 'draft_saved' }]);
  expect(testServer.reviewHost.state.calls.map(call => call.operation)).toEqual(['create']);
  expect([...testServer.reviewHost.state.reviews.values()][0]).toMatchObject({ body, state: 'PENDING' });
});

test('retires only published editors while keeping excluded text local', async ({ page, testServer }) => {
  await page.goto(url);
  const create = async (body, included) => {
    const response = await page.request.post('/api/reviews/1/comments', { data: {
      file: 'src/utils.js', body, included, commit_sha: testServer.reviewHost.state.head
    } });
    expect(response.ok()).toBe(true);
    return (await response.json()).commentId;
  };
  const selected = await create('Selected file invariant', true);
  const excluded = await create('Unfinished alternative', false);
  await openReviewAuthoring(page);
  await page.getByRole('textbox', { name: `Draft ${selected} exact Markdown`, exact: true }).fill('The exact revised file invariant');
  await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Confirm this exact submission manifest' }).check();
  await page.getByRole('button', { name: /^Publish .* · 1 comments$/ }).click();
  await expect.poll(() => testServer.db.prepare('SELECT state FROM submission_attempts').all()).toEqual([{ state: 'submitted' }]);
  await expect(page.getByRole('textbox', { name: `Draft ${excluded} exact Markdown`, exact: true })).toHaveValue('Unfinished alternative');
  await page.getByRole('button', { name: 'Skip — keep drafts local', exact: true }).click();
  await expect(page.locator('.workspace-draft-recovery')).toBeHidden();
  expect([...testServer.reviewHost.state.reviews.values()][0].comments.map(comment => comment.body)).toEqual(['The exact revised file invariant']);
  expect(testServer.db.prepare('SELECT status, included, body FROM comments WHERE id = ?').get(excluded))
    .toEqual({ status: 'active', included: 0, body: 'Unfinished alternative' });
});

test('treats a cleared draft as optional and submits the rest with Cmd+Enter', async ({ page, testServer }) => {
  await page.goto(url);
  const create = async (body, included) => {
    const response = await page.request.post('/api/reviews/1/comments', { data: {
      file: 'src/utils.js', body, included, commit_sha: testServer.reviewHost.state.head
    } });
    expect(response.ok()).toBe(true);
    return (await response.json()).commentId;
  };
  const selected = await create('Keep this comment', true);
  const cleared = await create('Clear me instead of deleting', true);
  await openReviewAuthoring(page);
  const clearedBox = page.getByRole('textbox', { name: `Draft ${cleared} exact Markdown`, exact: true });
  await clearedBox.fill('');
  const card = page.locator(`[data-draft-id="${cleared}"]`);
  await expect(card).toHaveAttribute('data-empty', 'true');
  await expect(card.getByText('Empty — skipped')).toBeVisible();
  const keepCard = page.locator(`[data-draft-id="${selected}"]`);
  await expect(keepCard.getByText('Empty — skipped')).toBeHidden();
  await expect(keepCard).toHaveAttribute('data-empty', 'false');
  await expect(page.getByText(/Save failed/)).toHaveCount(0);
  await expect.poll(() => testServer.db.prepare('SELECT body, included FROM comments WHERE id = ?').get(cleared))
    .toEqual({ body: '', included: 0 });
  await page.locator('#review-decision').selectOption('APPROVE');
  await page.getByRole('textbox', { name: `Draft ${selected} exact Markdown`, exact: true }).focus();
  await page.keyboard.press('Meta+Enter');
  await expect.poll(() => testServer.db.prepare('SELECT state FROM submission_attempts').all()).toEqual([{ state: 'submitted' }]);
  expect([...testServer.reviewHost.state.reviews.values()][0].comments.map(comment => comment.body)).toEqual(['Keep this comment']);
});

test('blocks an empty comment-only review but permits an explicitly confirmed empty approval', async ({ page, testServer }) => {
  await page.goto(url);
  await openReviewAuthoring(page);
  await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Confirm this exact submission manifest' })).toBeDisabled();
  expect(testServer.reviewHost.state.calls).toEqual([]);
  await page.locator('#review-decision').selectOption('APPROVE');
  await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Confirm this exact submission manifest' }).check();
  await page.getByRole('button', { name: /^Publish approve · 0 comments$/ }).click();
  await expect.poll(() => testServer.reviewHost.state.calls.at(-1)?.operation).toBe('submit');
  expect(testServer.reviewHost.state.calls.at(-1)).toMatchObject({ event: 'APPROVE', body: '' });
});

test('does not authorize newer text or a newer head with an earlier final preview', async ({ page, testServer }) => {
  await page.goto(url);
  await openReviewAuthoring(page);
  await page.locator('#review-body-modal').fill(body);
  await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Confirm this exact submission manifest' }).check();
  const changed = `${body}\nA newer observation`;
  await page.locator('#review-body-modal').fill(changed);
  await expect(page.getByRole('button', { name: /^Publish .* · 0 comments$/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Confirm this exact submission manifest' }).check();
  testServer.reviewHost.state.head = 'c'.repeat(40);
  await page.getByRole('button', { name: /^Publish .* · 0 comments$/ }).click();
  await expect(page.locator('.workspace-review-error')).toContainText(/changed|new preview/i);
  expect(testServer.reviewHost.state.calls).toEqual([]);
  await expect(page.locator('#review-body-modal')).toHaveValue(changed);
});

test('reconciles a lost final response without replaying the host write', async ({ page, testServer }) => {
  testServer.reviewHost.state.loseSubmit = true;
  await page.goto(url);
  await openReviewAuthoring(page);
  await page.locator('#review-body-modal').fill(body);
  await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Confirm this exact submission manifest' }).check();
  await page.getByRole('button', { name: /^Publish .* · 0 comments$/ }).click();
  await expect.poll(() => testServer.db.prepare('SELECT state FROM submission_attempts').all()).toEqual([{ state: 'outcome_unknown' }]);
  const writes = structuredClone(testServer.reviewHost.state.calls);
  await page.getByRole('button', { name: /Reconcile.*read.only/i }).click();
  await expect.poll(() => testServer.db.prepare('SELECT state FROM submission_attempts').all()).toEqual([{ state: 'submitted' }]);
  expect(testServer.reviewHost.state.calls).toEqual(writes);
  expect([...testServer.reviewHost.state.reviews.values()][0]).toMatchObject({ body, state: 'COMMENTED' });
});

test('acknowledges quick approval before a held comments refresh completes', async ({ page, testServer }) => {
  await page.goto(url);
  await openReviewAuthoring(page);
  await page.locator('#review-decision').selectOption('APPROVE');
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const refreshStarted = new Promise(resolve => { entered = resolve; });
  const holdRefresh = async route => {
    entered();
    await gate;
    await route.continue();
  };
  await page.route('**/api/reviews/1/comments', holdRefresh);
  try {
    await page.getByRole('button', { name: 'Submit approval', exact: true }).click();
    await refreshStarted;
    await expect(page.locator('#review-modal')).not.toBeVisible();
    await expect(page.getByText('Submitted approval to', { exact: false })).toBeVisible();
    expect(testServer.db.prepare('SELECT state, phase FROM submission_attempts').all())
      .toEqual([{ state: 'submitted', phase: 'settled' }]);
    expect(testServer.reviewHost.state.calls.map(call => call.operation)).toEqual(['create', 'submit']);
    expect([...testServer.reviewHost.state.reviews.values()]).toHaveLength(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('locks quick preflight and restores the approval action after preflight failure', async ({ page, testServer }) => {
  await page.goto(url);
  await openReviewAuthoring(page);
  await page.locator('#review-decision').selectOption('APPROVE');
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const preflightStarted = new Promise(resolve => { entered = resolve; });
  const failPreflight = async route => {
    entered();
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Preflight temporarily unavailable' }) });
  };
  await page.route('**/api/reviews/1/manifest?*', failPreflight);
  try {
    await page.getByRole('button', { name: 'Submit approval', exact: true }).click();
    await preflightStarted;
    await expect(page.locator('.workspace-submit-primary')).toBeDisabled();
    await expect(page.locator('.workspace-submit-primary')).toHaveAttribute('data-loading', 'true');
    await expect(page.getByRole('button', { name: 'Prepare exact final preview', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Reload saved drafts', exact: true })).toBeDisabled();
    await expect(page.locator('#review-decision')).toBeDisabled();
    expect(testServer.reviewHost.state.calls).toEqual([]);
    release();
    await expect(page.locator('.workspace-review-error')).toContainText('Preflight temporarily unavailable');
    await expect(page.locator('.workspace-review-error')).toBeFocused();
    await expect(page.locator('.workspace-review-error')).toBeInViewport({ ratio: 1 });
    const retry = page.getByRole('button', { name: 'Submit approval', exact: true });
    await expect(retry).toBeEnabled();
    await expect(retry).not.toHaveAttribute('data-loading', 'true');
    expect(testServer.reviewHost.state.calls).toEqual([]);
    expect(testServer.db.prepare('SELECT state FROM submission_attempts').all()).toEqual([]);
    await page.unrouteAll({ behavior: 'wait' });
    await retry.click();
    await expect(page.locator('#review-modal')).not.toBeVisible();
    await expect(page.getByText('Submitted approval to', { exact: false })).toBeVisible();
    await expect(page.locator('.workspace-submit-primary')).not.toHaveAttribute('data-loading', 'true');
    expect(testServer.db.prepare('SELECT state, phase FROM submission_attempts').all())
      .toEqual([{ state: 'submitted', phase: 'settled' }]);
    expect(testServer.reviewHost.state.calls.map(call => call.operation)).toEqual(['create', 'submit']);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('keeps remote approval visible while finishing failed local cleanup without another host write', async ({ page, testServer }, testInfo) => {
  await page.goto(url);
  const created = await page.request.post('/api/reviews/1/comments', { data: {
    file: 'src/utils.js', body: 'Approved file invariant', included: true, commit_sha: testServer.reviewHost.state.head
  } });
  expect(created.ok()).toBe(true);
  const { commentId } = await created.json();
  await openReviewAuthoring(page);
  await page.locator('#review-decision').selectOption('APPROVE');
  testServer.db.exec(`CREATE TRIGGER fail_submission_cleanup BEFORE UPDATE OF status ON comments
    WHEN NEW.status = 'submitted'
    BEGIN SELECT RAISE(ABORT, 'fixture cleanup failure'); END;`);
  try {
    await page.getByRole('button', { name: 'Submit approval', exact: true }).click();
    await expect(page.getByText('Submitted approval to', { exact: false })).toBeVisible();
    await expect(page.locator('#review-modal')).toBeVisible();
    await expect(page.locator('.workspace-review-receipts')).toContainText('fixture cleanup failure');
    const cleanup = page.getByRole('button', { name: 'Finish local cleanup (no host write)', exact: true });
    await expect(cleanup).toBeEnabled();
    await expect(cleanup).toBeFocused();
    await expect(cleanup).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.workspace-review-receipts').getByText(/fixture cleanup failure/)).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.workspace-submit-primary')).toBeDisabled();
    const warningScreenshot = testInfo.outputPath('approval-cleanup-warning.png');
    await page.screenshot({ path: warningScreenshot });
    await testInfo.attach('approval-cleanup-warning', { path: warningScreenshot, contentType: 'image/png' });
    await expect(page.locator('.workspace-submit-primary')).not.toHaveAttribute('data-loading', 'true');
    expect(testServer.db.prepare('SELECT state, phase FROM submission_attempts').all())
      .toEqual([{ state: 'submitted', phase: 'settled' }]);
    const writes = structuredClone(testServer.reviewHost.state.calls);
    expect(writes.filter(call => call.operation === 'create')).toHaveLength(1);
    expect(writes.filter(call => call.operation === 'submit')).toHaveLength(1);
    expect([...testServer.reviewHost.state.reviews.values()][0].comments.map(comment => comment.body))
      .toEqual(['Approved file invariant']);
    testServer.db.exec('DROP TRIGGER fail_submission_cleanup');
    await cleanup.click();
    await expect(cleanup).toHaveCount(0);
    await expect(page.locator('.workspace-review-receipts')).not.toContainText('fixture cleanup failure');
    await expect(page.getByRole('textbox', { name: `Draft ${commentId} exact Markdown`, exact: true })).toHaveCount(0);
    await expect(page.locator('.workspace-submit-primary')).not.toHaveAttribute('data-loading', 'true');
    expect(testServer.db.prepare('SELECT status FROM comments WHERE id = ?').get(commentId)).toEqual({ status: 'submitted' });
    expect(testServer.reviewHost.state.calls).toEqual(writes);
    expect([...testServer.reviewHost.state.reviews.values()][0].state).toBe('APPROVED');
  } finally {
    testServer.db.exec('DROP TRIGGER IF EXISTS fail_submission_cleanup');
  }
});
