// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
(() => {
  'use strict';
  const element = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text != null) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const metadata = comment => {
    if (!comment) return null;
    const { id, draft_key, revision, included, file, line_start, line_end, side, diff_position, commit_sha, parent_id, is_file_level, status, deleted_at, event } = comment;
    return { id, draft_key, revision, included, file, line_start, line_end, side, diff_position, commit_sha, parent_id, is_file_level, status, deleted_at, event };
  };

  class ReviewDraftStore {
    constructor() {
      this.entries = new Map();
      this.ready = new Promise(resolve => { this.connected = resolve; });
      this.button = element('button', 'Draft recovery', 'workspace-draft-recovery');
      this.button.type = 'button';
      this.button.hidden = true;
      this.button.addEventListener('click', () => this.showRecovery());
      document.body.append(this.button);
      window.addEventListener('beforeunload', event => {
        if (!this.allowLeave && [...this.entries.values()].some(entry => this.dirty(entry))) {
          event.preventDefault();
          event.returnValue = '';
        }
      });
      window.addEventListener('pagehide', () => { this.flushAll().catch(() => {}); });
      window.addEventListener('online', () => {
        for (const entry of this.entries.values()) if (!entry.conflict && !entry.paused) this.schedule(entry);
      });
      document.addEventListener('click', async event => {
        const link = event.target.closest?.('a[href]');
        if (!link || link.target || link.download || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = new URL(link.href, location.href);
        if (target.origin !== location.origin || target.pathname === location.pathname && target.search === location.search) return;
        if (![...this.entries.values()].some(entry => this.dirty(entry))) return;
        event.preventDefault();
        try { await this.flushAll(); location.assign(target.href); }
        catch { this.showRecovery(target.pathname + target.search); }
      });
    }

    connect(identity) {
      if (!identity?.dbId) return;
      if (this.identity) {
        if (identity.dbId !== this.identity.dbId || identity.instanceId !== this.identity.instanceId) {
          this.serverChanged = true;
          for (const entry of this.entries.values()) this.render(entry);
        }
        return;
      }
      this.identity = { dbId: identity.dbId, instanceId: identity.instanceId };
      this.prefix = `pair-review:draft:${identity.dbId}:`;
      try {
        for (let index = 0; index < sessionStorage.length; index++) {
          const key = sessionStorage.key(index);
          if (!key.startsWith(this.prefix)) continue;
          try {
            const saved = JSON.parse(sessionStorage.getItem(key));
            if (!Number.isInteger(saved.reviewId) || typeof saved.key !== 'string' || typeof saved.body !== 'string') continue;
            const url = new URL(saved.url, location.origin);
            if (url.origin !== location.origin || !/^\/(pr|local)\//.test(url.pathname)) continue;
            const entry = { ...saved, views: new Set(), paused: true, state: 'Recovered unsaved changes', open: false };
            this.entries.set(entry.key, entry);
          } catch { /* Leave unreadable recovery data intact for explicit recovery. */ }
        }
      } catch { this.storageUnavailable = true; }
      this.connected();
      this.renderButton();
    }

    dirty(entry) {
      if (entry.mode === 'summary') return !entry.base || entry.body !== entry.base.body || entry.event !== entry.base.event;
      return !entry.base ? entry.body !== '' : entry.body !== entry.base.body || entry.included !== Boolean(entry.base.included);
    }

    // A comment draft with no text is optional: it is excluded from the
    // submission and is never an error the author must resolve.
    isEmpty(entry) {
      return entry.mode !== 'summary' && !(entry.body || '').trim();
    }

    hasPending(reviewId) {
      return [...this.entries.values()].some(entry => entry.reviewId === reviewId && (this.dirty(entry) || entry.saving || entry.conflict));
    }

    bindSummary(textarea, summary) {
      this.bind(textarea, { mode: 'summary', comment: { ...summary, draft_key: `summary:${summary.id}`, included: true } });
      return textarea.draftReady;
    }

    async setDecision(textarea, event) {
      const entry = textarea.draftEntry || await textarea.draftReady;
      if (!entry || entry.mode !== 'summary') throw new Error('Review body is not loaded');
      entry.event = event;
      entry.paused = false;
      this.preserve(entry);
      this.schedule(entry);
    }

    bind(textarea, options) {
      textarea.draftReady = this.attach(textarea, options).catch(error => {
        const status = element('p', `Draft could not be opened: ${error.message}`, 'review-draft-status');
        status.setAttribute('role', 'alert');
        textarea.after(status);
        return null;
      });
    }

    async attach(textarea, { comment = null, anchor = {}, included = true, mode = 'new', parentId = null } = {}) {
      if (textarea.draftEntry) return textarea.draftEntry;
      textarea.readOnly = true;
      await this.ready;
      const reviewId = window.prManager?.currentPR?.id;
      if (!reviewId) throw new Error('Review identity is unavailable');
      if (comment && (!comment.draft_key || !Number.isInteger(comment.revision))) {
        comment = await this.request({ reviewId }, `comments/${comment.id}`, { method: 'GET' });
      }
      const anchorKey = JSON.stringify([reviewId, anchor.file, anchor.line_start || null, anchor.line_end || null, anchor.side || null, parentId]);
      let entry = comment && this.entries.get(comment.draft_key);
      if (!entry && !comment) entry = [...this.entries.values()].find(candidate => candidate.anchorKey === anchorKey && candidate.open);
      if (!entry) {
        const key = comment?.draft_key || crypto.randomUUID();
        entry = {
          key, reviewId, url: location.pathname + location.search, base: comment,
          body: comment?.body ?? textarea.value, included: comment ? Boolean(comment.included) : included,
          anchor: { ...anchor, parent_id: parentId ? Number(parentId) : anchor.parent_id, commit_sha: anchor.commit_sha || window.prManager.currentPR.head_sha || window.prManager.currentPR.local_head_sha },
          anchorKey, mode, views: new Set(), state: comment ? 'Saved locally' : 'Unsaved changes',
          event: comment?.event
        };
        this.entries.set(key, entry);
      }
      entry.open = true;
      textarea.value = entry.body;
      textarea.draftEntry = entry;
      textarea.dataset.draftKey = entry.key;
      textarea.readOnly = false;
      const status = element('span', '', 'review-draft-status');
      status.setAttribute('role', 'status');
      const resolve = element('button', 'Resolve draft', 'review-draft-resolve');
      resolve.type = 'button';
      resolve.addEventListener('click', () => this.showRecovery());
      const controls = element('div', null, 'review-draft-state');
      controls.append(status, resolve);
      textarea.after(controls);
      for (const view of entry.views) if (!view.textarea.isConnected) entry.views.delete(view);
      entry.views.add({ textarea, status, resolve });
      const input = () => {
        entry.body = textarea.value;
        for (const view of entry.views) if (view.textarea !== textarea) view.textarea.value = entry.body;
        entry.paused = false;
        this.preserve(entry);
        this.schedule(entry);
      };
      textarea.addEventListener('input', input);
      textarea.addEventListener('compositionstart', () => { entry.composing = true; clearTimeout(entry.timer); });
      textarea.addEventListener('compositionend', () => { entry.composing = false; input(); });
      textarea.addEventListener('focus', () => { this.focused = textarea; });
      if (this.dirty(entry)) {
        this.preserve(entry);
        if (!entry.paused) this.schedule(entry);
      }
      this.render(entry);
      return entry;
    }

    preserve(entry) {
      try {
        const key = `${this.prefix}${entry.reviewId}:${entry.key}`;
        if (!this.dirty(entry)) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify({
          key: entry.key, reviewId: entry.reviewId, url: entry.url, base: metadata(entry.base),
          body: entry.body, included: entry.included, event: entry.event, anchor: entry.anchor, anchorKey: entry.anchorKey, mode: entry.mode
        }));
        entry.recoveryFailed = false;
      } catch { entry.recoveryFailed = true; }
      this.render(entry);
      window.dispatchEvent(new CustomEvent('reviewDraftChanged', { detail: { reviewId: entry.reviewId } }));
    }

    schedule(entry) {
      clearTimeout(entry.timer);
      if (!this.dirty(entry) || entry.conflict || entry.composing || entry.paused) return;
      entry.state = 'Unsaved changes';
      this.render(entry);
      entry.timer = setTimeout(() => this.flush(entry).catch(() => {}), 500);
    }

    async request(entry, path, options) {
      const response = await fetch(`/api/reviews/${entry.reviewId}/${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': window.prManager?._clientId || '' }
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || `Save failed (${response.status})`), { current: data.current, status: response.status });
      return data;
    }

    async flush(entry) {
      clearTimeout(entry.timer);
      if (entry.saving) { await entry.saving; if (this.dirty(entry)) return this.flush(entry); return entry.base; }
      if (!this.dirty(entry)) return entry.base;
      if (this.serverChanged) throw new Error('Server instance changed. Reload before saving; your recovery text is retained.');
      if (entry.paused) throw new Error('Review recovered text before saving it');
      if (entry.conflict) throw new Error('Resolve this draft conflict before saving');
      if (this.isEmpty(entry)) {
        // Normalize the saved body only; never rewrite a textarea the author
        // may still be typing whitespace into.
        entry.body = '';
        entry.included = false;
        if (!entry.base) {
          entry.state = 'Empty — optional; nothing to save'; // taste-skill-ignore
          this.preserve(entry);
          return null;
        }
        if (!this.dirty(entry)) {
          entry.state = 'Empty — excluded; won’t be submitted'; // taste-skill-ignore
          this.preserve(entry);
          return entry.base;
        }
      }
      const body = entry.body;
      const included = entry.included;
      const event = entry.event;
      entry.state = 'Saving';
      entry.saving = (async () => {
        try {
          const summary = entry.mode === 'summary';
          const data = await this.request(entry, summary ? 'draft' : entry.base ? `comments/${entry.base.id}` : 'comments', {
            method: summary || entry.base ? 'PUT' : 'POST',
            body: JSON.stringify(summary ? { body, event, expected_revision: entry.base.revision } : entry.base
              ? { body, included, expected_revision: entry.base.revision, draft_key: entry.key }
              : { ...entry.anchor, body, included, draft_key: entry.key })
          });
          entry.base = summary ? { ...data, draft_key: entry.key, included: true } : data.comment;
          entry.paused = false;
          entry.state = this.dirty(entry) ? 'Unsaved changes' : this.isEmpty(entry) ? 'Empty — excluded; won’t be submitted' : 'Saved locally'; // taste-skill-ignore
          this.preserve(entry);
          window.dispatchEvent(new CustomEvent('reviewDraftSaved', { detail: { reviewId: entry.reviewId, comment: entry.mode === 'summary' ? null : entry.base, summary: entry.mode === 'summary' ? entry.base : null } }));
          return entry.base;
        } catch (error) {
          entry.conflict = error.status === 409 ? error.current || {} : null;
          if (entry.conflict && entry.mode === 'summary') entry.conflict = { ...entry.conflict, draft_key: entry.key, included: true };
          entry.state = entry.conflict ? 'Conflict: both versions retained' : `Save failed: ${error.message}`;
          this.preserve(entry);
          throw error;
        } finally {
          entry.saving = null;
          this.render(entry);
        }
      })();
      this.render(entry);
      const result = await entry.saving;
      if (this.dirty(entry)) return this.flush(entry);
      return result;
    }

    async saveTextarea(textarea) {
      const entry = textarea.draftEntry || await textarea.draftReady;
      if (!entry) throw new Error('Draft identity is not loaded');
      entry.body = textarea.value;
      entry.paused = false;
      this.preserve(entry);
      return this.flush(entry);
    }

    async flushAll(reviewId) {
      await Promise.all([...this.entries.values()].filter(entry => (reviewId === undefined || entry.reviewId === reviewId) && (this.dirty(entry) || entry.saving)).map(entry => this.flush(entry)));
    }

    close(textarea) {
      const entry = textarea?.draftEntry;
      if (!entry) return;
      entry.open = [...entry.views].some(view => view.textarea !== textarea && view.textarea.isConnected && !view.textarea.closest('dialog:not([open])'));
      const changed = this.dirty(entry);
      this.preserve(entry);
      if (!entry.paused) this.flush(entry).then(() => {
        if (changed && entry.mode !== 'summary') {
          clearTimeout(this.refreshTimer);
          this.refreshTimer = setTimeout(() => window.prManager?.loadUserComments(), 0);
        }
      }).catch(() => {});
    }

    settleSubmission(receipt) {
      if (receipt?.state !== 'submitted') return;
      for (const draft of receipt.manifest?.comments || []) {
        const entry = this.entries.get(draft.key);
        if (!entry || entry.reviewId !== receipt.reviewId || entry.saving || this.dirty(entry) ||
            entry.body !== draft.body || (entry.base?.revision !== draft.revision && entry.base?.status !== 'submitted')) continue;
        clearTimeout(entry.timer);
        entry.open = false;
        this.entries.delete(entry.key);
      }
      this.renderButton();
    }

    async setIncluded(comment, included) {
      await this.ready;
      let entry = this.entries.get(comment.draft_key);
      if (!entry) {
        entry = { key: comment.draft_key, reviewId: comment.review_id, url: location.pathname + location.search,
          base: comment, body: comment.body, included, anchor: metadata(comment), views: new Set(), mode: 'edit' };
        this.entries.set(entry.key, entry);
      }
      entry.included = included;
      this.preserve(entry);
      return this.flush(entry);
    }

    captureEditors() {
      const focused = document.activeElement;
      this.editorFocus = focused?.draftEntry ? { key: focused.dataset.draftKey, start: focused.selectionStart, end: focused.selectionEnd } : null;
    }

    async restoreEditors() {
      const manager = window.prManager;
      for (const entry of this.entries.values()) {
        if (entry.mode === 'summary' || !entry.open || !entry.base || entry.reviewId !== manager?.currentPR?.id || [...entry.views].some(view => view.textarea.isConnected)) continue;
        const comment = manager.userComments.find(candidate => candidate.draft_key === entry.key);
        if (!comment) continue;
        if (comment.is_file_level) {
          const zone = manager.fileCommentManager.findZoneForFile(comment.file);
          if (zone) manager.fileCommentManager.editFileComment(zone, comment, { focus: false });
        } else await manager.editUserComment(comment.id, { focus: false });
      }
      if (this.editorFocus) {
        const entry = this.entries.get(this.editorFocus.key);
        const textarea = [...(entry?.views || [])].find(view => view.textarea.isConnected)?.textarea;
        if (textarea) { textarea.focus({ preventScroll: true }); textarea.setSelectionRange(this.editorFocus.start, this.editorFocus.end); }
      }
      this.renderButton();
    }

    ingest(comments) {
      for (const comment of comments) {
        const entry = this.entries.get(comment.draft_key);
        if (!entry?.base || entry.saving || comment.revision <= entry.base.revision) continue;
        if (this.dirty(entry)) {
          entry.conflict = comment;
          entry.state = 'Conflict: both versions retained';
        } else {
          entry.base = comment;
          entry.body = comment.body;
          entry.included = Boolean(comment.included);
          entry.event = comment.event ?? entry.event;
          for (const view of entry.views) view.textarea.value = entry.body;
        }
        this.render(entry);
      }
    }

    preservedComment(comment) {
      const entry = this.entries.get(comment.draft_key);
      if (!entry?.open) return null;
      for (const view of entry.views) {
        const row = view.textarea.closest('.user-comment-row');
        if (row && row.dataset.file === comment.file && Number(row.dataset.lineStart) === comment.line_start) return row;
      }
      return null;
    }

    render(entry) {
      for (const view of entry.views) {
        // Quiet when settled: a saved, included draft needs no status line,
        // and a saved empty draft is already labelled by its card badge.
        // Anything the author must act on (unsaved, excluded, failed) still
        // speaks.
        const settled = !this.serverChanged && !entry.conflict && !entry.recoveryFailed && (
          (entry.state === 'Saved locally' && (entry.mode === 'summary' || entry.included)) ||
          (this.isEmpty(entry) && entry.state?.startsWith('Empty')));
        view.status.textContent = settled ? ''
          : this.serverChanged ? 'Server changed: reload to save; recovery text retained'
          : `${entry.state || 'Unsaved changes'}${entry.mode !== 'summary' && entry.base && !entry.included && !this.isEmpty(entry) ? ' · excluded' : ''}${entry.recoveryFailed ? ' · browser recovery unavailable; keep this page open' : ''}`;
        view.status.dataset.state = entry.conflict || entry.state?.startsWith('Save failed') ? 'error' : this.isEmpty(entry) ? 'empty' : 'ok';
        view.resolve.hidden = !entry.conflict && !entry.state?.startsWith('Save failed');
      }
      if (entry.recoveryStatus?.isConnected) entry.recoveryStatus.textContent = entry.state;
      if (entry.recoverySave?.isConnected) entry.recoverySave.textContent = entry.conflict ? 'Compare conflicting versions' : 'Save recoverable text';
      this.renderButton();
    }

    recoveryEntries() {
      return [...this.entries.values()].filter(entry => this.dirty(entry) || entry.open && ![...entry.views].some(view => view.textarea.isConnected));
    }

    renderButton() {
      const count = this.recoveryEntries().length;
      this.button.hidden = count === 0;
      this.button.textContent = `Draft recovery (${count})`;
    }

    showRecovery(destination) {
      const workspace = window.reviewWorkspace;
      if (!workspace) return;
      if (!this.dialog) this.dialog = workspace.makeDialog('workspace-draft-recovery', 'Draft recovery');
      this.dialog.querySelector('.workspace-draft-recovery-body')?.remove();
      const content = element('div', null, 'workspace-draft-recovery-body');
      content.append(element('p', 'Only unacknowledged text is kept in this tab’s session storage, scoped to this database and review. It is cleared after acknowledgement or explicit discard. Closing the tab removes this recovery buffer. Saved drafts remain on the server.'));
      for (const entry of this.recoveryEntries()) {
        const card = element('section', null, 'workspace-run');
        entry.recoveryStatus = element('p', entry.state);
        entry.recoverySave = null;
        card.append(element('h3', entry.anchor?.file || entry.base?.file || 'Review draft'), entry.recoveryStatus);
        if (entry.mode === 'summary') card.append(element('p', `Review decision: ${entry.event}`));
        const mine = element('textarea');
        mine.value = entry.body;
        mine.setAttribute('aria-label', 'Your recoverable text');
        mine.addEventListener('input', () => { entry.body = mine.value; this.preserve(entry); });
        card.append(mine);
        const action = (label, callback) => {
          const button = element('button', label);
          button.type = 'button';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try { await callback(); this.showRecovery(destination); }
            catch (error) {
              this.showRecovery(destination);
              this.dialog.querySelector('.workspace-draft-recovery-body').prepend(element('p', error.message));
            }
          });
          card.append(button);
          return button;
        };
        const conflict = entry.conflict;
        if (conflict) {
          card.append(element('h4', 'Current server version'), element('pre', conflict.body || '(Draft removed or unavailable)'));
          if (entry.mode === 'summary') card.append(element('p', `Server decision: ${conflict.event}`));
          if (conflict.draft_key === entry.key && !conflict.deleted_at && conflict.status !== 'submitted') {
            action(`Save my text against revision ${conflict.revision}`, async () => {
              entry.base = conflict;
              entry.conflict = null;
              entry.paused = false;
              await this.flush(entry);
            });
          }
          action('Use the server version; discard my local edits', () => {
            entry.base = conflict;
            entry.body = entry.base.body || '';
            entry.included = Boolean(entry.base.included);
            entry.event = entry.base.event ?? entry.event;
            entry.conflict = null;
            entry.state = 'Saved locally';
            for (const view of entry.views) view.textarea.value = entry.body;
            this.preserve(entry);
          });
        } else {
          entry.recoverySave = action('Save recoverable text', async () => {
            if (entry.conflict) return;
            entry.paused = false;
            await this.flush(entry);
          });
        }
        if (entry.mode !== 'summary') action('Save as a separate excluded draft', async () => {
          const copy = { key: crypto.randomUUID(), reviewId: entry.reviewId, url: entry.url, body: entry.body,
            base: null, anchor: { ...entry.anchor, ...(metadata(entry.base) || {}) }, mode: entry.mode,
            included: false, conflict: null, paused: false, views: new Set(), open: false };
          this.entries.set(copy.key, copy);
          this.preserve(copy);
          await this.flush(copy);
          sessionStorage.removeItem(`${this.prefix}${entry.reviewId}:${entry.key}`);
          this.entries.delete(entry.key);
          for (const view of entry.views) {
            view.textarea.readOnly = true;
            view.status.textContent = 'Saved as a separate excluded draft';
          }
          await window.prManager?.loadUserComments();
        });
        if (entry.url !== location.pathname + location.search) {
          const link = element('a', 'Open this review');
          link.href = entry.url;
          card.append(link);
        }
        content.append(card);
      }
      if (destination) {
        const leave = element('button', 'Continue navigation with recovery text retained in this tab');
        leave.type = 'button';
        leave.addEventListener('click', () => { this.allowLeave = true; location.assign(destination); });
        content.append(leave);
      }
      if (!this.recoveryEntries().length) content.append(element('p', 'All edits acknowledged by the server.'));
      this.dialog.append(content);
      workspace.open(this.dialog);
    }
  }
  window.reviewDrafts = new ReviewDraftStore();
})();
