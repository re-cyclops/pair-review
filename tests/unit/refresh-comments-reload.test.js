// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Unit tests for comment/suggestion reload after diff refresh.
 *
 * Bug: After refreshPR() (PR mode) or refreshDiff() (Local mode), the diff
 * container DOM is cleared by renderDiff(), but loadUserComments() and
 * loadAISuggestions() were not called to re-populate. This left
 * clearAllUserComments() counting 0 DOM elements and bailing with
 * "No comments to clear".
 *
 * Fix: Both refreshPR() and refreshDiff() now call loadUserComments()
 * and loadAISuggestions() after re-rendering the diff.
 */

// Import the actual PRManager class from production code
const { PRManager } = require('../../public/js/pr.js');

const mockFetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();

  global.fetch = mockFetch;

  global.window = {
    aiPanel: {
      showDismissedComments: false,
      setFileOrder: vi.fn(),
      setComments: vi.fn(),
      setAnalysisState: vi.fn(),
      setSummaryData: vi.fn()
    },
    FileOrderUtils: {
      sortFilesByPath: vi.fn((files) => files),
      createFileOrderMap: vi.fn(() => new Map())
    },
    scrollTo: vi.fn()
  };

  global.document = {
    getElementById: vi.fn(() => null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => [])
  };

  global.alert = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a minimal PRManager for testing refresh behavior.
 */
function createTestPRManager() {
  const prManager = Object.create(PRManager.prototype);

  prManager.currentPR = {
    owner: 'test-owner',
    repo: 'test-repo',
    number: 42,
    id: 1
  };

  prManager.expandedFolders = new Set();
  prManager.generatedFiles = new Map();
  prManager.canonicalFileOrder = new Map();

  // Mock the methods we need to verify are called
  prManager.loadUserComments = vi.fn().mockResolvedValue(undefined);
  prManager.loadAISuggestions = vi.fn().mockResolvedValue(undefined);
  prManager.loadAndDisplayFiles = vi.fn().mockResolvedValue(undefined);
  prManager.renderPRHeader = vi.fn();
  prManager.showError = vi.fn();

  return prManager;
}

describe('PR mode: refreshPR() reloads comments after diff refresh', () => {
  it('should not call loadUserComments when refresh API fails', async () => {
    const prManager = createTestPRManager();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: 'Refresh failed' })
    });

    await prManager.refreshPR();

    expect(prManager.loadUserComments).not.toHaveBeenCalled();
    expect(prManager.loadAISuggestions).not.toHaveBeenCalled();
  });

  it('should not call loadUserComments when no PR is loaded', async () => {
    const prManager = createTestPRManager();
    prManager.currentPR = null;

    await prManager.refreshPR();

    expect(prManager.loadUserComments).not.toHaveBeenCalled();
    expect(prManager.loadAISuggestions).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

});


describe('PR mode: refreshPR() handles reload errors gracefully', () => {
  it('should propagate loadUserComments error to the catch block', async () => {
    const prManager = createTestPRManager();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: prManager.currentPR
      })
    });

    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());

    prManager.loadUserComments.mockRejectedValueOnce(new Error('Failed to load comments'));

    await prManager.refreshPR();

    // The error should be caught and displayed
    expect(prManager.showError).toHaveBeenCalledWith('Failed to load comments');
  });

  it('should propagate loadAISuggestions error to the catch block', async () => {
    const prManager = createTestPRManager();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: prManager.currentPR
      })
    });

    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());

    prManager.loadAISuggestions.mockRejectedValueOnce(new Error('Failed to load suggestions'));

    await prManager.refreshPR();

    // The error should be caught and displayed
    expect(prManager.showError).toHaveBeenCalledWith('Failed to load suggestions');
  });
});
