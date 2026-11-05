// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/ai/index', () => ({
  createProvider: vi.fn()
}));

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({ getPatterns: () => [] })
}));

const Analyzer = require('../../src/ai/analyzer');

// Exercise prompt builders directly; analysis outcomes and cancellation are
// covered through the real Analyzer in the council regression suites.

describe('Consolidation prompt templates (direct tests)', () => {
  it('thorough consolidation template should contain reviewer-context-guidance section', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    expect(thorough.taggedPrompt).toContain('name="reviewer-context-guidance"');
    expect(thorough.taggedPrompt).toContain('Reviewer Context Awareness');
    expect(thorough.defaultOrder).toContain('reviewer-context-guidance');
    const sectionIdx = thorough.defaultOrder.indexOf('reviewer-context-guidance');
    expect(thorough.defaultOrder[sectionIdx + 1]).toBe('input-suggestions');
  });

  it('balanced consolidation template should contain reviewer-context-guidance section', () => {
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    expect(balanced.taggedPrompt).toContain('name="reviewer-context-guidance"');
    expect(balanced.taggedPrompt).toContain('Reviewer Context Awareness');
    expect(balanced.defaultOrder).toContain('reviewer-context-guidance');
    const sectionIdx = balanced.defaultOrder.indexOf('reviewer-context-guidance');
    expect(balanced.defaultOrder[sectionIdx + 1]).toBe('input-suggestions');
  });

  it('fast consolidation template should contain reviewer-context-guidance section', () => {
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');
    expect(fast.taggedPrompt).toContain('name="reviewer-context-guidance"');
    expect(fast.taggedPrompt).toContain('Reviewer Context');
    expect(fast.defaultOrder).toContain('reviewer-context-guidance');
    const sectionIdx = fast.defaultOrder.indexOf('reviewer-context-guidance');
    expect(fast.defaultOrder[sectionIdx + 1]).toBe('input-suggestions');
  });

  it('all tiers should have reviewer-context-guidance in sections metadata', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      const section = template.sections.find(s => s.name === 'reviewer-context-guidance');
      expect(section).toBeDefined();
      expect(section.required).toBe(true);
    }
  });

  it('all tiers should have balanced-output and summary-synthesis sections', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      expect(template.taggedPrompt).toContain('name="balanced-output"');
      expect(template.taggedPrompt).toContain('name="summary-synthesis"');
      expect(template.defaultOrder).toContain('balanced-output');
      expect(template.defaultOrder).toContain('summary-synthesis');

      const balancedSection = template.sections.find(s => s.name === 'balanced-output');
      expect(balancedSection).toBeDefined();
      expect(balancedSection.required).toBe(true);

      const synthSection = template.sections.find(s => s.name === 'summary-synthesis');
      expect(synthSection).toBeDefined();
      expect(synthSection.required).toBe(true);
    }
  });

  it('priority-curation should NOT exist in any tier', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      expect(template.taggedPrompt).not.toContain('name="priority-curation"');
      expect(template.defaultOrder).not.toContain('priority-curation');
      expect(template.sections.find(s => s.name === 'priority-curation')).toBeUndefined();
    }
  });

  it('balanced-output should appear before summary-synthesis in defaultOrder', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      const balancedIdx = template.defaultOrder.indexOf('balanced-output');
      const synthIdx = template.defaultOrder.indexOf('summary-synthesis');
      expect(balancedIdx).toBeLessThan(synthIdx);
    }
  });

  it('summary guidance should require structured markdown summaries', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      const parsed = template.parseSections();
      const outputSchema = parsed.find(s => s.name === 'output-schema');
      const synthSection = parsed.find(s => s.name === 'summary-synthesis');

      expect(outputSchema).toBeDefined();
      expect(synthSection).toBeDefined();

      expect(outputSchema.content).toContain('Formatted markdown summary');
      expect(outputSchema.content).toMatch(/guidance above\./i);
      expect(outputSchema.content).not.toContain('1-2 sentences of overall assessment');
      expect(outputSchema.content).not.toContain('bullet list of specific points');
      expect(outputSchema.content).not.toContain('single reviewer');
      expect(outputSchema.content).not.toContain('Single cohesive paragraph');

      expect(synthSection.content).toMatch(/not(?: be)? one big paragraph/);
      expect(synthSection.content).toContain('1-2 sentences');
      expect(synthSection.content).toContain('bullet list');
      expect(synthSection.content).toContain('After the bullets');
    }
  });

  it('balanced-output should use deduplication framing, not count reduction', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      expect(template.taggedPrompt).toContain('Deduplicate');
      expect(template.taggedPrompt).not.toContain('Your output should contain *fewer* suggestions');
    }
  });

  it('thorough consolidation should preserve attack scenarios when merging', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');

    // Exploit framing from the analysis levels must survive consolidation
    expect(thorough.taggedPrompt).toContain('failure and attack scenarios');
    expect(thorough.taggedPrompt).toContain('do not summarize an exploit description back into a code observation');
  });

  it('shared adversarial verification section should pin the refutation contract', () => {
    const { ADVERSARIAL_VERIFICATION_SECTION } = require('../../src/ai/prompts/shared/adversarial-verification');

    // Refutation asymmetry: drops need positive evidence of wrongness;
    // unverifiable findings keep their original confidence (suppression-by-doubt
    // removes genuine defects, not incorrect ones — eval 2026-08-15)
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('## Adversarial Verification');
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('inability to verify is not refutation');
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('keep it at its original confidence');
    // Refutation by code evidence beats source consensus (shared blind spots)
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('code evidence outranks consensus');
    // Repo access text is the eval-validated READ-ONLY original. Execution
    // is DELIBERATELY UNMENTIONED — an explicit ban measurably suppressed
    // verification, and an explicit permission conflicted with provider flag
    // restrictions (2026-08-19, three failed experiments; see the header
    // comment in shared/adversarial-verification.js). The harness's own
    // permission system is the entire execution policy. Do not make
    // execution explicit in either direction without A/B eval evidence.
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('READ-ONLY');
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('Do NOT modify files');
    expect(ADVERSARIAL_VERIFICATION_SECTION).not.toContain('execute');
    expect(ADVERSARIAL_VERIFICATION_SECTION).not.toContain('empirical');
    // Source-neutral wording: the same text serves cross-voice consolidation
    // (reviewers) and cross-level orchestration (levels)
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('one reviewer or one level');
    // The verification imperative invites narration ("I'll verify...") ahead
    // of the JSON, which breaks extraction (opus-5, eval 2026-08-18) — the
    // section must restate JSON-only output itself. Do NOT quote an example
    // of the forbidden preamble: an earlier guard did, and the next eval's
    // one consolidation failure emitted that quoted sentence near-verbatim
    // (priming). The guard describes the ban without demonstrating it.
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('no sentence announcing what you will do');
    expect(ADVERSARIAL_VERIFICATION_SECTION).toContain('The first character of your reply is `{`');
    expect(ADVERSARIAL_VERIFICATION_SECTION).not.toContain("I'll verify");
  });

  it('thorough consolidation should carry adversarial verification as a flow-conditional placeholder', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');

    expect(thorough.defaultOrder).toContain('adversarial-verification');
    // Verification reads the inputs and runs before the merge rules
    const verifyIdx = thorough.defaultOrder.indexOf('adversarial-verification');
    expect(thorough.defaultOrder[verifyIdx - 1]).toBe('input-suggestions');
    expect(thorough.defaultOrder[verifyIdx + 1]).toBe('consolidation-rules');

    // Optional + placeholder-fed: cross-voice consolidation fills it (final
    // merge stage of the reviewer-centric council), intra-level consolidation
    // passes '' (Pass 1 of the level-centric council — verification belongs
    // to its Pass 2 cross-level orchestration, run exactly once per flow)
    const section = thorough.sections.find(s => s.name === 'adversarial-verification');
    expect(section).toBeDefined();
    expect(section.optional).toBe(true);
    const parsed = thorough.parseSections().find(s => s.name === 'adversarial-verification');
    expect(parsed.content).toBe('{{adversarialVerification}}');
  });



  it('adversarial verification is thorough-only until the balanced/fast ports', () => {
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [balanced, fast]) {
      expect(template.taggedPrompt).not.toContain('name="adversarial-verification"');
      expect(template.defaultOrder).not.toContain('adversarial-verification');
    }
  });

  it('parseSections should return balanced-output and summary-synthesis as required sections', () => {
    const thorough = require('../../src/ai/prompts/baseline/consolidation/thorough');
    const balanced = require('../../src/ai/prompts/baseline/consolidation/balanced');
    const fast = require('../../src/ai/prompts/baseline/consolidation/fast');

    for (const template of [thorough, balanced, fast]) {
      const parsed = template.parseSections();

      const balancedSection = parsed.find(s => s.name === 'balanced-output');
      expect(balancedSection).toBeDefined();
      expect(balancedSection.required).toBe(true);
      expect(balancedSection.content.length).toBeGreaterThan(10);

      const synthSection = parsed.find(s => s.name === 'summary-synthesis');
      expect(synthSection).toBeDefined();
      expect(synthSection.required).toBe(true);
      expect(synthSection.content.length).toBeGreaterThan(10);
    }
  });
});

describe('Consolidation helper methods (direct tests)', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new Analyzer({}, 'sonnet', 'claude');
  });

  describe('buildCustomInstructionsSection', () => {
    it('should return formatted section when customInstructions is provided', () => {
      const result = analyzer.buildCustomInstructionsSection('Focus on security issues');
      expect(result).toContain('Focus on security issues');
      expect(result).toContain('Additional Review Instructions');
    });

    it('should return empty string when customInstructions is null', () => {
      const result = analyzer.buildCustomInstructionsSection(null);
      expect(result).toBe('');
    });

    it('should return empty string when customInstructions is empty', () => {
      const result = analyzer.buildCustomInstructionsSection('');
      expect(result).toBe('');
    });

    it('should return empty string when customInstructions is whitespace only', () => {
      const result = analyzer.buildCustomInstructionsSection('   ');
      expect(result).toBe('');
    });
  });

  describe('buildOrchestrationLineNumberGuidance', () => {
    it('should return guidance containing Line Number Handling header', () => {
      const result = analyzer.buildOrchestrationLineNumberGuidance('/tmp/worktree');
      expect(result).toContain('## Line Number Handling');
    });

    it('should include worktree path in guidance when provided', () => {
      const result = analyzer.buildOrchestrationLineNumberGuidance('/tmp/worktree');
      expect(result).toContain('--cwd "/tmp/worktree"');
    });

    it('should omit --cwd when worktree path is null', () => {
      const result = analyzer.buildOrchestrationLineNumberGuidance(null);
      expect(result).not.toContain('--cwd');
    });
  });

  describe('buildPRContextSection for consolidation', () => {
    it('should use pr_number field in PR context', () => {
      const result = analyzer.buildPRContextSection(
        { pr_number: 42, title: 'Test PR', description: 'Test', repository: 'owner/repo' },
        'note'
      );
      expect(result).toContain('42');
    });

    it('should use "local" context for local review type', () => {
      const result = analyzer.buildPRContextSection(
        { pr_number: 99, title: 'Local', description: 'Test', reviewType: 'local' },
        'note'
      );
      expect(result).toContain('Review Context');
      expect(result).not.toContain('Pull Request Context');
    });
  });
});

describe('Per-voice provider overrides (providerOverridesMap)', () => {
  describe('Analyzer constructor stores providerOverridesMap', () => {
    it('should store providerOverridesMap when provided', () => {
      const map = { pi: { load_skills: false }, antigravity: { timeout: 300000 } };
      const a = new Analyzer({}, 'council', 'council', { load_skills: true }, map);
      expect(a.providerOverridesMap).toBe(map);
    });

    it('should default providerOverridesMap to null when not provided', () => {
      const a = new Analyzer({}, 'council', 'council', { load_skills: true });
      expect(a.providerOverridesMap).toBeNull();
    });

    it('should store providerOverrides alongside providerOverridesMap', () => {
      const shared = { load_skills: true };
      const map = { pi: { load_skills: false } };
      const a = new Analyzer({}, 'council', 'council', shared, map);
      expect(a.providerOverrides).toBe(shared);
      expect(a.providerOverridesMap).toBe(map);
    });
  });

});
