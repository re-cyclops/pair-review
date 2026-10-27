// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const source = readFileSync(new URL('../../public/js/components/ReviewInbox.js', import.meta.url), 'utf8');
const evidenceSource = readFileSync(new URL('../../public/js/components/ReviewEvidence.js', import.meta.url), 'utf8');
const bulkSource = readFileSync(new URL('../../public/js/components/BulkAnalysisLauncher.js', import.meta.url), 'utf8');
let dom, inbox, record, network;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (head, reviewer) => ({ ok: true, json: async () => ({ headSha: head,
  availability: 'known', fetchedAt: new Date().toISOString(),
  approvals: { observedCount: 1, approving: [{ reviewer: { login: reviewer } }] }, checks: {}, viewer: {} }) });

beforeEach(async () => {
  dom = new JSDOM(`<section id="recent-reviews-section"><header class="section-header"></header>
    <div id="pr-tab" class="tab-pane active"><div class="select-mode-header visible"><button type="button" class="btn-select-toggle" data-selection-tab="pr-tab">Select</button></div><table><tbody><tr data-owner="example" data-repo="project" data-number="42">
    <td class="col-identity"><span class="col-pr"><a href="/pr/example/project/42">#42</a></span><div class="col-title">Review target</div></td>
    <td class="col-requested"></td><td class="col-ai"></td><td class="col-state"></td><td class="col-actions"></td>
    </tr></tbody></table></div></section>`, { url: 'http://127.0.0.1/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.eval(evidenceSource);
  win.reviewWorkspace = { reviews: [], register() {}, loadReviews() {}, refresh() {} };
  win.matchMedia = () => ({ matches: true, addEventListener() {} });
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  network = win.fetch = vi.fn();
  win.eval(source);
  if (!win.reviewInbox) await new Promise(resolve => win.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  inbox = win.reviewInbox;
  record = [...inbox.records.values()][0];
});

afterEach(() => { inbox?.mutations.disconnect(); dom?.window.close(); });

describe('Inbox read ownership', () => {
  it('removes the last row from the visible count when a refresh empties its collection', async () => {
    expect(Number.parseInt(inbox.status.textContent, 10)).toBe(1);
    dom.window.document.querySelector('.tab-pane').replaceChildren(dom.window.document.createElement('p'));
    await Promise.resolve();
    expect(Number.parseInt(inbox.status.textContent, 10)).toBe(0);
  });

  it('keeps the result status beside the existing pane-owned selection controls', () => {
    const header = dom.window.document.querySelector('.select-mode-header');
    const select = header.querySelector('.btn-select-toggle');
    const actions = dom.window.document.createElement('span');
    actions.className = 'bulk-inline-actions';
    header.append(actions);
    inbox.applyFilters();
    expect(inbox.status.parentElement).toBe(header);
    expect(header.querySelector('.btn-select-toggle')).toBe(select);
    expect(actions.parentElement).toBe(header);
    expect(dom.window.document.querySelectorAll('.btn-select-toggle')).toHaveLength(1);
    inbox.search.value = 'does-not-match';
    inbox.applyFilters(true);
    expect(record.row.hidden).toBe(true);
    expect(Number.parseInt(inbox.status.textContent, 10)).toBe(0);
    inbox.search.value = '';
    inbox.applyFilters(true);
    expect(record.row.hidden).toBe(false);
    expect(Number.parseInt(inbox.status.textContent, 10)).toBe(1);
  });

  it('moves only the shared status when an empty pane activates and its header arrives later', async () => {
    const doc = dom.window.document;
    const originalPane = doc.querySelector('.tab-pane');
    const originalHeader = originalPane.querySelector('.select-mode-header');
    const originalSelect = originalHeader.querySelector('button');
    const pane = doc.createElement('div');
    pane.className = 'tab-pane active';
    originalPane.classList.remove('active');
    inbox.root.append(pane);
    inbox.applyFilters();
    expect(inbox.status.previousElementSibling).toBe(doc.querySelector('.workspace-inbox-tools'));
    expect(Number.parseInt(inbox.status.textContent, 10)).toBe(0);
    const header = doc.createElement('div');
    header.className = 'tab-pane-header';
    const select = doc.createElement('button');
    select.className = 'btn-select-toggle';
    header.append(select);
    pane.append(header);
    await Promise.resolve();
    expect(inbox.status.parentElement).toBe(header);
    expect(originalSelect.parentElement).toBe(originalHeader);
    expect(select.parentElement).toBe(header);
    pane.classList.remove('active');
    originalPane.classList.add('active');
    dom.window.dispatchEvent(new dom.window.CustomEvent('workspaceViewChanged', { detail: 'all' }));
    await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
    expect(inbox.status.parentElement).toBe(originalHeader);
    expect(select.parentElement).toBe(header);
  });

  it('does not reuse same-head evidence after a different account observation', async () => {
    const observe = observationId => dom.window.dispatchEvent(new dom.window.CustomEvent('workspaceCollectionObserved', {
      detail: { collection: 'my-prs', sources: [{ host: null, repo: null, observationId }] }
    }));
    observe('first-account-observation');
    network.mockResolvedValueOnce(response('same-head', 'previous-account'))
      .mockResolvedValueOnce(response('same-head', 'current-account'));
    await inbox.load(record);
    observe('current-account-observation');
    await inbox.load(record);
    expect(record.approvals.title).toContain('current-account');
    expect(record.approvals.title).not.toContain('previous-account');
  });

  it('refreshes visible evidence when account invalidation arrives during an older read', async () => {
    const held = deferred();
    network.mockReturnValueOnce(held.promise).mockResolvedValueOnce(response('same-head', 'current-account'));
    record.row.getClientRects = () => [{}];
    record.row.getBoundingClientRect = () => ({ top: 0, bottom: 40 });
    record.queued = true;
    inbox.queue.push(record);
    await inbox.drain();
    dom.window.dispatchEvent(new dom.window.CustomEvent('workspaceCollectionObserved', {
      detail: { collection: 'my-prs', sources: [{ host: null, repo: null, observationId: 'new-observation' }] }
    }));
    held.resolve(response('same-head', 'previous-account'));
    await vi.waitFor(() => expect(record.approvals.title).toContain('current-account'));
    expect(record.approvals.title).not.toContain('previous-account');
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each(['github', 'github.com'])('joins a default-host hint (%s) without mixing alternate-host drafts', host => {
    inbox.workspace.reviews = [
      { id: 2, reviewType: 'pr', repository: 'example/project', number: 42, host: 'https://code.example.invalid', draftCount: 8 },
      { id: 1, reviewType: 'pr', repository: 'example/project', number: 42, host: null, draftCount: 1 }
    ];
    record.row.dataset.analysisReviewId = '2';
    const row = record.row.cloneNode(true);
    row.dataset.host = host;
    record.row.parentElement.append(row);
    inbox.scan();
    const hinted = inbox.records.get(row);
    expect(inbox.local(record).id).toBe(1);
    expect(inbox.local(hinted).id).toBe(1);
    expect(hinted.key).toBe(record.key);
    expect(hinted.draft.textContent).not.toContain('8');
  });

  it('coalesces an inspector read with enrichment already in flight', async () => {
    const held = deferred();
    network.mockReturnValue(held.promise);
    const first = inbox.load(record);
    const second = inbox.load(record);
    held.resolve(response('head', 'reviewer'));
    await Promise.all([first, second]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(record.approvals.title).toContain('reviewer');
  });

  it.each([false, true])('keeps a forced fresh result after an older request settles (failure: %s)', async fails => {
    const held = deferred();
    network.mockReturnValueOnce(held.promise).mockResolvedValueOnce(response('new-head', 'new-reviewer'));
    const older = inbox.load(record);
    await inbox.load(record, true);
    if (fails) held.reject(new Error('Old request failed'));
    else held.resolve(response('old-head', 'old-reviewer'));
    await older;
    expect(record.snapshot.headSha).toBe('new-head');
    expect(record.snapshot.availability).toBe('known');
    expect(record.approvals.title).toContain('new-reviewer');
    expect(inbox.cache.get(record.key).value.headSha).toBe('new-head');
  });

  it('shares ownership across two rows for the same target instead of poisoning their cache', async () => {
    const held = deferred();
    network.mockReturnValueOnce(held.promise).mockResolvedValueOnce(response('new-head', 'new-reviewer'));
    const older = inbox.load(record);
    const row = record.row.cloneNode(true);
    record.row.parentElement.append(row);
    inbox.scan();
    const other = inbox.records.get(row);
    await inbox.load(other, true);
    held.resolve(response('old-head', 'old-reviewer'));
    await older;
    expect(inbox.cache.get(record.key).value.headSha).toBe('new-head');
    expect(record.approvals.title).toContain('new-reviewer');
    expect(other.approvals.title).toContain('new-reviewer');
  });

  it('discards old-connection evidence and does not join its pending request after a context change', async () => {
    const held = deferred();
    network.mockResolvedValueOnce(response('saved-head', 'previous-account'))
      .mockReturnValueOnce(held.promise).mockResolvedValueOnce(response('current-head', 'current-account'));
    await inbox.load(record);
    const older = inbox.load(record, true);
    dom.window.dispatchEvent(new dom.window.CustomEvent('workspaceContextChanged', { detail: { databaseChanged: false } }));
    const fresh = inbox.load(record);
    if (network.mock.calls.length === 2) held.resolve(response('old-head', 'previous-account'));
    await fresh;
    held.resolve(response('old-head', 'previous-account'));
    await older;
    expect(record.approvals.title).toContain('current-account');
    expect(record.approvals.title).not.toContain('previous-account');
    expect(record.snapshot.headSha).toBe('current-head');
  });

  it('keeps incomplete CI visible in uncertainty and attention filters until a complete passing read', () => {
    record.snapshot = {
      fetchedAt: new Date().toISOString(), viewer: { needsYou: false },
      approvals: { availability: 'known' }, requests: { availability: 'known' },
      policy: { availability: 'known' }, threads: { availability: 'known' },
      checks: { availability: 'partial', counts: { passed: 1, failed: 0, actionRequired: 0, cancelled: 0 } }
    };
    for (const filter of ['unknown', 'failed-ci']) {
      inbox.view.value = filter;
      inbox.view.dispatchEvent(new dom.window.Event('change'));
      expect(record.row.hidden).toBe(false);
    }
    record.snapshot.checks.availability = 'known';
    inbox.applyFilters(true);
    expect(record.row.hidden).toBe(true);
  });
});

describe('Confirmed approved cleanup', () => {
  const approve = (draft = {}) => {
    record.row.dataset.reviewId = '91';
    inbox.workspace.reviews = [{ id: 7, reviewType: 'pr', repository: 'example/project', number: 42, status: 'submitted', submittedEvent: 'APPROVE', ...draft }];
    inbox.renderRows();
    inbox.applyFilters();
    dom.window.confirmDialog = { show: vi.fn().mockResolvedValue('confirm') };
    return dom.window.confirmDialog.show;
  };

  it('confirms saved comments and summary before submitting metadata IDs', async () => {
    const confirm = approve({ draftCount: 2, hasDraftSummary: true });
    network.mockResolvedValue({ ok: true, json: async () => ({ success: true, deleted: 1, failed: 0, errors: [], warnings: [] }) });
    await inbox.clearApprovedReviews();
    expect(confirm.mock.calls[0][0].message).toContain('2 saved comments and 1 saved review summary');
    expect(confirm.mock.calls[0][0].message).toContain('example/project #42');
    expect(confirm.mock.calls[0][0].message).toContain('Remote reviews stay unchanged');
    expect(JSON.parse(network.mock.calls[0][1].body)).toEqual({ ids: [91] });
    expect(record.row.isConnected).toBe(false);
  });

  it('includes summary-only drafts and sends nothing on cancel', async () => {
    const confirm = approve({ draftCount: 0, hasDraftSummary: true });
    confirm.mockResolvedValue('cancel');
    await inbox.clearApprovedReviews();
    expect(confirm.mock.calls[0][0].message).toContain('0 saved comments and 1 saved review summary');
    expect(network).not.toHaveBeenCalled();
    expect(record.row.isConnected).toBe(true);
    expect(inbox.clearApprovedBtn.disabled).toBe(false);
  });

  it('keeps zero-success failures and displays their reasons', async () => {
    approve({ draftCount: 1 });
    network.mockResolvedValue({ ok: true, json: async () => ({ success: false, deleted: 0, failed: 1, errors: [{ id: 91, error: 'Active analysis' }], warnings: [] }) });
    await inbox.clearApprovedReviews();
    expect(record.row.isConnected).toBe(true);
    expect(inbox.cleanupResults.textContent).toContain('Removed 0');
    expect(inbox.cleanupResults.textContent).toContain('Active analysis');
  });

  it('removes only successful IDs and reports retained-checkout warnings', async () => {
    approve();
    const row = record.row.cloneNode(true);
    row.dataset.reviewId = '92';
    record.row.parentElement.append(row);
    inbox.scan();
    network.mockResolvedValue({ ok: true, json: async () => ({ success: false, deleted: 1, failed: 1, errors: [{ id: 92, error: 'Busy' }], warnings: [{ id: 91, message: 'Shared checkout retained' }] }) });
    await inbox.clearApprovedReviews();
    expect(record.row.isConnected).toBe(false);
    expect(row.isConnected).toBe(true);
    expect(inbox.cleanupResults.textContent).toContain('Busy');
    expect(inbox.cleanupResults.textContent).toContain('Shared checkout retained');
  });

  it('holds busy state through filter updates and blocks duplicate confirmation', async () => {
    const confirm = approve();
    const held = deferred();
    network.mockReturnValue(held.promise);
    const pending = inbox.clearApprovedReviews();
    await Promise.resolve();
    await inbox.clearApprovedReviews();
    inbox.applyFilters();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
    expect(inbox.clearApprovedBtn.textContent).toBe('Clearing approved…');
    expect(inbox.clearApprovedBtn.getAttribute('aria-busy')).toBe('true');
    held.reject(new Error('Offline'));
    await pending;
    expect(record.row.isConnected).toBe(true);
    expect(inbox.clearApprovedBtn.disabled).toBe(false);
    expect(inbox.cleanupResults.textContent).toContain('Offline');
  });

  it('uses at most 50 metadata IDs per request', async () => {
    approve();
    for (let id = 92; id < 142; id++) {
      const row = record.row.cloneNode(true);
      row.dataset.reviewId = String(id);
      record.row.parentElement.append(row);
    }
    inbox.scan();
    network.mockResolvedValue({ ok: true, json: async () => ({ errors: [], warnings: [] }) });
    await inbox.clearApprovedReviews();
    expect(network.mock.calls.map(call => JSON.parse(call[1].body).ids.length)).toEqual([50, 1]);
  });
});

describe('Inbox attribution and refresh feedback', () => {
  it('shows actual execution models rather than requested defaults', () => {
    inbox.workspace.reviews = [{ id: 7, reviewType: 'pr', repository: 'example/project', number: 42, aiRunCount: 1,
      latestAiRun: { status: 'completed', provider: 'omp', model: 'default', actualModels: [{ provider: 'google', model: 'gemini-concrete' }] } }];
    inbox.renderRows();
    expect(record.model.textContent).toContain('google/gemini-concrete');
    expect(record.model.textContent).not.toContain('omp/default');
    inbox.workspace.reviews[0].latestAiRun.actualModels = [];
    inbox.renderRows();
    expect(record.model.textContent.toLowerCase()).toContain('model not recorded');
  });

  it('keeps refresh visibly busy, blocks duplicate clicks, and recovers after failure', async () => {
    const held = deferred();
    record.row.getClientRects = () => [{}];
    network.mockReturnValue(held.promise);
    inbox.refreshBtn.click();
    inbox.refreshBtn.click();
    expect(network).toHaveBeenCalledTimes(1);
    expect(inbox.refreshBtn.textContent).toContain('Refreshing');
    expect(inbox.refreshBtn.getAttribute('aria-busy')).toBe('true');
    held.reject(new Error('Offline'));
    await vi.waitFor(() => expect(inbox.refreshBtn.disabled).toBe(false));
    expect(inbox.operationStatus.textContent).toContain('could not be refreshed');
    expect(inbox.refreshBtn.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('Inbox bulk analysis feedback', () => {
  it.each(['completed', 'failed'])('uses a new durable %s run instead of an older cached result', status => {
    inbox.workspace.reviews = [{ id: 10, reviewType: 'pr', repository: 'example/project', number: 42, aiRunCount: 1,
      latestAiRun: { id: 'old-run', status: 'completed', startedAt: '2026-01-01T00:00:00Z', totalSuggestions: 8 } }];
    dom.window.dispatchEvent(new dom.window.CustomEvent('workspaceActivity', { detail: { available: true, runs: [{
      analysisId: 'new-run', reviewId: 10, status, startedAt: '2026-10-20T00:00:00Z', totalSuggestions: 0
    }] } }));
    expect(record.activity.textContent).toContain(status === 'completed' ? '0 findings' : 'failed');
    expect(record.activity.textContent).not.toContain('8 findings');
  });

  it('keeps real launcher preparation feedback when the target row is replaced', async () => {
    dom.window.eval(bulkSource);
    const launcher = dom.window.bulkAnalysisLauncher = new dom.window.BulkAnalysisLauncher(inbox.workspace);
    const held = deferred();
    network.mockReturnValueOnce(held.promise).mockResolvedValueOnce({ ok: true, json: async () => ({ analysisId: 'new-run' }) });
    const operation = launcher.start([{ owner: 'example', repo: 'project', number: 42, url: '/pr/example/project/42' }],
      { provider: 'claude', model: 'sonnet-4.6' });
    expect(record.activity.textContent).toContain('Preparing pull request checkout');
    const row = record.row.cloneNode(true);
    record.row.replaceWith(row);
    inbox.scan();
    const replacement = inbox.records.get(row);
    expect(replacement.activity.textContent).toContain('Preparing pull request checkout');
    held.resolve({ ok: true, json: async () => ({ existing: true }) });
    await operation;
    expect(replacement.activity.textContent).toContain('Accepted by server');
  });
});

it('keeps completed finding count and actual model identity instead of a generic batch label', () => {
  inbox.workspace.reviews = [{ id: 10, reviewType: 'pr', repository: 'example/project', number: 42, aiRunCount: 2,
    latestAiRun: { id: 'new-run', status: 'completed', startedAt: '2026-10-20T00:00:00Z', totalSuggestions: 9,
      actualModels: [{ provider: 'codex', model: 'chosen-model' }] } }];
  inbox.runs = [{ analysisId: 'new-run', reviewId: 10, status: 'completed', startedAt: '2026-10-20T00:00:00Z', suggestionsCount: 4 }];
  dom.window.bulkAnalysisLauncher = { state: () => ({ analysisId: 'new-run', status: 'completed', message: 'completed · Analysis completed' }) };
  inbox.render(record);
  expect(record.activity.textContent).toContain('AI reviewed');
  expect(record.activity.textContent).toContain('4 findings');
  expect(record.model.textContent).toContain('codex/chosen-model');
});

it('shows finding counts and failed stages on partial AI runs instead of a bare AI partial label', () => {
  inbox.workspace.reviews = [{ id: 10, reviewType: 'pr', repository: 'example/project', number: 42, aiRunCount: 1,
    latestAiRun: { id: 'partial-run', status: 'partial', startedAt: '2026-10-22T14:35:03Z', totalSuggestions: 2,
      levelOutcomes: { level1: 'success', level2: 'success', level3: 'failed', consolidation: 'success' },
      stage: 'Partial results; Level 3 failed',
      actualModels: [{ provider: 'muse-code', model: 'muse-wonder-full-1.0' }] } }];
  inbox.render(record);
  expect(record.activity.dataset.aiState).toBe('reviewed');
  expect(record.activity.textContent).toBe('AI partial \u00B7 2 findings (L3 failed)');
  expect(record.activity.title).toContain('Level 3 failed');
});

it.each(['completed', 'failed'])('does not let older running activity hide a newer persisted %s result', status => {
  inbox.workspace.reviews = [{ id: 10, reviewType: 'pr', repository: 'example/project', number: 42, aiRunCount: 2,
    latestAiRun: { id: 'new-terminal', status, startedAt: '2026-10-20T00:00:00Z', totalSuggestions: 4,
      actualModels: [{ provider: 'codex', model: 'newest-model' }] } }];
  dom.window.dispatchEvent(new dom.window.CustomEvent('workspaceActivity', { detail: { available: true, runs: [{
    analysisId: 'old-active', reviewId: 10, status: 'running', stage: 'Older run still active', startedAt: '2026-10-19T00:00:00Z'
  }] } }));
  expect(record.activity.textContent).not.toContain('AI reviewing');
  expect(record.activity.textContent).not.toContain('Older run still active');
  expect(record.model.textContent).toContain('codex/newest-model');
  if (status === 'completed') {
    expect(record.activity.dataset.aiState).toBe('reviewed');
    expect(record.activity.textContent).toContain('AI reviewed');
    expect(record.activity.textContent).toContain('4 findings');
  } else {
    expect(record.activity.dataset.aiState).toBe('error');
    expect(record.activity.textContent).toContain('AI failed');
    expect(record.activity.textContent).not.toContain('4 findings');
  }
});

describe('First request evidence', () => {
  it('identifies fetched old-server history separately from current responsibility', () => {
    record.snapshot = { availability: 'known', viewer: { requestedDirectly: true }, approvals: {}, checks: {} };
    inbox.render(record);
    inbox.applyFilters(true);
    expect(record.requested.hasAttribute('datetime')).toBe(false);
    expect(inbox.requestDateNotice.textContent).not.toBe('');
    expect(record.reason.textContent).toContain('requested from you');
    expect(record.badge.hidden).toBe(true);
    expect(record.next.textContent).not.toContain('changes');
  });

  it('does not suggest a server update for unfetched, loading, failed, or known-empty history', () => {
    inbox.operationStatus.textContent = 'Existing operation feedback';
    const states = [
      null,
      { availability: 'loading' },
      { availability: 'unavailable', error: 'Offline' },
      { availability: 'known', viewer: { reviewRequest: { availability: 'known', firstRequestedAt: null } } },
      { availability: 'known', viewer: { reviewRequest: { availability: 'unavailable', reason: 'unauthenticated' } } }
    ];
    const labels = [];
    for (const snapshot of states) {
      record.snapshot = snapshot;
      inbox.render(record);
      inbox.applyFilters(true);
      labels.push(record.requested.textContent);
      expect(inbox.requestDateNotice.textContent).toBe('');
      expect(record.requested.hasAttribute('datetime')).toBe(false);
      expect(inbox.operationStatus.textContent).toBe('Existing operation feedback');
    }
    expect(new Set(labels).size).toBe(4);
    expect(record.requestContext.textContent).not.toBe('');
    expect(record.requestContext.textContent).not.toContain('unauthenticated');
  });

  it('shows old-server recovery only for matching rows in the active pane', () => {
    record.snapshot = { availability: 'known', viewer: { requestedDirectly: true } };
    inbox.render(record);
    inbox.applyFilters(true);
    expect(inbox.requestDateNotice.textContent).not.toBe('');
    inbox.search.value = 'does-not-match';
    inbox.applyFilters(true);
    expect(inbox.requestDateNotice.textContent).toBe('');
    inbox.search.value = '';
    record.row.closest('.tab-pane').classList.remove('active');
    inbox.applyFilters(true);
    expect(inbox.requestDateNotice.textContent).toBe('');
  });

  it.each(['incomplete-history', 'unknown-viewer', 'unknown-request-target', 'unknown-team-membership', 'invalid-request-date', 'unauthenticated', 'rate-limited', 'permission-denied-or-rate-limited', 'not-available', 'offline-or-unsupported'])('explains request history failure %s visibly without fabricating a date', reason => {
    record.snapshot = { availability: 'known', viewer: { reviewRequest: { availability: 'partial', reason } } };
    inbox.render(record);
    expect(record.requested.hasAttribute('datetime')).toBe(false);
    expect(record.requestContext.textContent).not.toBe('');
    expect(record.requestContext.textContent).not.toContain(reason);
  });

  it('shows the recorded first team request with exact date and real requester', () => {
    record.snapshot = { availability: 'known', viewer: { requestedViaTeam: true, reviewRequest: {
      availability: 'known', firstRequestedAt: '2026-03-01T12:30:00Z', source: 'team',
      team: { id: 1, slug: 'platform', name: 'Platform' }, requestedBy: { login: 'actual-requester' }
    } }, approvals: {}, checks: {} };
    inbox.render(record);
    expect(record.requested.title).toContain('2026-03-01T12:30:00Z');
    expect(record.requested.getAttribute('datetime')).toBe('2026-03-01T12:30:00Z');
    expect(record.requestContext.textContent).toContain('Platform');
    expect(record.requestContext.textContent).toContain('@actual-requester');
    expect(record.reason.textContent).toBe('');
    expect(record.row.querySelector('.col-ai').contains(record.activity)).toBe(true);
    expect(record.row.querySelector('.col-title').contains(record.activity)).toBe(false);
  });

  it('attributes a changes-requested decision independently of a review request', () => {
    record.snapshot = { availability: 'known', viewer: { requestedDirectly: true }, checks: {},
      approvals: { availability: 'known', effective: [{ state: 'CHANGES_REQUESTED', reviewer: { login: 'reviewer' } }] } };
    inbox.render(record);
    expect(record.decisions.textContent).toContain('@reviewer');
    expect(record.badge.hidden).toBe(true);
    expect(record.next.textContent).not.toContain('requested changes');
  });
});

it.each(['known', 'partial'])('keeps your approval separate from others’ %s decision evidence', availability => {
  record.snapshot = { availability: 'known', viewer: { effectiveReview: { state: 'APPROVED' } }, checks: {},
    approvals: { availability, effective: [{ state: 'CHANGES_REQUESTED', reviewer: { login: 'other-reviewer' } }] } };
  inbox.render(record);
  expect(record.badge.dataset.status).toBe('approved');
  expect(record.badge.hidden).toBe(false);
  expect(record.decisions.textContent).toContain('@other-reviewer');
  expect(record.decisions.textContent.includes('partial history')).toBe(availability === 'partial');
});

it.each(['queued', 'preparing', 'launching'])('does not attribute a previous execution model to a new %s launch', status => {
  inbox.workspace.reviews = [{ id: 10, reviewType: 'pr', repository: 'example/project', number: 42, aiRunCount: 1,
    latestAiRun: { id: 'old-run', status: 'completed', actualModels: [{ provider: 'google', model: 'old-model' }] } }];
  dom.window.bulkAnalysisLauncher = { state: () => ({ status, message: status }) };
  inbox.render(record);
  expect(record.activity.dataset.aiState).toBe('running');
  expect(record.model.textContent).not.toContain('old-model');
  expect(record.model.title).not.toContain('old-model');
  expect(record.model.textContent.toLowerCase()).toContain('pending');
});
