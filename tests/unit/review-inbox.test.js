// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const source = readFileSync(new URL('../../public/js/components/ReviewInbox.js', import.meta.url), 'utf8');
const evidenceSource = readFileSync(new URL('../../public/js/components/ReviewEvidence.js', import.meta.url), 'utf8');
let dom, inbox, record, network;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (head, reviewer) => ({ ok: true, json: async () => ({ headSha: head,
  availability: 'known', fetchedAt: new Date().toISOString(),
  approvals: { observedCount: 1, approving: [{ reviewer: { login: reviewer } }] }, checks: {}, viewer: {} }) });

beforeEach(async () => {
  dom = new JSDOM(`<section id="recent-reviews-section"><header class="section-header"></header>
    <div class="tab-pane active"><table><tbody><tr data-owner="example" data-repo="project" data-number="42">
    <td class="col-pr"><a href="/pr/example/project/42">#42</a></td><td class="col-title">Review target</td>
    </tr></tbody></table></div></section>`, { url: 'http://127.0.0.1/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.eval(evidenceSource);
  win.reviewWorkspace = { reviews: [], register() {}, loadReviews() {} };
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
    expect(record.approvals.textContent).toContain('current-account');
    expect(record.approvals.textContent).not.toContain('previous-account');
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
    await vi.waitFor(() => expect(record.approvals.textContent).toContain('current-account'));
    expect(record.approvals.textContent).not.toContain('previous-account');
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
    expect(record.approvals.textContent).toContain('reviewer');
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
    expect(record.approvals.textContent).toContain('new-reviewer');
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
    expect(record.approvals.textContent).toContain('new-reviewer');
    expect(other.approvals.textContent).toContain('new-reviewer');
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
    expect(record.approvals.textContent).toContain('current-account');
    expect(record.approvals.textContent).not.toContain('previous-account');
    expect(record.snapshot.headSha).toBe('current-head');
  });
});
