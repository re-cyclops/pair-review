// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * AI analysis keyboard interaction, progress lifecycle, and finding filters.
 * Tests use the real application with deterministic host/provider fixtures.
 */

import { test, publicationTest, expect } from './fixtures.js';
import { waitForDiffToRender, seedAISuggestions } from './helpers.js';

// Helper to handle modals when triggering analysis
async function handleAnalysisModals(page) {
  // Handle config modal or confirm dialog that may appear
  const configModal = page.locator('#analysis-config-modal');
  const confirmDialog = page.locator('#confirm-dialog');

  try {
    // Try waiting for config modal first
    await configModal.waitFor({ state: 'visible', timeout: 2000 });
    await page.locator('#analysis-config-modal .btn-primary').first().click();
  } catch (error) {
    // Only swallow timeout errors - re-throw unexpected errors
    if (error.name !== 'TimeoutError' && !error.message?.includes('Timeout')) {
      throw error;
    }
    // If config modal didn't appear (timeout), check for confirm dialog (when re-running analysis)
    if (await confirmDialog.isVisible()) {
      await page.locator('#confirm-dialog .btn-danger, #confirm-dialog button:has-text("Continue")').first().click();
      // After confirm, config modal should appear
      await configModal.waitFor({ state: 'visible', timeout: 2000 });
      await page.locator('#analysis-config-modal .btn-primary').first().click();
    }
  }
}



test.describe('Analysis Config Modal', () => {
  test('should trigger analysis with Cmd+Enter keyboard shortcut', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Click analyze button to open config modal
    const analyzeBtn = page.locator('#analyze-btn, button:has-text("Analyze")').first();
    await analyzeBtn.click();

    // Handle confirm dialog if it appears (for re-running analysis)
    const confirmDialog = page.locator('#confirm-dialog');
    if (await confirmDialog.isVisible().catch(() => false)) {
      await page.locator('#confirm-dialog .btn-danger, #confirm-dialog button:has-text("Continue")').first().click();
    }

    // Wait for config modal to appear
    const configModal = page.locator('#analysis-config-modal');
    await configModal.waitFor({ state: 'visible', timeout: 3000 });

    // Focus the custom instructions textarea and type something
    const textarea = page.locator('#custom-instructions');
    await textarea.focus();
    await textarea.fill('Test instructions');

    // Press Cmd+Enter (or Ctrl+Enter on non-Mac)
    const isMac = process.platform === 'darwin';
    await page.keyboard.press(isMac ? 'Meta+Enter' : 'Control+Enter');

    // Config modal should close and progress modal should appear
    await configModal.waitFor({ state: 'hidden', timeout: 3000 });
    const progressModal = page.locator('#council-progress-modal');
    await expect(progressModal).toBeVisible({ timeout: 5000 });
  });
});

publicationTest('analysis configuration supports keyboard toggles, excludes background focus and restores its trigger', async ({ page }) => {
  await page.goto('/pr/test-owner/test-repo/1');
  await waitForDiffToRender(page);
  const analyze = page.locator('#analyze-btn');
  await analyze.press('Enter');
  const modal = page.getByRole('dialog', { name: 'Configure AI Analysis' });
  await expect(modal.locator('#custom-instructions')).toBeVisible();
  await page.locator('#refresh-pr').focus();
  await expect.poll(() => modal.evaluate(element => element.contains(document.activeElement))).toBe(true);
  const level = modal.getByRole('checkbox', { name: 'Level 2 — File Context', exact: true });
  await level.press('Space');
  await expect(level).not.toBeChecked();
  await expect(level).toBeFocused();
  await level.press('Space');
  await expect(level).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(analyze).toBeFocused();
});

publicationTest('dismissing progress keeps completion live and permits another analysis', async ({ page, testServer }) => {
  testServer.analysis.hold = true;
  await page.goto('/pr/test-owner/test-repo/1');
  await waitForDiffToRender(page);
  const analyze = page.locator('#analyze-btn');
  await analyze.click();
  await handleAnalysisModals(page);
  const progress = page.locator('#council-progress-modal');
  await expect(progress).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(progress).toBeHidden();
  testServer.analysis.complete();
  await expect(analyze).not.toHaveClass(/btn-analyzing/, { timeout: 10000 });
  await expect(analyze).toBeEnabled();
  await analyze.click();
  await expect(page.locator('#analysis-config-modal')).toBeVisible();
});


test.describe('Segment Control', () => {
  test('should switch between AI and Comments views', async ({ page }) => {
    await page.goto('/pr/test-owner/test-repo/1');
    await waitForDiffToRender(page);

    // Panel starts collapsed by default; expand it so segment buttons are interactable
    await page.evaluate(() => window.aiPanel?.expand());

    // Seed AI suggestions first
    await seedAISuggestions(page);

    // Click AI segment
    const aiSegment = page.locator('.segment-btn[data-segment="ai"]').first();
    await aiSegment.click();
    await expect(aiSegment).toHaveClass(/active/);

    // Click Comments segment
    const commentsSegment = page.locator('.segment-btn[data-segment="comments"]').first();
    await commentsSegment.click();
    await expect(commentsSegment).toHaveClass(/active/);

    // AI segment should no longer be active
    await expect(aiSegment).not.toHaveClass(/active/);
  });

});
