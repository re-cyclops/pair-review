// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Editing a comment already posted to GitHub updates that GitHub comment in
 * place; pair-review never posts a second copy. Covers the "Edited since
 * posted" note, explicit "Update on GitHub" action, review history, and
 * their absence in local mode.
 */
import { publicationTest as test, expect } from './fixtures.js';
import { waitForDiffToRender, submitReviewViaManifest, editReviewComment } from './helpers.js';

const PR_URL = '/pr/test-owner/test-repo/1';

async function openFreshPR(page, testServer) {
  await page.goto(PR_URL);
  await waitForDiffToRender(page);
  const reviewId = await page.evaluate(() => window.prManager.currentPR.id);
  // This scenario owns a fresh database and native HTTP host.
  return reviewId;
}

async function createFileComment(page, reviewId, body) {
  const commit_sha = await page.evaluate(() => window.prManager.currentPR.head_sha);
  const response = await page.request.post(`/api/reviews/${reviewId}/comments`, { data: { file: 'src/utils.js', body, commit_sha } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).commentId;
}

async function submit(page, event = 'COMMENT', body = 'Review body') {
  const reviewId = await page.evaluate(() => window.prManager.currentPR.id);
  return submitReviewViaManifest(page, reviewId, { event, body });
}

function postings(testServer, commentId) {
  return testServer.db.prepare('SELECT kind, body FROM comment_postings WHERE comment_id = ? ORDER BY id').all(commentId);
}

async function reload(page) {
  await page.reload();
  await waitForDiffToRender(page);
}

test.describe('edited posted comments (PR mode)', () => {
  test('editing a posted comment offers Update on GitHub, which edits the GitHub comment in place', async ({ page, testServer }) => {
    const reviewId = await openFreshPR(page, testServer);
    const id = await createFileComment(page, reviewId, 'Posted once');
    await submit(page);
    await reload(page);

    const card = page.locator(`.file-comment-card[data-comment-id="${id}"]`);
    await expect(card.locator('a.posted-comment-icon')).toBeVisible();
    await expect(card.locator('.posted-comment-edited')).toHaveCount(0);

    // Edit in the UI: the note appears without a reload
    await card.locator('.btn-edit-comment').click();
    await card.locator('.file-comment-textarea').fill('Posted once, then edited');
    await card.locator('.save-edit-btn').click();
    const note = card.locator('.posted-comment-edited');
    await expect(note).toContainText('Edited since posted');
    expect(await page.evaluate(() => window.prManager.getPendingCommentCount())).toBe(0);

    await note.getByRole('button', { name: 'Update on GitHub' }).click();
    await expect(card.locator('.posted-comment-edited')).toHaveCount(0);
    await expect(card.locator('.user-comment-body')).toContainText('Posted once, then edited');
    const rows = postings(testServer, id);
    expect(rows.map(r => r.kind)).toEqual(['post', 'update']);
    expect(rows[1].body).toContain('Posted once, then edited');

    // Still clear after a reload: the server agrees nothing changed since
    await reload(page);
    await expect(card.locator('.user-comment-body')).toContainText('Posted once, then edited');
    await expect(card.locator('.posted-comment-edited')).toHaveCount(0);
  });

  test('a failed update shows the error, keeps the comment edited and posts nothing', async ({ page, testServer }) => {
    const reviewId = await openFreshPR(page, testServer);
    const id = await createFileComment(page, reviewId, 'Will be deleted on GitHub');
    await submit(page);
    testServer.reviewHost.state.failEdit = 404;
    await editReviewComment(page, reviewId, id, 'Edited after the remote comment was deleted');
    await reload(page);

    const card = page.locator(`.file-comment-card[data-comment-id="${id}"]`);
    const button = card.getByRole('button', { name: 'Update on GitHub' });
    await button.click();
    const error = card.locator('.posted-comment-update-error');
    await expect(error).toBeVisible();
    await expect(error).not.toBeEmpty();
    await expect(card.locator('.posted-comment-edited-label')).toHaveText('Edited since posted');
    await expect(button).toBeEnabled();
    expect(postings(testServer, id).map(r => r.kind)).toEqual(['post']);
    expect(await page.evaluate(() => window.prManager.getPendingCommentCount())).toBe(0);
  });


  test('review history lists submissions, drills into comments, navigates back and jumps to a comment', async ({ page, testServer }, testInfo) => {
    const reviewId = await openFreshPR(page, testServer);
    await page.setViewportSize({ width: 1440, height: 900 });
    const historyBody = 'History original\n\n```suggestion\nconst value = 42;\n```';
    const id = await createFileComment(page, reviewId, historyBody);
    await submit(page, 'APPROVE', 'History approval\n\nFull **review** summary.');
    await reload(page);
    const cardBody = page.locator(`.file-comment-card[data-comment-id="${id}"] .user-comment-body`);
    await expect(cardBody.locator('pre code.language-suggestion')).toBeVisible();
    const cardMarkup = await cardBody.innerHTML();
    const codeStyles = await cardBody.locator('pre').evaluate(el => {
      const style = getComputedStyle(el);
      return { padding: style.padding, border: style.border, background: style.backgroundColor };
    });
    await editReviewComment(page, reviewId, id, 'History edited');
    const update = await page.request.post(`/api/reviews/${reviewId}/comments/${id}/update-on-github`);
    expect(update.ok()).toBeTruthy();
    await createFileComment(page, reviewId, 'A separate submission comment');
    await submit(page, 'REQUEST_CHANGES', 'History follow-up');
    const history = await (await page.request.get(`/api/reviews/${reviewId}/submissions`)).json();
    await reload(page);
    // As in the chat specs, Pi isn't installed in E2E: enable the availability gate.
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-chat', 'available');
      window.__pairReview = window.__pairReview || {};
      window.__pairReview.chatProvider = 'pi';
      window.__pairReview.chatProviders = [{ id: 'pi', name: 'Pi', type: 'pi', available: true }];
      window.dispatchEvent(new CustomEvent('chat-state-changed', { detail: { state: 'available' } }));
    });
    await page.locator('#chat-toggle-btn').click();
    const chat = page.locator('.chat-panel');
    await expect(chat).toBeVisible();

    await page.locator('#split-button-dropdown-toggle').click();
    await page.getByRole('menuitem', { name: 'Review history' }).click();
    const modal = page.locator('#review-history-modal');
    await expect(modal).toBeVisible();
    const rows = modal.locator('.review-history-row');
    await expect(rows).toHaveCount(history.submissions.length);
    await expect(rows.first()).toContainText('History follow-up');
    await expect(rows.first().locator('button')).toBeFocused();
    await expect(modal.locator('.review-history-comment')).toHaveCount(0);
    const approval = rows.filter({ hasText: 'History approval' });
    await expect(approval.locator('.review-history-chip')).toHaveText('Approved');
    await expect(approval.locator('.review-history-counts')).toHaveText('1 comment · 1 edit');
    await expect(approval.locator('.review-history-summary-preview')).toHaveText('History approval');
    await expect(approval.locator('.review-history-link')).toHaveAttribute('href', /pullrequestreview-/);
    await approval.locator('button').focus();
    await page.keyboard.press('Enter');
    const back = modal.getByRole('button', { name: '← Back' });
    await expect(back).toBeFocused();
    await expect(modal.locator('.review-history-comment')).toHaveCount(2);
    await expect(modal.locator('.review-history-summary strong')).toHaveText('review');
    await expect(modal).not.toContainText('A separate submission comment');
    await back.click();
    await expect(approval.locator('button')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(back).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    await expect(chat).toBeVisible();
    await expect(approval.locator('button')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(chat).toBeVisible();
    await expect(page.locator('#split-button-dropdown-toggle')).toBeFocused();

    // Reopen at the list, then jump from the historical edit to the diff.
    await page.locator('#split-button-dropdown-toggle').click();
    await page.getByRole('menuitem', { name: 'Review history' }).click();
    await approval.locator('button').click();
    const editedItem = modal.locator('.review-history-comment[data-posting-kind="update"]');
    await expect(editedItem).toContainText('History edited');
    await expect(editedItem.locator('.review-history-chip-edited')).toHaveText('edited');
    const original = modal.locator('.review-history-comment[data-posting-kind="post"]');
    const body = original.locator('.user-comment-body');
    await expect(body.locator('pre code.language-suggestion')).toHaveText('const value = 42;\n');
    expect(await body.innerHTML()).toBe(cardMarkup);
    expect(await body.locator('pre').evaluate(el => {
      const style = getComputedStyle(el);
      return { padding: style.padding, border: style.border, background: style.backgroundColor };
    })).toEqual(codeStyles);
    const headerBox = await original.locator('.review-history-comment-header').boundingBox();
    const bodyBox = await body.boundingBox();
    const paragraphBox = await body.locator('p').boundingBox();
    const suggestionBox = await body.locator('pre').boundingBox();
    expect(bodyBox.y - (headerBox.y + headerBox.height)).toBeGreaterThanOrEqual(16);
    expect(suggestionBox.y - (paragraphBox.y + paragraphBox.height)).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: testInfo.outputPath('history-after.png') });

    await editedItem.locator('.review-history-comment-body').click();
    await expect(modal).toBeHidden();
    await expect(page.locator(`.file-comment-card[data-comment-id="${id}"]`)).toBeInViewport();
  });
});

test.describe('local mode', () => {
  test('has no update action and no review history entry', async ({ page, testServer }) => {
    await page.goto('/local/2');
    await waitForDiffToRender(page);
    const reviewId = await page.evaluate(() => window.prManager.currentPR?.id);
    expect(reviewId).toBeTruthy();
    const files = await page.evaluate(() => [...document.querySelectorAll('[data-file-name]')].map(el => el.dataset.fileName).filter(Boolean));
    const response = await page.request.post(`/api/reviews/${reviewId}/comments`, { data: { file: files[0], body: 'Local comment' } });
    expect(response.ok()).toBeTruthy();
    const id = (await response.json()).commentId;
    // Even a comment that somehow carries a posting must not offer an update locally
    testServer.db.prepare("INSERT INTO comment_postings (comment_id, comment_body, body, file, is_file_level) VALUES (?, 'old', 'old', ?, 1)").run(id, files[0]);
    await reload(page);

    await expect(page.locator(`[data-comment-id="${id}"]`).first()).toBeVisible();
    await expect(page.locator('.btn-update-on-host')).toHaveCount(0);
    await page.locator('#split-button-dropdown-toggle').click();
    await expect(page.locator('.split-button-menu-item[data-action="preview"]')).toBeVisible();
    await expect(page.locator('.split-button-menu-item[data-action="history"]')).toHaveCount(0);
  });
});
