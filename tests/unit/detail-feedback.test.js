// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createHash, webcrypto } from 'node:crypto';
global.document = { addEventListener: vi.fn() };
const { AIPanel } = require('../../public/js/components/AIPanel.js');
const { PRManager } = require('../../public/js/pr.js');
const { LocalManager } = require('../../public/js/local.js');
let panel;
beforeEach(() => {
  const dom = new JSDOM('<button id="ai-panel-toggle"></button><aside id="ai-panel"><div class="findings-list"></div></aside><div id="diff-container"></div>', { url: 'http://localhost/pr/example/repo/42' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  window.toast = { showWarning: vi.fn() };
  panel = Object.create(AIPanel.prototype);
  panel.toggleBtn = document.getElementById('ai-panel-toggle');
  panel.panel = document.getElementById('ai-panel');
  panel.findingsList = document.querySelector('.findings-list');
  panel.findings = [];
  panel.analysisState = 'unknown';
  vi.stubGlobal('crypto', webcrypto);
});
describe('detail review feedback', () => {
  it('distinguishes no review, zero findings, loading, running and unavailable review', () => {
    for (const [state, text] of [['unknown', 'Not reviewed'], ['complete', '0 AI findings'], ['fetching', 'Loading AI findings'], ['loading', 'AI review running'], ['failed', 'AI review unavailable']]) {
      panel.updateFindingsAction(state);
      expect(panel.toggleBtn.textContent).toContain(text);
      expect(panel.toggleBtn.getAttribute('aria-controls')).toBe('ai-panel');
    }
  });
  it('counts actionable AI findings independently of user comments', () => {
    panel.findings = [{ id: 1 }, { id: 2, status: 'dismissed' }, { id: 3, status: 'adopted' }];
    panel.comments = [{ id: 4 }];
    panel.updateFindingsAction('complete');
    expect(panel.toggleBtn.textContent).toBe('1 AI finding');
  });
  it('preserves keyboard toggling separately from the open-findings action', () => {
    panel.isCollapsed = true;
    panel.panel.classList.add('collapsed');
    panel.toggle();
    expect(panel.panel.classList.contains('collapsed')).toBe(false);
    expect(panel.toggleBtn.getAttribute('aria-expanded')).toBe('true');
    panel.toggle();
    expect(panel.panel.classList.contains('collapsed')).toBe(true);
    expect(panel.toggleBtn.getAttribute('aria-expanded')).toBe('false');
  });
  it('moves keyboard focus into the findings list when opened', () => {
    const aiButton = document.createElement('button');
    aiButton.dataset.segment = 'ai';
    panel.segmentControl = { querySelector: () => aiButton };
    panel.onSegmentSelect = vi.fn();
    panel.expand = vi.fn();
    panel.openFindings();
    expect(document.activeElement).toBe(panel.findingsList);
  });
  it('labels historical findings without replacing the current diff', () => {
    panel.setRevisionContext({ historical: true, message: 'Saved review of abc123; viewing def456.' });
    expect(document.querySelector('.ai-revision-notice').textContent).toContain('abc123');
    expect(panel.toggleBtn.textContent).toContain('Historical');
  });
  it('protects unsaved editors before replacing the diff', () => {
    const manager = Object.create(PRManager.prototype);
    document.getElementById('diff-container').innerHTML = '<textarea>Unsaved review</textarea>';
    expect(manager._canReplaceDiff()).toBe(false);
    expect(document.querySelector('textarea').value).toBe('Unsaved review');
    expect(window.toast.showWarning).toHaveBeenCalled();
  });
  it.each(['pr', 'local'])('retains an editor opened while the %s updated diff request is pending', async (mode) => {
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 42, head_sha: 'old-head' };
    manager.loadViewedState = vi.fn().mockResolvedValue();
    manager.renderDiff = vi.fn();
    window.prManager = manager;
    let resolve;
    global.fetch = vi.fn(() => new Promise(done => { resolve = done; }));
    const local = Object.create(LocalManager.prototype);
    local.reviewId = 42;
    const pending = mode === 'pr'
      ? manager.loadAndDisplayFiles('owner', 'repo', 42, { preserveEditors: true })
      : local.loadLocalDiff({ preserveEditors: true });
    document.getElementById('diff-container').innerHTML = '<textarea>Typed while updating</textarea>';
    resolve({ ok: true, json: async () => ({ diff: '', changed_files: [], progress_context: { head: 'new-head' } }) });
    await expect(pending).rejects.toThrow('protect an open editor');
    expect(document.querySelector('textarea').value).toBe('Typed while updating');
    expect(manager.renderDiff).not.toHaveBeenCalled();
    expect(manager.currentPR.head_sha).toBe('old-head');
    expect(manager.displayedProgressContext).toBeUndefined();
  });
  it('compares canonical Local digest rather than whitespace-filtered transport text', async () => {
    const manager = Object.create(PRManager.prototype);
    const canonical = 'diff --git a/a b/a\n@@ -1 +1 @@\n-old \n+new \n';
    manager._viewedLocalDiff = 'whitespace-filtered view';
    manager.displayedProgressContext = { digest: createHash('sha256').update(canonical).digest('hex') };
    expect(await manager._matchesViewedLocalDiff(canonical)).toBe(true);
    expect(await manager._matchesViewedLocalDiff(canonical.replace('+new ', '+other '))).toBe(false);
  });
  it('recognizes unchanged full-blob Local snapshots across diff context amounts without accepting changed content', async () => {
    const manager = Object.create(PRManager.prototype);
    const header = `diff --git a/sample.js b/sample.js\nindex ${'a'.repeat(40)}..${'b'.repeat(40)} 100644\n--- a/sample.js\n+++ b/sample.js\n`;
    const saved = header + '@@ -3,1 +3,2 @@\n three\n+added\n';
    manager._viewedLocalDiff = header + '@@ -1,3 +1,4 @@\n one\n two\n three\n+added\n';
    expect(await manager._matchesViewedLocalDiff(saved)).toBe(true);
    manager._viewedLocalDiff = manager._viewedLocalDiff.replace('+added', '+different');
    expect(await manager._matchesViewedLocalDiff(saved)).toBe(false);
    manager._viewedLocalDiff = (header + '@@ -1,3 +1,4 @@\n one\n two\n three\n+added\n').replace('b'.repeat(40), 'c'.repeat(40));
    expect(await manager._matchesViewedLocalDiff(saved)).toBe(false);
  });
  it.each(['quoted', 'duplicate'])('does not certify only the parsed subset of a %s-path diff', async (kind) => {
    const manager = Object.create(PRManager.prototype);
    const header = `diff --git a/sample.js b/sample.js\nindex ${'a'.repeat(40)}..${'b'.repeat(40)} 100644\n--- a/sample.js\n+++ b/sample.js\n`;
    const saved = header + '@@ -3,1 +3,2 @@\n three\n+added\n';
    const viewed = header + '@@ -1,3 +1,4 @@\n one\n two\n three\n+added\n';
    const extra = kind === 'quoted'
      ? saved.replaceAll('a/sample.js', '"a/quoted\\t.js"').replaceAll('b/sample.js', '"b/quoted\\t.js"')
      : saved;
    manager._viewedLocalDiff = extra.replace('+added', '+different') + viewed;
    expect(await manager._matchesViewedLocalDiff(extra + saved)).toBe(false);
  });
  it('rejects a digest match when the displayed Local snapshot changes during hashing', async () => {
    const manager = Object.create(PRManager.prototype);
    const saved = 'saved snapshot';
    manager._viewedLocalDiff = saved;
    manager.displayedProgressContext = { digest: createHash('sha256').update(saved).digest('hex') };
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(saved));
    let resolve;
    vi.stubGlobal('crypto', { subtle: { digest: () => new Promise(done => { resolve = done; }) } });
    const pending = manager._matchesViewedLocalDiff(saved);
    manager.displayedProgressContext = { digest: 'new-snapshot' };
    manager._viewedLocalDiff = 'new snapshot';
    resolve(digest);
    expect(await pending).toBe(false);
  });
  it.each(['context', 'scope'])('does not replace new revision evidence after the viewed %s changes during a request', async (change) => {
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 42, head_sha: 'head' };
    manager.displayedProgressContext = { digest: 'old' };
    window.localManager = { scopeStart: 'unstaged', scopeEnd: 'untracked' };
    window.aiPanel = panel;
    panel.setRevisionContext({ message: 'Evidence for the newly viewed snapshot' });
    let resolve;
    global.fetch = vi.fn(() => new Promise(done => { resolve = done; }));
    const pending = manager.loadAISuggestions();
    if (change === 'context') manager.displayedProgressContext = { digest: 'new' };
    else window.localManager.scopeStart = 'HEAD';
    resolve({ ok: true, json: async () => ({ analysisHasRun: true }) });
    await pending;
    expect(document.querySelector('.ai-revision-notice').textContent).toBe('Evidence for the newly viewed snapshot');
    expect(panel.historicalFindings).toBe(false);
  });
  it('restores the Local base selection and avoids success notifications when replacement is paused', async () => {
    const manager = Object.create(PRManager.prototype);
    manager.currentBaseOverride = 'feature-base';
    manager.currentPR = { base_branch: 'main' };
    document.body.insertAdjacentHTML('beforeend', '<select id="base-branch-select"><option>feature-base</option><option>main</option></select>');
    window.chatPanel = { queueDiffStateNotification: vi.fn() };
    const local = Object.create(LocalManager.prototype);
    local.loadLocalDiff = vi.fn().mockRejectedValue(new Error('Editor opened'));
    await expect(local._applyRefreshedDiff(manager, {})).rejects.toThrow('Editor opened');
    expect(manager.currentBaseOverride).toBe('feature-base');
    expect(document.getElementById('base-branch-select').value).toBe('feature-base');
    expect(window.chatPanel.queueDiffStateNotification).not.toHaveBeenCalled();
  });
  it.each(['redirect', 'new-session'])('protects an editor opened while Local %s resolution is pending', async (action) => {
    const manager = Object.create(PRManager.prototype);
    window.prManager = manager;
    let resolve;
    global.fetch = vi.fn(() => new Promise(done => { resolve = done; }));
    const local = Object.create(LocalManager.prototype);
    local.reviewId = 42;
    const pending = local._resolveHeadChange({ currentHeadSha: 'new' }, { silent: true });
    document.getElementById('diff-container').innerHTML = '<textarea>Retain on redirect</textarea>';
    resolve({ ok: true, json: async () => ({ action, sessionId: 43, newSessionId: 43 }) });
    await expect(pending).rejects.toThrow('protect an open editor');
    expect(window.location.pathname).toBe('/pr/example/repo/42');
    expect(document.querySelector('textarea').value).toBe('Retain on redirect');
  });
  it('opens historical saved code at the original side and line, never current code', async () => {
    window.prManager = { currentPR: { id: 42 }, parseUnifiedDiff: PRManager.prototype.parseUnifiedDiff, analysisHistoryManager: { getSelectedRunId: () => 'old-run' } };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ run: { id: 'old-run', review_id: 42, head_sha: 'abc1234', diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -10,2 +10,2 @@\n-old code\n+new code\n context' } }) });
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    panel.findings = [{ id: 1, side: 'LEFT' }];
    await panel.openHistoricalFinding(1, 'a.js', 10);
    expect(document.querySelector('.historical-diff-target').textContent).toBe('-old code\n');
    expect(document.querySelector('.historical-diff-dialog').textContent).toContain('read-only');
    expect(document.getElementById('diff-container').textContent).toBe('');
  });
});
