// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const draftModule = require.resolve('../../public/js/modules/draft-store.js');
delete require.cache[draftModule];
require(draftModule);
const { ReviewModal } = require('../../public/js/components/ReviewModal.js');
const drafts = window.reviewDrafts;
const modal = window.reviewModal || new ReviewModal();
let manifest;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
  sessionStorage.clear();
  drafts.entries.clear();
  drafts.connect({ dbId: 'modal-test-db', instanceId: 'modal-test-instance' });
  window.prManager = { currentPR: { id: 1, head_sha: 'head' } };
  window.aiPanel = { getSummary: () => 'AI finding\n\n    keepIndentation();\n' };
  document.body.replaceChildren(drafts.button);
  modal.reviewId = 1;
  modal.isSubmitting = false;
  modal.isQuickSubmitting = false;
  modal.isPreparing = false;
  modal.cleanupPending = false;
  modal.lastReceipt = null;
  modal.modal = document.createElement('dialog');
  modal.modal.open = true;
  modal.content = document.createElement('div');
  modal.modal.append(modal.content);
  document.body.append(modal.modal);
  modal.error = document.createElement('p');
  modal.note = document.createElement('p');
  modal.savedSummary = { id: 1, revision: 2, body: 'Existing review body\n', event: 'COMMENT' };
  const comment = { id: 10, draft_key: 'draft-10', revision: 3, included: 1, file: 'a.js',
    line_start: 2, line_end: 2, side: 'RIGHT', body: 'Exact draft\n', status: 'active' };
  modal.comments = new Map([[comment.id, comment]]);
  manifest = {
    reviewType: 'pr', body: modal.savedSummary.body, bodyRevision: 2, event: 'COMMENT', mode: 'submit',
    count: 1, digest: 'confirmed-server-manifest', fetchedAt: '2026-10-08T12:00:00Z', blockers: [],
    allowedEvents: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'],
    target: { repository: 'owner/repo', number: 1, host: 'github.com', head: 'head',
      account: { id: 7, login: 'reviewer' }, url: 'https://github.com/owner/repo/pull/1' },
    drafts: [{ id: 10, key: comment.draft_key, revision: 3, included: true, body: comment.body,
      wire: { path: 'a.js', line: 2, side: 'RIGHT', isFileLevel: false }, errors: [] }]
  };
  await modal.renderAuthoring(manifest);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  drafts.entries.clear();
  sessionStorage.clear();
});

describe('Review authorization and durable authoring', () => {
  it('appends an explicitly requested AI summary into the real recoverable editor without rewriting either text', () => {
    modal.appendAISummary();
    const expected = 'Existing review body\n\n\nAI finding\n\n    keepIndentation();\n';
    expect(modal.bodyInput.value).toBe(expected);
    expect(modal.bodyInput.draftEntry.body).toBe(expected);
    expect(drafts.hasPending(1)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(`${drafts.prefix}1:summary:1`)).body).toBe(expected);
    expect(document.activeElement).toBe(modal.bodyInput);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears a confirmed publication when the user edits, retaining the new text for recovery', async () => {
    modal.manifest = manifest;
    modal.renderFinal(manifest);
    expect(modal.publishButton.disabled).toBe(true);
    modal.confirm.checked = true;
    modal.confirm.dispatchEvent(new Event('change'));
    expect(modal.publishButton.disabled).toBe(false);
    const textarea = modal.cards.get('draft-10').textarea;
    textarea.value = 'New unsubmitted text\n';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(modal.confirm.checked).toBe(false);
    expect(modal.confirm.disabled).toBe(true);
    expect(modal.publishButton.disabled).toBe(true);
    expect(textarea.value).toBe('New unsubmitted text\n');
    expect(drafts.hasPending(1)).toBe(true);
    await modal.publish();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['revision', 'body', 'included'])('refuses a fresh manifest whose %s differs from the visible authoring view', field => {
    if (field === 'revision') manifest.drafts[0].revision++;
    if (field === 'body') manifest.drafts[0].body = 'Peer edit';
    if (field === 'included') manifest.drafts[0].included = false;
    modal.manifest = manifest;
    modal.renderFinal(manifest);
    expect(modal.manifest).toBeNull();
    expect(modal.finalSection.querySelector('input[type=checkbox]')).toBeNull();
    expect(modal.cards.get('draft-10').textarea.value).toBe('Exact draft\n');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a host-blocked preview non-publishable even if a stale caller invokes publication', async () => {
    manifest.blockers = ['Current revision cannot be verified'];
    modal.manifest = manifest;
    modal.renderFinal(manifest);
    expect(modal.confirm.disabled).toBe(true);
    modal.confirm.checked = true;
    await modal.publish();
    expect(fetch).not.toHaveBeenCalled();
    expect(modal.bodyInput.value).toBe('Existing review body\n');
  });

  it('restores the selected action after a failed quick preflight', async () => {
    const actionLabel = modal.quickSubmitButton.textContent;
    fetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'Host unavailable' }) });
    await expect(modal.quickSubmit()).rejects.toThrow('Host unavailable');
    expect(modal.quickSubmitButton.textContent).toBe(actionLabel);
    expect(modal.quickSubmitButton.disabled).toBe(false);
    expect(modal.quickSubmitButton.dataset.loading).toBeUndefined();
    expect(modal.authoring.disabled).toBe(false);
  });

  it.each(['quick approval', 'explicit preview'])('locks conflicting actions during %s and ignores a second invocation', async mode => {
    const actionLabel = modal.quickSubmitButton.textContent;
    let release;
    const response = new Promise(resolve => { release = resolve; });
    fetch.mockReturnValue(response);
    const first = mode === 'quick approval' ? modal.quickSubmit() : modal.prepare();
    let second;
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(modal.prepareButton.disabled).toBe(true);
      expect(modal.refreshButton.disabled).toBe(true);
      expect(modal.authoring.disabled).toBe(true);
      second = modal.quickSubmit();
    } finally {
      release({ ok: true, json: async () => ({ ...manifest, blockers: ['Publication blocked by host'] }) });
      await Promise.allSettled([first, second]);
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(modal.quickSubmitButton.disabled).toBe(false);
    expect(modal.quickSubmitButton.textContent).toBe(actionLabel);
    expect(modal.finalSection.textContent).toContain('Publication blocked by host');
  });

  it('acknowledges a submitted review and retires its draft before a delayed comment refresh finishes', async () => {
    let release, started;
    const refresh = new Promise(resolve => { release = resolve; });
    const refreshStarted = new Promise(resolve => { started = resolve; });
    window.prManager.loadUserComments = () => { started(); return refresh; };
    window.prManager.updateCommentCount = () => {};
    const receipt = {
      id: 'attempt-1', reviewId: 1, state: 'submitted', phase: 'settled', error: null,
      updatedAt: manifest.fetchedAt, items: [],
      manifest: { ...manifest, comments: manifest.drafts }
    };
    fetch.mockImplementation(async (_url, options) => {
      if (options.method !== 'POST') throw new Error('Unexpected post-submission preflight');
      return { ok: true, json: async () => ({ receipt }) };
    });
    modal.manifest = manifest;
    modal.renderFinal(manifest);
    modal.confirm.checked = true;
    const publication = modal.publish();
    try {
      await refreshStarted;
      expect(modal.isSubmitting).toBe(false);
      expect(modal.note.textContent).toContain('Remote submission recorded');
      expect(modal.error.textContent).toBe('');
      expect(drafts.entries.has('draft-10')).toBe(false);
      expect(modal.quickSubmitButton.dataset.loading).toBeUndefined();
    } finally {
      modal.modal.open = false;
      release();
      await publication;
    }
  });

  it('keeps acknowledged cleanup failures from authorizing another approval until local cleanup settles', async () => {
    const receipt = {
      id: 'attempt-1', reviewId: 1, state: 'submitted', phase: 'settled',
      error: 'Review submitted successfully, but local draft cleanup failed: storage unavailable',
      updatedAt: manifest.fetchedAt, items: [],
      manifest: { ...manifest, comments: manifest.drafts }
    };
    modal.renderReceipts([receipt]);
    expect(modal.quickSubmitButton.disabled).toBe(true);
    expect(drafts.entries.has('draft-10')).toBe(true);
    await modal.quickSubmit();
    expect(fetch).not.toHaveBeenCalled();

    modal.renderReceipts([{ ...receipt, error: null }]);
    expect(modal.quickSubmitButton.disabled).toBe(false);
    expect(drafts.entries.has('draft-10')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
