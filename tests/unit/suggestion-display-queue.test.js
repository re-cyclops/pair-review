// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Newer suggestion renders own the view. An older asynchronous expansion
 * must not replace the selected run, and clearing findings must prevent
 * every pending render from bringing the old findings back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

global.STALE_TIMEOUT = 2000;

const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { PRManager } = require('../../public/js/pr.js');
const { LocalManager } = require('../../public/js/local.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makePrManager(overrides = {}) {
  return {
    currentPR: { id: 'review-1' },
    pierreBridge: null,
    ensureFileBodyRendered: vi.fn(async () => null),
    ensureLinesVisible: vi.fn(async () => {}),
    findFileElement: vi.fn(() => null),
    fileCommentManager: { loadFileComments: vi.fn() },
    suggestionNavigator: { updateSuggestions: vi.fn(), isCollapsed: false },
    ...overrides
  };
}

const finding = id => ({ id, file: 'src/a.js', line_start: id, side: 'RIGHT', status: 'active' });

let pm;
let sm;

beforeEach(() => {
  document.body.innerHTML = '';
  window.aiPanel = { addFindings: vi.fn() };
  pm = makePrManager();
  sm = new SuggestionManager(pm);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.aiPanel;
  delete window.prManager;
});

const navigatorLists = () => pm.suggestionNavigator.updateSuggestions.mock.calls.map(call => call[0]);

describe('SuggestionManager concurrent rendering', () => {
  it('does not let an older diff expansion replace the newest findings', async () => {
    const oldExpansion = deferred();
    const newExpansion = deferred();
    pm.ensureFileBodyRendered = vi.fn()
      .mockReturnValueOnce(oldExpansion.promise)
      .mockReturnValueOnce(newExpansion.promise);
    const latest = [finding(3)];
    const stale = sm.displayAISuggestions([finding(1)]);
    const fresh = sm.displayAISuggestions(latest);

    newExpansion.resolve();
    await fresh;
    oldExpansion.resolve();
    await stale;

    expect(navigatorLists()).toEqual([latest]);
    expect(window.aiPanel.addFindings.mock.calls.map(call => call[0])).toEqual([latest]);
  });

  it('keeps the navigator list while a display runs, so its selection survives', async () => {
    const list = [finding(1), finding(2)];
    await sm.displayAISuggestions(list);
    // Only the new list reaches the navigator: no interim empty list that
    // would drop the selection.
    expect(navigatorLists()).toEqual([list]);
  });

  it('replaces file-level AI cards without touching user cards', async () => {
    const fileLevel = { id: 9, file: 'src/a.js', is_file_level: 1, line_start: null };

    await sm.displayAISuggestions([finding(1), fileLevel]);

    const calls = pm.fileCommentManager.loadFileComments.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Comments are always null, so user file-level cards are left alone.
    expect(calls.every(([comments]) => comments === null)).toBe(true);
    expect(calls[calls.length - 1]).toEqual([null, [fileLevel]]);
  });
});

describe('SuggestionManager.clearAISuggestions', () => {
  it('removes inline rows, Pierre suggestion annotations, file-level AI cards and the navigator list', () => {
    document.body.innerHTML = `
      <div class="main-content navigator-visible"></div>
      <table><tbody>
        <tr class="code-row"></tr>
        <tr class="ai-suggestion-row"></tr>
        <tr class="user-comment-row"></tr>
        <tr class="ai-suggestion-row"></tr>
      </tbody></table>
      <div class="reasoning-popover"></div>
    `;
    pm.pierreBridge = {
      files: new Map([['src/a.js', {}], ['src/b.js', {}]]),
      removeAnnotationsByType: vi.fn()
    };

    sm.clearAISuggestions();

    expect(document.querySelectorAll('.ai-suggestion-row')).toHaveLength(0);
    expect(document.querySelectorAll('.user-comment-row')).toHaveLength(1);
    expect(document.querySelector('.reasoning-popover')).toBeNull();
    expect(pm.pierreBridge.removeAnnotationsByType.mock.calls).toEqual([
      ['src/a.js', 'suggestion'],
      ['src/b.js', 'suggestion']
    ]);
    expect(pm.fileCommentManager.loadFileComments).toHaveBeenCalledExactlyOnceWith(null, []);
    expect(navigatorLists()).toEqual([[]]);
    expect(document.querySelector('.main-content').classList.contains('navigator-visible')).toBe(false);
  });

  it('works without a navigator, Pierre bridge or file comment manager', () => {
    sm = new SuggestionManager(makePrManager({ suggestionNavigator: null, fileCommentManager: null }));
    expect(() => sm.clearAISuggestions()).not.toThrow();
  });

  it('clears all pending displays without resurrecting their findings', async () => {
    const gate = deferred();
    pm.ensureLinesVisible = vi.fn(() => gate.promise);

    const running = sm.displayAISuggestions([finding(1)]);
    const newer = sm.displayAISuggestions([finding(2)]);
    sm.clearAISuggestions();
    gate.resolve();
    await Promise.all([running, newer]);

    // Only the clear reached the navigator; the stale lists never showed.
    expect(navigatorLists()).toEqual([[]]);
    expect(window.aiPanel.addFindings).not.toHaveBeenCalled();

    // The next display (the new run's results) shows normally.
    const fresh = [finding(5)];
    await sm.displayAISuggestions(fresh);
    expect(navigatorLists()).toEqual([[], fresh]);
    expect(window.aiPanel.addFindings).toHaveBeenCalledExactlyOnceWith(fresh);
  });
});

describe('PRManager.clearFindingsForNewAnalysis', () => {
  function makeManager() {
    const manager = Object.create(PRManager.prototype);
    manager.suggestionManager = { clearAISuggestions: vi.fn() };
    return manager;
  }

  it('clears through the AI panel, which also clears the diff view', () => {
    const manager = makeManager();
    window.aiPanel = { clearAllFindings: vi.fn() };

    manager.clearFindingsForNewAnalysis();

    expect(window.aiPanel.clearAllFindings).toHaveBeenCalledTimes(1);
    expect(manager.suggestionManager.clearAISuggestions).not.toHaveBeenCalled();
  });

  it('still clears the diff view when the AI panel fails', () => {
    const manager = makeManager();
    window.aiPanel = { clearAllFindings: vi.fn(() => { throw new Error('panel broke'); }) };

    manager.clearFindingsForNewAnalysis();

    expect(manager.suggestionManager.clearAISuggestions).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('Error clearing AI panel findings:', expect.any(Error));
  });

  it('clears the diff view when there is no AI panel', () => {
    const manager = makeManager();
    delete window.aiPanel;

    manager.clearFindingsForNewAnalysis();

    expect(manager.suggestionManager.clearAISuggestions).toHaveBeenCalledTimes(1);
  });

  it('runs before the PR-mode analysis request is sent', async () => {
    const manager = makeManager();
    const order = [];
    manager.clearFindingsForNewAnalysis = vi.fn(() => order.push('clear'));
    manager.showError = vi.fn();
    manager.resetButton = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('fetch');
      return { ok: false, json: async () => ({ error: 'stop here' }) };
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await manager.startAnalysis('owner', 'repo', 1, null, { provider: 'claude' });

    expect(order).toEqual(['clear', 'fetch']);
  });
});

describe('Local mode analysis start', () => {
  it('clears the previous findings before the analysis request, like PR mode', async () => {
    const order = [];
    window.prManager = {
      clearFindingsForNewAnalysis: vi.fn(() => order.push('clear')),
      showError: vi.fn(),
      resetButton: vi.fn()
    };
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('fetch');
      return { ok: false, json: async () => ({ error: 'stop here' }) };
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const localManager = Object.create(LocalManager.prototype);
    localManager.reviewId = 42;

    await localManager.startLocalAnalysis(null, { provider: 'claude' });

    expect(order).toEqual(['clear', 'fetch']);
    expect(window.prManager.showError).toHaveBeenCalledWith('Failed to start AI analysis: stop here');
  });
});
