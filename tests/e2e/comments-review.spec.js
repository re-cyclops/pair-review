// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: Comments and Review Submission
 *
 * Tests the comment creation, management, and review submission flows.
 * The test server is started via global-setup.js with pre-seeded test data.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, hoverDiffLine } from './helpers.js';

test.describe('Comment Creation', () => {

  test('retains a new comment when closing the editor before autosave', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);
    await hoverDiffLine(page, 0);
    await page.locator('.pierre-comment-btn').first().click();

    const form = page.locator('.user-comment-form');
    const body = 'Keep this new draft after closing the editor';
    await form.locator('textarea').fill(body);
    const saved = page.waitForResponse(response =>
      response.url().endsWith('/api/reviews/1/comments') &&
      response.request().method() === 'POST' && response.ok());
    await form.getByRole('button', { name: 'Close', exact: true }).click();
    expect((await (await saved).json()).comment.body).toBe(body);
    await expect(form).not.toBeVisible();

    await page.reload();
    await waitForDiffToRender(page);
    await expect(page.locator('.user-comment-body')).toContainText(body);
  });
});


test.describe('API Integration', () => {
  test('should fetch PR data from API on page load', async ({ page }) => {
    // Set up response listener before navigation
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/pr/') && response.status() === 200
    );

    await page.goto('/pr/test-owner/test-repo/1');

    // Should have made API call for PR data
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('should fetch diff data from API', async ({ page }) => {
    // Set up response listener
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/diff') && response.status() === 200,
      { timeout: 15000 }
    );

    await page.goto('/pr/test-owner/test-repo/1');

    // Should have made API call for diff
    const response = await responsePromise;
    expect(response.status()).toBe(200);
  });

  test('should handle API errors gracefully', async ({ page }) => {
    // Try to load a PR that doesn't exist
    await page.goto('/pr/nonexistent/repo/999');
    await page.waitForLoadState('domcontentloaded');

    // Page should still load without crashing
    const pageContent = await page.textContent('body');
    expect(pageContent.length).toBeGreaterThan(0);

    // Should show some kind of error indication
    const hasError = pageContent.toLowerCase().includes('error') ||
                     pageContent.toLowerCase().includes('not found');
    expect(hasError).toBe(true);
  });
});

test.describe('UI State Management', () => {
  test('should update UI after data loads', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // After loading, the PR title should be visible
    const pageContent = await page.textContent('body');
    expect(pageContent).toContain('Test PR for E2E');

    // File list should be populated
    const fileItems = page.locator('.file-item');
    const count = await fileItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should maintain file selection state', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Click on a file to set active state
    const firstFile = page.locator('.file-item').first();
    await firstFile.click();

    // Verify file is highlighted
    await expect(firstFile).toHaveClass(/active/);

    // Click a different file
    const secondFile = page.locator('.file-item').nth(1);
    if (await secondFile.count() > 0) {
      await secondFile.click();

      // Second file should now be active
      await expect(secondFile).toHaveClass(/active/);
    }
  });
});

test.describe('Accessibility', () => {
  test('should have proper heading structure', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Should have at least one heading
    const headings = page.locator('h1, h2, h3');
    const count = await headings.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should have accessible buttons', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Test specific known buttons that must have accessible names
    // These are the key interactive elements in the PR page

    // Analyze button should have accessible text
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
    await expect(analyzeBtn).toBeVisible();
    const analyzeText = await analyzeBtn.textContent();
    expect(analyzeText?.trim().length).toBeGreaterThan(0);

    // Review/Submit button should have accessible text
    const reviewBtn = page.locator('button:has-text("Review"), .split-button-main').first();
    await expect(reviewBtn).toBeVisible();
    const reviewText = await reviewBtn.textContent();
    const reviewAriaLabel = await reviewBtn.getAttribute('aria-label');
    expect(reviewText?.trim().length || reviewAriaLabel?.length).toBeGreaterThan(0);

    // Theme toggle (if visible) should have accessible name via aria-label or title
    const themeToggle = page.locator('#theme-toggle');
    if (await themeToggle.isVisible()) {
      const themeAriaLabel = await themeToggle.getAttribute('aria-label');
      const themeTitle = await themeToggle.getAttribute('title');
      expect(themeAriaLabel || themeTitle).toBeTruthy();
    }
  });

  test('should support keyboard navigation', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Tab should move focus to an interactive element
    await page.keyboard.press('Tab');

    // Focus should be on a meaningful interactive element (button, link, input, etc.)
    const focusedInfo = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tagName: el?.tagName,
        isInteractive: ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el?.tagName || ''),
        hasTabIndex: el?.getAttribute('tabindex') !== null,
        role: el?.getAttribute('role')
      };
    });

    // Verify focus moved to a focusable interactive element
    const isValidFocusTarget = focusedInfo.isInteractive ||
                                focusedInfo.hasTabIndex ||
                                focusedInfo.role === 'button' ||
                                focusedInfo.role === 'link';
    expect(isValidFocusTarget).toBe(true);
  });
});
