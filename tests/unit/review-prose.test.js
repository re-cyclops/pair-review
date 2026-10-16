// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
const { checkReviewProse, prosePolicy } = require('../../src/utils/review-prose');

const config = { globalInstructions: 'Canonical fixture policy', review_prose: { profile: 'Fixture style', rules: {
  'long-dashes': 'advisory', emojis: 'advisory', 'bold-prose': 'advisory',
  'bracket-prefix': 'advisory', 'terminal-period': 'advisory'
} } };
const check = body => checkReviewProse(config, [{ key: 'draft', body }]);

describe('selected review prose checks', () => {
  it('ignores literal code, suggestion blocks, URLs and quoted source material', () => {
    const body = [
      'Use `literal\u2014name.` and **`literal\u2013name`**',
      '', '```suggestion:-2+1', '[warning] **Keep\u2014this.** \u{1f600}', '```',
      '', '    [warning] literal\u2014code. \u{1f600}',
      '', '> [warning] **Quoted\u2014material.** \u{1f600}',
      '', '<code>literal\u2014name. \u{1f600}</code>',
      '', '<https://example.invalid/literal\u2014name.>',
      '', '[https://example.invalid/literal\u2013name.](https://example.invalid/literal\u2013name.)'
    ].join('\n');
    const entries = [{ key: 'draft', body }];
    expect(checkReviewProse(config, entries).diagnostics).toEqual([]);
    expect(entries).toEqual([{ key: 'draft', body }]);
  });

  it('reports structural prose findings without changing the claim or its uncertainty', () => {
    const body = '[warning] **This might fail\u2014under cancellation.** \u{1f600}\n\nCould we retain the checkpoint?';
    const result = check(body);
    expect(result.diagnostics.map(item => item.rule).sort()).toEqual(['bold-prose', 'bracket-prefix', 'emojis', 'long-dashes']);
    expect(result.diagnostics.every(item => item.severity === 'advisory' && item.key === 'draft')).toBe(true);
    expect(result.profile).toBe('Fixture style');
  });

  it('checks prose link labels without treating their destination as prose', () => {
    const result = check('Check [this\u2014state](https://example.invalid/\u{1f600})');
    expect(result.diagnostics.map(item => item.rule)).toEqual(['long-dashes']);
  });

  it('keeps questions and nit prefixes while distinguishing a trailing prose period', () => {
    expect(check('[nit] Could we keep `literal.name.`?').diagnostics).toEqual([]);
    expect(check('Keep `literal.name.`.').diagnostics.map(item => item.rule)).toEqual(['terminal-period']);
    expect(check('Keep `literal.name.`').diagnostics).toEqual([]);
  });

  it('binds diagnostics to exact text and configured severity, not only a profile label', () => {
    const before = check('Keep this.');
    const changedText = check('Keep this');
    const changedPolicy = checkReviewProse({ ...config, review_prose: { ...config.review_prose, rules: { 'terminal-period': 'blocking' } } }, [{ key: 'draft', body: 'Keep this.' }]);
    expect(changedText.checkedTextDigest).not.toBe(before.checkedTextDigest);
    expect(changedText.digest).toBe(before.digest);
    expect(changedPolicy.digest).not.toBe(before.digest);
    expect(changedPolicy.diagnostics).toMatchObject([{ severity: 'blocking', source: 'review_prose.rules.terminal-period' }]);
  });

  it('does not enable an unconfigured policy or silently accept unsupported checks', () => {
    expect(checkReviewProse({}, [{ key: 'draft', body: '**Literal style.**' }])).toMatchObject({ state: 'not_configured', diagnostics: [] });
    expect(() => prosePolicy({ review_prose: { rules: { 'factual-correctness': 'blocking' } } })).toThrow('Unsupported review_prose rule');
    expect(() => prosePolicy({ review_prose: { rules: { emojis: 'rewrite' } } })).toThrow('Unsupported review_prose rule');
  });
});
