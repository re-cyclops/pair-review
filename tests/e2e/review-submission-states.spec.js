// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { publicationTest as test, expect } from './fixtures.js';
import { openReviewAuthoring } from './helpers.js';

const url = '/pr/test-owner/test-repo/1';

test('preserves pending body text, caret and modal ownership through the command palette', async ({ page, testServer }) => {
  await page.goto(url);
  await openReviewAuthoring(page);
  const body = 'The interrupted request must retain its guard\n\n    keepTechnicalIndentation();\n';
  const editor = page.locator('#review-body-modal');
  await editor.fill(body);
  await editor.evaluate(element => element.setSelectionRange(4, 13));
  await page.keyboard.press('ControlOrMeta+K');
  await expect(page.locator('#workspace-commands')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Enter');
  expect(testServer.reviewHost.state.calls).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(body);
  expect(await editor.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([4, 13]);
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('#workspace-commands').getByRole('combobox').fill('final preview');
  await page.keyboard.press('Enter');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(body);
  await page.getByRole('button', { name: 'Skip — keep drafts local', exact: true }).click();
  await page.getByRole('link', { name: 'Review inbox', exact: true }).click();
  await page.goto(url);
  await openReviewAuthoring(page);
  await expect(editor).toHaveValue(body);
  expect(testServer.db.prepare('SELECT draft_body FROM reviews WHERE id = 1').get().draft_body).toBe(body);
  expect(testServer.reviewHost.state.calls).toEqual([]);
});

test('retains both summary versions after a failed save and a second-tab edit', async ({ page, context, testServer }) => {
  await page.goto(url);
  await openReviewAuthoring(page);
  const peer = await context.newPage();
  try {
    await peer.goto(page.url());
    await openReviewAuthoring(peer);
    await page.route('**/api/reviews/1/draft', route => route.request().method() === 'PUT' ? route.abort('failed') : route.continue());
    const mine = 'An offline observation\n\n    preserveMine();\n';
    const theirs = 'The other tab has newer evidence\n\n    preserveTheirs();\n';
    await page.locator('#review-body-modal').fill(mine);
    await expect(page.getByText(/^Save failed:/)).toBeVisible();
    await peer.locator('#review-body-modal').fill(theirs);
    await expect.poll(() => testServer.db.prepare('SELECT draft_body FROM reviews WHERE id = 1').get().draft_body).toBe(theirs);
    await page.unroute('**/api/reviews/1/draft');
    await page.getByRole('button', { name: 'Prepare exact final preview', exact: true }).click();
    await expect(page.getByText('Conflict: both versions retained', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resolve draft', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Your recoverable text' })).toHaveValue(mine);
    await expect(page.locator('#workspace-draft-recovery pre')).toHaveText(theirs);
    expect(testServer.db.prepare('SELECT draft_body FROM reviews WHERE id = 1').get().draft_body).toBe(theirs);
    await page.getByRole('button', { name: 'Use the server version; discard my local edits', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#review-body-modal')).toHaveValue(theirs);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('pair-review:draft:')))).toEqual([]);
    expect(testServer.reviewHost.state.calls).toEqual([]);
  } finally { await peer.close(); }
});
