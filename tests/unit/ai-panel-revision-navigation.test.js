// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { AIPanel } = require('../../public/js/components/AIPanel.js');
const patch = (start, lines) => `diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -${start},${lines.length} +${start},${lines.length} @@\n${lines.map(text => ' ' + text).join('\n')}`;
const code = ['function compute() {', '  const value = readInput();', '  validate(value);', '  return value;', '}'];
const finding = { id: 1, file: 'src/a.js', line_start: 2, line_end: 3, side: 'RIGHT', ai_run_id: 'old', source: 'ai' };
let panel;
beforeEach(() => {
  document.body.innerHTML = '<aside id="ai-panel"><div id="findings-list"><div class="finding-item-wrapper"><button class="finding-item" data-id="1" data-item-type="finding">Finding</button></div></div></aside><main class="diff-view"><div id="diff-container"></div></main>';
  panel = Object.create(AIPanel.prototype);
  Object.assign(panel, { _navGen: 0, findings: [finding], comments: [], historicalFindings: true,
    panel: document.getElementById('ai-panel'), findingsList: document.getElementById('findings-list') });
  panel.expandFileIfCollapsed = vi.fn();
  panel._scrollDiffTarget = vi.fn();
  panel._revealDiffForNavigation = vi.fn();
  window.prManager = { currentPR: { id: 7, head_sha: 'new' }, filePatches: new Map([['src/a.js', patch(10, code)]]),
    parseUnifiedDiff: value => new Map([['src/a.js', value]]), analysisHistoryManager: { getSelectedRunId: () => 'old' },
    triggerAIAnalysis: vi.fn(), openReviewModal: vi.fn() };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ run: { id: 'old', review_id: 7, diff: patch(1, code) } }) })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.prManager; });

describe('side-aware saved code mapping', () => {
  it.each(['LEFT', 'RIGHT'])('maps the full range by unique context on %s, not the old line number', side => {
    expect(AIPanel.matchFindingLocation(patch(1, code), patch(10, code), finding, side))
      .toEqual({ file: 'src/a.js', line_start: 11, line_end: 12, side });
  });
  it('rejects changed code at the same numeric lines', () => {
    expect(AIPanel.matchFindingLocation(patch(1, code), patch(1, code.map(text => text.replace('readInput', 'readOther'))), finding, 'RIGHT')).toBeNull();
  });
  it('rejects repeated or insufficient context', () => {
    expect(AIPanel.matchFindingLocation(patch(1, code), patch(1, code) + '\n' + patch(10, code), finding, 'RIGHT')).toBeNull();
    expect(AIPanel.matchFindingLocation(patch(1, ['}']), patch(10, ['}']), { ...finding, line_start: 1, line_end: 1 }, 'RIGHT')).toBeNull();
  });
  it('never maps a range through a gap between hunks', () => {
    const separated = patch(1, code.slice(0, 2)) + '\n@@ -30,3 +30,3 @@\n' + code.slice(2).map(text => ' ' + text).join('\n');
    expect(AIPanel.matchFindingLocation(separated, separated, { ...finding, line_start: 2, line_end: 30 }, 'RIGHT')).toBeNull();
  });
  it('keeps additions and deletions on their own side', () => {
    const diff = '@@ -1,3 +1,3 @@\n before();\n-oldCall();\n+newCall();\n after();';
    expect(AIPanel.sideLines(diff, 'LEFT').map(row => row.text)).toEqual(['before();', 'oldCall();', 'after();']);
    expect(AIPanel.sideLines(diff, 'RIGHT').map(row => row.text)).toEqual(['before();', 'newCall();', 'after();']);
  });
});

describe('historical finding workflow', () => {
  it('navigates matched current code and separates location from semantic relevance', async () => {
    panel.navigateToCode = vi.fn(async () => true);
    await panel.scrollToFinding(1, finding.file, 2);
    expect(panel.navigateToCode).toHaveBeenCalledWith({ file: finding.file, line_start: 11, line_end: 12, side: 'RIGHT' }, 1);
    expect(document.querySelector('.diff-navigation-guidance').textContent).toContain('Location matched · Issue relevance needs recheck');
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('keeps changed-code guidance inline with working recovery actions and bounded evidence', async () => {
    window.prManager.filePatches.set(finding.file, patch(1, ['replacement();']));
    window.prManager.findFileElement = vi.fn(() => document.getElementById('diff-container'));
    panel.navigateToCode = vi.fn(async () => true);
    await panel.scrollToFinding(1, finding.file, 2);
    const notice = document.querySelector('.finding-navigation-guidance');
    expect(notice.textContent).toContain('Code changed or the location is ambiguous');
    expect(notice.querySelector('details').open).toBe(false);
    expect(notice.querySelector('pre').textContent.split('\n').length).toBeLessThanOrEqual(8);
    [...notice.querySelectorAll('button')].find(button => button.textContent === 'Reanalyze latest').click();
    expect(window.prManager.triggerAIAnalysis).toHaveBeenCalledOnce();
    [...notice.querySelectorAll('button')].find(button => button.textContent === 'Open current file').click();
    await Promise.resolve();
    expect(panel.navigateToCode).toHaveBeenCalledWith({ file: finding.file }, 2);
  });
  it('handles missing saved data without a modal or a false current-line selection', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ run: { id: 'old', review_id: 7, diff: null } }) });
    panel.navigateToCode = vi.fn();
    await panel.scrollToFinding(1, finding.file, 2);
    expect(document.querySelector('[role="status"]').textContent).toContain('cannot be verified');
    expect(panel.navigateToCode).not.toHaveBeenCalled();
  });
  it('drops a stale async response after another navigation or diff replacement', async () => {
    let resolve;
    fetch.mockReturnValue(new Promise(done => { resolve = done; }));
    panel.navigateToCode = vi.fn();
    const pending = panel.scrollToFinding(1, finding.file, 2);
    ++panel._navGen;
    resolve({ ok: true, json: async () => ({ run: { id: 'old', review_id: 7, diff: patch(1, code) } }) });
    await pending;
    expect(panel.navigateToCode).not.toHaveBeenCalled();
  });
  it('does not use an AI-proposed location without independently matching saved text', async () => {
    panel.findings = [{ ...finding, revision_recheck: { head_sha: 'new', status: 'checked', relevance: 'still_relevant', reason: 'Needs a guard', location: { ...finding, line_start: 99 } } }];
    panel.navigateToCode = vi.fn(async () => true);
    await panel.scrollToFinding(1, finding.file, 2);
    expect(panel.navigateToCode.mock.calls[0][0].line_start).toBe(11);
    expect(document.querySelector('.diff-navigation-guidance').textContent).toContain('still relevant');
  });
  it('opens a file-level finding without inventing a line anchor', async () => {
    panel.findings = [{ ...finding, line_start: null, line_end: null, is_file_level: true }];
    panel.navigateToCode = vi.fn(async () => true);
    await panel.scrollToFinding(1, finding.file, null);
    expect(panel.navigateToCode).toHaveBeenCalledWith({ file: finding.file }, 1);
  });
  it('uses pending draft provenance rather than navigating its stale numeric line', async () => {
    panel.comments = [{ ...finding, source: 'user', ai_run_id: 'old', commit_sha: 'older', revision: 3, body: 'My edited text' }];
    panel.navigateToCode = vi.fn(async () => true);
    await panel.scrollToComment(1, finding.file, 2);
    expect(panel.navigateToCode.mock.calls[0][0].line_start).toBe(11);
    expect(document.querySelector('.finding-reanchor-form')).not.toBeNull();
    expect(document.querySelector('button[type="submit"]').disabled).toBe(true);
    expect(panel.comments[0].body).toBe('My edited text');
  });
  it('ignores semantic guidance from a different head', () => {
    panel.showNavigationGuidance({ ...finding, revision_recheck: { head_sha: 'wrong', status: 'checked', reason: 'Do not trust this' } }, { message: 'Unverified' });
    expect(document.body.textContent).not.toContain('Do not trust this');
  });
});

describe('current code anchor rendering', () => {
  it('awaits collapsed and lazy rendering, reveals the full LEFT range, then scrolls/highlights the exact file', async () => {
    const order = [];
    document.getElementById('diff-container').innerHTML = '<div data-file-name="other/src/a.js"><table><tr data-old="11"><td>wrong file</td></tr></table></div><div data-file-name="src/a.js"><table><tr data-old="11"><td>correct file</td></tr></table></div>';
    const wrapper = document.querySelector('[data-file-name="src/a.js"]');
    panel.expandFileIfCollapsed = vi.fn(async () => order.push('expand'));
    window.prManager.ensureFileBodyRendered = vi.fn(async () => order.push('render'));
    window.prManager.ensureLinesVisible = vi.fn(async () => order.push('reveal'));
    window.prManager.findFileElement = file => [...document.querySelectorAll('[data-file-name]')].find(node => node.dataset.fileName === file);
    window.prManager.getLineNumber = (row, side) => side === 'LEFT' ? Number(row.dataset.old) : null;
    panel._scrollDiffTarget = vi.fn(() => order.push('scroll'));
    const location = { file: finding.file, line_start: 11, line_end: 12, side: 'LEFT' };
    expect(await panel.navigateToCode(location, 0)).toBe(true);
    expect(order).toEqual(['expand', 'render', 'reveal', 'scroll']);
    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([location]);
    expect(panel._scrollDiffTarget).toHaveBeenCalledWith(wrapper.querySelector('tr'));
    expect(wrapper.querySelector('tr').classList.contains('highlight-flash')).toBe(true);
    expect(document.activeElement).toBe(wrapper.querySelector('tr'));
  });
  it('does not scroll or steal focus after the diff changed during lazy rendering', async () => {
    window.prManager.ensureFileBodyRendered = vi.fn(async () => { window.prManager.filePatches = new Map(); });
    expect(await panel.navigateToCode({ file: finding.file, line_start: 11, side: 'LEFT' }, 0)).toBe(false);
    expect(panel._scrollDiffTarget).not.toHaveBeenCalled();
  });
  it('does not hide mobile guidance when an anchor cannot be displayed', async () => {
    window.prManager.findFileElement = () => document.getElementById('diff-container');
    expect(await panel.navigateToCode({ file: finding.file, line_start: 999, side: 'LEFT' }, 0)).toBe(false);
    expect(panel._revealDiffForNavigation).not.toHaveBeenCalled();
  });
});

describe('explicit pending draft confirmation', () => {
  const draft = { id: 1, review_id: 7, draft_key: 'draft-one', revision: 3, source: 'user',
    body: 'Human-edited draft text', file: 'src/a.js', line_start: 2, line_end: 3, side: 'RIGHT', commit_sha: 'older' };
  const prepare = () => {
    panel.showNavigationGuidance(draft, { message: 'Location matched; confirm relevance.', inDiff: true,
      location: { file: draft.file, line_start: 11, line_end: 12, side: 'RIGHT' } });
    const form = document.querySelector('.finding-reanchor-form');
    const check = form.querySelector('[type="checkbox"]');
    const confirm = () => { check.checked = true; check.dispatchEvent(new Event('change')); };
    const submit = () => form.onsubmit({ preventDefault() {} });
    return { form, check, confirm, submit };
  };
  it('requires a new confirmation when saved text changed after it was inspected', async () => {
    const { form, check, confirm, submit } = prepare();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ comment: { ...draft, revision: 4, body: 'New text from another tab' } }) });
    confirm(); await submit();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(form.textContent).toContain('Draft changed. Inspect the latest saved text and confirm again.');
    expect(form.querySelector('.finding-reanchor-body').textContent).toBe('New text from another tab');
    expect(check.checked).toBe(false);
    expect(form.querySelector('[type="submit"]').disabled).toBe(true);
  });
  it('never posts after switching reviews while the latest draft request is held', async () => {
    let resolve;
    fetch.mockReturnValue(new Promise(done => { resolve = done; }));
    const { form, confirm, submit } = prepare();
    confirm(); const pending = submit();
    await Promise.resolve();
    window.prManager.currentPR = { id: 99, head_sha: 'new' };
    resolve({ ok: true, json: async () => ({ comment: draft }) });
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/reviews/7/comments/1');
    expect(form.textContent).toContain('viewed review or head changed');
  });
  it('permits same-text autosave revisions but posts the inspected draft identity and captured current anchor', async () => {
    const { confirm, submit } = prepare();
    window.prManager.loadUserComments = vi.fn();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ comment: { ...draft, revision: 4 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ comment: { ...draft, revision: 5, commit_sha: 'new' } }) });
    confirm(); await submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe('/api/reviews/7/comments/1/reanchor');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ draft_key: 'draft-one', expected_revision: 4,
      head_sha: 'new', confirmed: true, file: 'src/a.js', line_start: 11, line_end: 12, side: 'RIGHT', is_file_level: false });
  });
  it('invalidates relevance confirmation when the user changes the selected anchor', () => {
    const { form, check, confirm } = prepare();
    confirm();
    form.querySelector('[name="start"]').dispatchEvent(new Event('input', { bubbles: true }));
    expect(check.checked).toBe(false);
    expect(form.querySelector('[type="submit"]').disabled).toBe(true);
  });
});
