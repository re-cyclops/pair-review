// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing the Analyzer
vi.mock('../../src/ai/index', () => ({
  createProvider: vi.fn()
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({ getPatterns: () => [] })
}));

vi.mock('../../src/utils/line-validation', () => ({
  buildFileLineCountMap: vi.fn().mockResolvedValue(new Map()),
  validateSuggestionLineNumbers: vi.fn(suggestions => suggestions)
}));

vi.mock('../../src/routes/shared', () => ({
  registerProcess: vi.fn(),
  isAnalysisCancelled: vi.fn().mockReturnValue(false),
  CancellationError: class CancellationError extends Error {
    constructor(msg) { super(msg); this.isCancellation = true; }
  }
}));

import Analyzer from '../../src/ai/analyzer.js';
const { AnalysisRunRepository } = require('../../src/database');

/**
 * Tests for council analysis summary propagation through bypass paths.
 *
 * Regression: When a council voice returned 0 suggestions but a valid summary,
 * the summary was lost because consolidation/orchestration was skipped and neither
 * bypass path propagated the voice's summary.
 */
describe('Council analysis summary propagation', () => {
  let analyzer;
  let storedSuggestions;
  let baselineRead;
  afterEach(() => baselineRead?.mockRestore());

  const validFiles = ['src/foo.js', 'src/bar.js'];

  const councilConfig = {
    levels: {
      '2': {
        enabled: true,
        voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }]
      }
    }
  };

  const reviewContext = {
    reviewId: 1,
    worktreePath: '/tmp/test-worktree',
    prMetadata: { title: 'Test PR', description: 'Test', base_branch: 'main' },
    changedFiles: validFiles,
    instructions: null
  };

  beforeEach(() => {
    vi.clearAllMocks();
    baselineRead = vi.spyOn(AnalysisRunRepository.prototype, 'getById').mockResolvedValue(null);
    storedSuggestions = [];

    analyzer = new Analyzer({}, 'council', 'council');

    // Stub methods that touch filesystem/database
    vi.spyOn(analyzer, 'loadGeneratedFilePatterns').mockResolvedValue([]);
    vi.spyOn(analyzer, 'getChangedFilesList').mockResolvedValue(validFiles);
    vi.spyOn(analyzer, 'storeSuggestions').mockImplementation(async (reviewId, runId, suggestions) => {
      storedSuggestions.push(...suggestions);
    });
  });

  describe('single-voice bypass path', () => {
    it('should propagate voice summary when voice returns suggestions', async () => {
      vi.spyOn(analyzer, '_executeCouncilVoice').mockResolvedValue({
        suggestions: [
          { file: 'src/foo.js', line_start: 10, line_end: 10, type: 'bug', title: 'Test bug', confidence: 0.9 }
        ],
        summary: 'Found a potential null pointer issue in the error handling path'
      });

      const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'test-run' });

      expect(result.summary).toBe('Found a potential null pointer issue in the error handling path');
    });

    it('should propagate voice summary when voice returns 0 suggestions but a summary', async () => {
      vi.spyOn(analyzer, '_executeCouncilVoice').mockResolvedValue({
        suggestions: [],
        summary: 'Code changes look good overall. No issues found.'
      });

      const result = await analyzer.runCouncilAnalysis(reviewContext, councilConfig, { runId: 'test-run' });

      expect(result.summary).toBe('Code changes look good overall. No issues found.');
      expect(result.suggestions).toEqual([]);
    });

  });

});
