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
