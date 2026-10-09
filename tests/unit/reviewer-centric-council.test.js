// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for runReviewerCentricCouncil in analyzer.js
 *
 * Verifies:
 * - Single-voice path: analyzeAllLevels runs directly on parent run (no child run)
 * - Multi-voice consolidation always runs (even for few suggestions)
 * - custom_instructions column stores only request-level instructions (regression)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/ai/index', () => ({
  createProvider: vi.fn()
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({ getPatterns: () => [] })
}));

vi.mock('../../src/utils/line-validation', () => ({
  buildFileLineCountMap: vi.fn().mockResolvedValue(new Map()),
  validateSuggestionLineNumbers: vi.fn().mockReturnValue({
    valid: [],
    converted: [],
    dropped: []
  })
}));

const mockRunRepoCreate = vi.fn().mockResolvedValue({});
const mockRunRepoUpdate = vi.fn().mockResolvedValue({});
vi.mock('../../src/database', () => ({
  AnalysisRunRepository: vi.fn().mockImplementation(() => ({
    create: mockRunRepoCreate,
    update: mockRunRepoUpdate
  })),
  run: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue(null),
  all: vi.fn().mockResolvedValue([])
}));

vi.mock('../../src/routes/shared', () => ({
  registerProcess: vi.fn(),
  isAnalysisCancelled: vi.fn().mockReturnValue(false),
  CancellationError: class CancellationError extends Error {
    constructor(msg) { super(msg); this.isCancellation = true; }
  }
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mock-uuid-child')
}));

const Analyzer = require('../../src/ai/analyzer');
const { AnalysisRunRepository } = require('../../src/database');
const { CancellationError } = require('../../src/routes/shared');

/**
 * Helper: build a minimal reviewContext and councilConfig for tests
 */
function buildTestContext(overrides = {}) {
  return {
    reviewContext: {
      reviewId: 1,
      worktreePath: '/tmp/test-worktree',
      prMetadata: { head_sha: 'abc123' },
      changedFiles: ['src/foo.js', 'src/bar.js'],
      instructions: { repoInstructions: null, requestInstructions: null }
    },
    councilConfig: {
      voices: [
        { provider: 'claude', model: 'sonnet', tier: 'balanced' },
        ...(overrides.extraVoices || [])
      ],
      levels: { '1': true, '2': true, '3': false },
      consolidation: { provider: 'claude', model: 'opus', tier: 'balanced' }
    },
    options: {
      analysisId: 'test-analysis-id',
      runId: 'parent-run-id',
      progressCallback: null
    },
    ...overrides
  };
}

/**
 * Build mock suggestions for testing
 */
function buildMockSuggestions(count) {
  return Array.from({ length: count }, (_, i) => ({
    file: 'src/foo.js',
    title: `Suggestion ${i + 1}`,
    description: `Description ${i + 1}`,
    type: 'improvement',
    line_start: i + 1,
    line_end: i + 1
  }));
}

describe('runReviewerCentricCouncil', () => {
  let analyzer;
  let baselineRead;
  afterEach(() => baselineRead?.mockRestore());

  beforeEach(() => {
    vi.clearAllMocks();
    baselineRead = vi.spyOn(AnalysisRunRepository.prototype, 'getById').mockResolvedValue(null);

    analyzer = new Analyzer({}, 'sonnet', 'claude');

    // Mock internal methods that we don't want to actually execute
    analyzer.loadGeneratedFilePatterns = vi.fn().mockResolvedValue({ getPatterns: () => [] });
    analyzer.getChangedFilesList = vi.fn().mockResolvedValue(['src/foo.js', 'src/bar.js']);
    analyzer.storeSuggestions = vi.fn().mockResolvedValue(undefined);
    analyzer.validateSuggestionFilePaths = vi.fn().mockImplementation((suggestions) => suggestions || []);

    // Mock validateAndFinalizeSuggestions to return suggestions as-is by default
    analyzer.validateAndFinalizeSuggestions = vi.fn().mockImplementation((suggestions) => suggestions || []);
  });

  describe('single-voice early return path', () => {
    it('should re-throw CancellationError without updating run status (analyzeAllLevels handles it)', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext();
      const cancellationError = new CancellationError('Analysis was cancelled');

      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockRejectedValue(cancellationError);

      await expect(
        analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options)
      ).rejects.toThrow(cancellationError);

      // runReviewerCentricCouncil should NOT update the run status itself;
      // analyzeAllLevels is responsible for that (and it's mocked here)
      expect(mockRunRepoUpdate).not.toHaveBeenCalled();
    });

    it('should re-throw generic error without updating run status (analyzeAllLevels handles it)', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext();
      const genericError = new Error('Something went wrong');

      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockRejectedValue(genericError);

      await expect(
        analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options)
      ).rejects.toThrow(genericError);

      // runReviewerCentricCouncil should NOT update the run status itself;
      // analyzeAllLevels is responsible for that (and it's mocked here)
      expect(mockRunRepoUpdate).not.toHaveBeenCalled();
    });
  });

  describe('multi-voice consolidation (always runs)', () => {
    it('should call _crossVoiceConsolidate even when suggestion count is below threshold', async () => {
      // Use two voices so we don't hit the single-voice path,
      // but keep total suggestions below 8 (the old threshold)
      const { reviewContext, councilConfig, options } = buildTestContext({
        extraVoices: [{ provider: 'antigravity', model: 'pro', tier: 'balanced' }]
      });

      const voice1Suggestions = buildMockSuggestions(3);
      const voice2Suggestions = buildMockSuggestions(2);

      // Each voice's analyzeAllLevels returns a few suggestions
      let callCount = 0;
      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return { suggestions: voice1Suggestions, summary: 'Voice 1 summary' };
        }
        return { suggestions: voice2Suggestions, summary: 'Voice 2 summary' };
      });

      const consolidatedSuggestions = buildMockSuggestions(4);
      const consolidateSpy = vi.spyOn(analyzer, '_crossVoiceConsolidate').mockResolvedValue({
        suggestions: consolidatedSuggestions,
        summary: 'Consolidated summary'
      });

      analyzer.validateAndFinalizeSuggestions = vi.fn().mockReturnValue(consolidatedSuggestions);

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // _crossVoiceConsolidate MUST be called even with only 5 total suggestions
      expect(consolidateSpy).toHaveBeenCalledOnce();

      // Result should use the consolidated output, not raw concatenation
      expect(result.suggestions).toEqual(consolidatedSuggestions);
      expect(result.summary).toBe('Consolidated summary');
    });

    it('should use consolidated result (not raw voice concatenation) for storage', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext({
        extraVoices: [{ provider: 'antigravity', model: 'pro', tier: 'balanced' }]
      });

      const voice1Suggestions = buildMockSuggestions(2);
      const voice2Suggestions = buildMockSuggestions(2);

      let callCount = 0;
      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return { suggestions: voice1Suggestions, summary: 'V1' };
        }
        return { suggestions: voice2Suggestions, summary: 'V2' };
      });

      // Consolidation produces a different (deduplicated/merged) set
      const consolidatedSuggestions = buildMockSuggestions(3);
      vi.spyOn(analyzer, '_crossVoiceConsolidate').mockResolvedValue({
        suggestions: consolidatedSuggestions,
        summary: 'Merged review'
      });

      analyzer.validateAndFinalizeSuggestions = vi.fn().mockReturnValue(consolidatedSuggestions);

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // storeSuggestions should receive consolidated suggestions, not raw voice output
      expect(analyzer.storeSuggestions).toHaveBeenCalledWith(
        reviewContext.reviewId,
        'parent-run-id',
        consolidatedSuggestions,
        null,
        expect.any(Array)
      );

      expect(result.suggestions).toEqual(consolidatedSuggestions);
      expect(result.suggestions).not.toEqual([...voice1Suggestions, ...voice2Suggestions]);
    });

    it('should pass validated consolidated suggestions through to result', async () => {
      const { reviewContext, councilConfig, options } = buildTestContext({
        extraVoices: [{ provider: 'antigravity', model: 'pro', tier: 'balanced' }]
      });

      const voice1Suggestions = buildMockSuggestions(3);
      const voice2Suggestions = buildMockSuggestions(2);

      let callCount = 0;
      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          return { suggestions: voice1Suggestions, summary: 'V1' };
        }
        return { suggestions: voice2Suggestions, summary: 'V2' };
      });

      const consolidatedSuggestions = buildMockSuggestions(4);
      vi.spyOn(analyzer, '_crossVoiceConsolidate').mockResolvedValue({
        suggestions: consolidatedSuggestions,
        summary: 'Consolidated'
      });

      // Simulate validation filtering out one consolidated suggestion
      const filteredSuggestions = consolidatedSuggestions.slice(0, 3);
      analyzer.validateAndFinalizeSuggestions = vi.fn().mockReturnValue(filteredSuggestions);

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      // Return value should reflect validated count (3), not raw consolidated count (4)
      expect(result.suggestions).toEqual(filteredSuggestions);
      expect(result.suggestions).toHaveLength(3);

      // storeSuggestions should receive the validated (filtered) consolidated list
      expect(analyzer.storeSuggestions).toHaveBeenCalledWith(
        reviewContext.reviewId,
        'parent-run-id',
        filteredSuggestions,
        null,
        expect.any(Array)
      );
    });
  });

  describe('terminal orchestration progress events (issue #560)', () => {
    // The aggregate levels[4] status only moves on voiceId-less orchestration
    // events (events with a voiceId update levels[4].voices only), so the
    // terminal events emitted around cross-voice consolidation must be
    // voiceId-less for the live progress UI to reflect the real outcome.

    function buildMultiVoiceRun(progressCallback) {
      const { reviewContext, councilConfig } = buildTestContext({
        extraVoices: [{ provider: 'antigravity', model: 'pro', tier: 'balanced' }]
      });
      let callCount = 0;
      vi.spyOn(Analyzer.prototype, 'analyzeAllLevels').mockImplementation(async () => {
        callCount++;
        return { suggestions: buildMockSuggestions(callCount === 1 ? 3 : 2), summary: `Voice ${callCount}` };
      });
      return {
        reviewContext,
        councilConfig,
        options: { analysisId: 'test-analysis-id', runId: 'parent-run-id', progressCallback }
      };
    }

    function orchestrationEvents(progressCallback) {
      return progressCallback.mock.calls
        .map(([update]) => update)
        .filter(u => u.level === 'orchestration');
    }

    it('emits a voiceId-less terminal completed event when cross-voice consolidation succeeds', async () => {
      const progressCallback = vi.fn();
      const { reviewContext, councilConfig, options } = buildMultiVoiceRun(progressCallback);

      vi.spyOn(analyzer, '_crossVoiceConsolidate').mockResolvedValue({
        suggestions: buildMockSuggestions(4),
        summary: 'Consolidated'
      });

      await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      const terminal = orchestrationEvents(progressCallback).find(u => u.status === 'completed');
      expect(terminal).toBeDefined();
      expect(terminal.voiceCentric).toBe(true);
      expect(terminal.voiceId).toBeUndefined();
      expect(terminal.progress).toBe('Cross-reviewer consolidation complete');
    });

    it('emits a voiceId-less terminal failed event when cross-voice consolidation fails', async () => {
      const progressCallback = vi.fn();
      const { reviewContext, councilConfig, options } = buildMultiVoiceRun(progressCallback);

      vi.spyOn(analyzer, '_crossVoiceConsolidate').mockRejectedValue(new Error('consolidation blew up'));

      const result = await analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options);

      const terminal = orchestrationEvents(progressCallback).find(u => u.status === 'failed');
      expect(terminal).toBeDefined();
      expect(terminal.voiceCentric).toBe(true);
      expect(terminal.voiceId).toBeUndefined();
      expect(terminal.progress).toContain('Consolidation failed');

      // The fallback result still records the failure authoritatively
      expect(result.orchestrationFailed).toBe(true);
      expect(result.levelOutcomes).toEqual({ consolidation: 'failed' });
    });

    it('does not emit a terminal failed event on cancellation (propagates instead)', async () => {
      const progressCallback = vi.fn();
      const { reviewContext, councilConfig, options } = buildMultiVoiceRun(progressCallback);

      vi.spyOn(analyzer, '_crossVoiceConsolidate').mockRejectedValue(new CancellationError('cancelled'));

      await expect(
        analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, options)
      ).rejects.toThrow('cancelled');

      const terminal = orchestrationEvents(progressCallback).filter(u => u.status === 'failed' || u.status === 'completed');
      expect(terminal).toEqual([]);
    });
  });

});
