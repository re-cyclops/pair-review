// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Terminal council progress is consumed by the live aggregate stage, not
 * just individual voice rows. Exercise success, fallback and cancellation
 * against a real parent/child database and a pinned Git comparison.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const Analyzer = require('../../src/ai/analyzer');
const { CancellationError } = require('../../src/routes/shared');
const { createGitFixture } = require('../utils/git-fixture');
let checkout;

/**
 * Helper: build a minimal reviewContext and councilConfig for tests
 */
function buildTestContext(overrides = {}) {
  return {
    reviewContext: {
      reviewId: 1,
      worktreePath: checkout.directory,
      prMetadata: { head_sha: checkout.head, base_sha: checkout.base },
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
  let db;
  afterEach(() => { vi.restoreAllMocks(); closeTestDatabase(db); checkout?.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDatabase();
    checkout = createGitFixture(['src/foo.js', 'src/bar.js']);
    db.prepare("INSERT INTO reviews (id, pr_number, repository) VALUES (1, 42, 'fixture/repo')").run();
    db.prepare(`INSERT INTO analysis_runs (id, review_id, provider, model, status, head_sha)
      VALUES ('parent-run-id', 1, 'council', 'council', 'running', ?)`).run(checkout.head);

    analyzer = new Analyzer(db, 'sonnet', 'claude');

    // Mock internal methods that we don't want to actually execute
    analyzer.loadGeneratedFilePatterns = vi.fn().mockResolvedValue({ getPatterns: () => [] });
    analyzer.getChangedFilesList = vi.fn().mockResolvedValue(['src/foo.js', 'src/bar.js']);
    analyzer.storeSuggestions = vi.fn().mockResolvedValue(undefined);
    analyzer.validateSuggestionFilePaths = vi.fn().mockImplementation((suggestions) => suggestions || []);

    // Mock validateAndFinalizeSuggestions to return suggestions as-is by default
    analyzer.validateAndFinalizeSuggestions = vi.fn().mockImplementation((suggestions) => suggestions || []);
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
      expect(JSON.parse(db.prepare("SELECT level_outcomes FROM analysis_runs WHERE id = 'parent-run-id'").get().level_outcomes))
        .toEqual({ consolidation: 'success' });
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
      expect(JSON.parse(db.prepare("SELECT level_outcomes FROM analysis_runs WHERE id = 'parent-run-id'").get().level_outcomes))
        .toEqual({ consolidation: 'failed' });

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
      expect(db.prepare("SELECT status FROM analysis_runs WHERE id = 'parent-run-id'").get().status).toBe('running');
    });
  });

});
