// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/** Local authoring and one server-bound final preview. Opening never publishes. */
class ReviewModal {
  constructor() {
    this.generation = 0;
    this.version = 0;
    this.isSubmitting = false;
    this.isQuickSubmitting = false;
    this.isPreparing = false;
    this.cleanupPending = false;
    this.manifest = null;
    window.addEventListener('reviewDraftChanged', event => {
      if (event.detail.reviewId === this.reviewId) this.invalidate('Draft changed. Prepare a new final preview.');
    });
    window.addEventListener('reviewDraftSaved', event => {
      const { reviewId, comment } = event.detail;
      if (reviewId !== this.reviewId || !comment) return;
      const view = this.cards?.get(comment.draft_key);
      if (view) view.provenance.textContent = `Draft ${comment.id} · revision ${comment.revision}`;
    });
    document.addEventListener('review:comments_changed', event => {
      if (event.detail?.reviewId === this.reviewId && event.detail.sourceClientId !== window.prManager?._clientId) this.invalidate('Review state changed. Refresh saved drafts before another preview.');
    });
  }

  get isVisible() { return Boolean(this.modal?.open); }

  static get isMac() { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || ''); }
  static get modLabel() { return ReviewModal.isMac ? '⌘' : 'Ctrl'; }
  static get altLabel() { return ReviewModal.isMac ? '⌥' : 'Alt'; }

  onKeyDown(event) {
    if (event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) {
        if (this.prepareButton && !this.prepareButton.disabled) this.prepareButton.click();
      } else if (this.publishButton && !this.publishButton.disabled && this.confirm?.checked) {
        // Deliberate invariant: an armed exact final preview publishes only
        // via its Publish button, never via a global submit chord. Move
        // focus to that button so the final action stays explicit.
        this.publishButton.focus();
      } else if (this.quickSubmitButton && !this.quickSubmitButton.disabled) {
        this.quickSubmitButton.click();
      }
      return;
    }
    if (mod && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      window.reviewDrafts.flushAll(this.reviewId)
        .then(() => { if (this.note && this.modal?.open) this.note.textContent = 'All drafts saved locally. Nothing has been published.'; })
        .catch(error => this.showError(error));
      return;
    }
    if (event.altKey && !mod && /^Digit[1-3]$/.test(event.code || '')) {
      const value = { Digit1: 'APPROVE', Digit2: 'COMMENT', Digit3: 'REQUEST_CHANGES' }[event.code];
      const option = this.decision?.querySelector(`option[value="${value}"]`);
      if (this.decision && option && !option.disabled) {
        event.preventDefault();
        this.decision.value = value;
        this.decision.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    if (event.altKey && !mod && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const editors = [this.bodyInput, ...(this.cards ? [...this.cards.values()].map(view => view.textarea) : [])].filter(Boolean);
      if (editors.length < 2) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const current = editors.indexOf(document.activeElement);
      const next = editors[(current + delta + editors.length) % editors.length];
      event.preventDefault();
      next.scrollIntoView({ behavior: 'instant', block: 'center' });
      next.focus({ preventScroll: true });
      next.setSelectionRange(next.value.length, next.value.length);
    }
  }

  selectedCount() {
    if (!this.cards) return 0;
    let count = 0;
    for (const view of this.cards.values()) {
      if (view.include.checked && view.textarea.value.trim()) count++;
    }
    return count;
  }

  updateCount() {
    if (!this.count || !this.cards) return;
    let empty = 0;
    for (const view of this.cards.values()) if (!view.textarea.value.trim()) empty++;
    const selected = this.selectedCount();
    this.count.textContent = `${selected} selected saved comment${selected === 1 ? '' : 's'}${empty ? ` · ${empty} empty (skipped)` : ''}`; // taste-skill-ignore
    this.updateSummaryHint?.();
  }

  refreshDraftCard(view) {
    const empty = !view.textarea.value.trim();
    view.card.dataset.empty = String(empty);
    if (view.emptyBadge) view.emptyBadge.hidden = !empty;
    view.include.disabled = empty;
    if (empty) view.include.checked = false;
    this.updateCount();
  }

  static node(tag, text, attributes = {}) {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = text;
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  static link(label, url) {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) return document.createTextNode(label);
      return ReviewModal.node('a', label, { href: parsed.href, target: '_blank', rel: 'noopener noreferrer' });
    } catch { return document.createTextNode(label); }
  }

  async request(path, options = {}) {
    const response = await fetch(`/api/reviews/${this.reviewId}/${path}`, {
      ...options, headers: { 'Content-Type': 'application/json', ...options.headers }
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), data);
    return data;
  }

  button(label, action, loadingLabel = null) {
    const button = ReviewModal.node('button', label, { type: 'button' });
    button.addEventListener('click', async () => {
      const previousText = button.textContent;
      button.disabled = true;
      button.dataset.loading = 'true';
      button.setAttribute('aria-busy', 'true');
      if (loadingLabel) button.textContent = typeof loadingLabel === 'function' ? loadingLabel() : loadingLabel;
      try { await action(); } catch (error) { this.showError(error); }
      finally {
        button.disabled = this.isSubmitting || this.isQuickSubmitting || this.isPreparing ||
          (button === this.quickSubmitButton && this.cleanupPending);
        delete button.dataset.loading;
        button.removeAttribute('aria-busy');
        if (loadingLabel && button.isConnected) button.textContent = previousText;
      }
    });
    return button;
  }

  appendAISummary() {
    const summary = window.aiPanel?.getSummary();
    if (!summary) throw new Error('No AI summary is available for this review.');
    this.bodyInput.value = this.bodyInput.value ? `${this.bodyInput.value}\n\n${summary}` : summary;
    this.bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
    this.bodyInput.focus();
  }

  async show() {
    if (this.isSubmitting || this.isQuickSubmitting || this.isPreparing) { window.reviewWorkspace.open(this.modal); return; }
    if (this.isVisible) return;
    this.reviewId = window.prManager.currentPR.id;
    this.capabilities = null;
    if (!this.modal) {
      this.modal = window.reviewWorkspace.makeDialog('review-modal', 'Submit review');
      this.modal.classList.add('workspace-review');
      this.content = ReviewModal.node('div', null, { class: 'workspace-review-content' });
      this.modal.append(this.content);
      this.modal.addEventListener('keydown', event => this.onKeyDown(event));
      this.modal.addEventListener('cancel', event => {
        if (this.isSubmitting || this.isQuickSubmitting) event.preventDefault();
      });
      this.modal.addEventListener('close', () => {
        this.generation++;
        for (const textarea of this.modal.querySelectorAll('textarea[data-draft-key]')) window.reviewDrafts.close(textarea);
      });
    }
    this.content.replaceChildren();
    this.manifest = null;
    this.note = ReviewModal.node('p', 'Loading saved local drafts…', { role: 'status', class: 'workspace-review-note' });
    this.error = ReviewModal.node('p', '', { role: 'alert', class: 'workspace-review-error' });
    this.content.append(this.note, this.error);
    window.reviewWorkspace.open(this.modal);
    this.focusOnLoad = true;
    await this.load();
  }

  async load({ capabilities, submitted } = {}) {
    const generation = ++this.generation;
    const version = this.version;
    try {
      const [summary, comments, manifest, receipts] = await Promise.all([
        this.request('draft'), this.request('comments'), this.request('manifest?local=true'), this.request('submissions')
      ]);
      if (generation !== this.generation || !this.modal.open) return;
      if (submitted && (version !== this.version || window.reviewDrafts.hasPending(this.reviewId))) return;
      this.savedSummary = summary;
      this.localManifest = manifest;
      this.comments = new Map(comments.comments.map(comment => [comment.id, comment]));
      window.reviewDrafts.ingest([...comments.comments, { ...summary, draft_key: `summary:${summary.id}`, included: true }]);
      await this.renderAuthoring(manifest);
      if (generation !== this.generation || !this.modal.open) return;
      this.renderReceipts(receipts.receipts);
      this.note.textContent = submitted
        ? submitted.error || 'Remote submission recorded. Your exact submitted text remains in the receipt.'
        : 'Saved locally. No host write occurs until you confirm an exact, fresh preview.';
      if (submitted) this.note.dataset.state = submitted.error ? 'warning' : 'success';
      try {
        capabilities ||= await this.request('manifest');
        if (generation === this.generation && this.modal.open) this.applyCapabilities(capabilities);
      } catch (error) {
        if (generation === this.generation) this.capabilityStatus.textContent = `Host identity unavailable: ${error.message}. Local authoring remains available.`;
      }
    } catch (error) {
      if (generation === this.generation) {
        if (submitted) error = new Error(`Review already submitted; local view could not refresh. Reload saved drafts, not the approval. ${error.message}`);
        this.showError(error);
      }
    }
  }

  async renderAuthoring(manifest) {
    this.authoring?.remove();
    this.finalSection?.remove();
    this.actions?.remove();
    this.receiptsSection?.remove();
    const node = ReviewModal.node;
    this.authoring = node('fieldset', null, { class: 'workspace-review-authoring' });
    this.authoring.disabled = this.isSubmitting || this.isQuickSubmitting;
    this.authoring.append(node('legend', 'Your review', { class: 'workspace-sr-only' }));
    const decisions = node('label', 'Decision ', { for: 'review-decision', class: 'workspace-sr-only' });
    this.decision = node('select', null, { id: 'review-decision', name: 'review-decision' });
    for (const [value, text] of [['COMMENT', 'Comment only'], ['APPROVE', 'Approve'], ['APPROVE_WITH_COMMENT', 'Approve with comment'], ['REQUEST_CHANGES', 'Request changes']]) {
      const option = node('option', text, { value });
      option.disabled = false;
      this.decision.append(option);
    }
    decisions.append(this.decision);
    this.decisionCards = node('div', null, { class: 'workspace-decision-cards', role: 'group', 'aria-label': 'Review decision' });
    this.decisionCardButtons = new Map();
    for (const [index, [value, titleText, descText]] of [
      ['APPROVE', 'Approve', 'Approve merging'],
      ['COMMENT', 'Comment', 'Feedback, no approval'],
      ['REQUEST_CHANGES', 'Request changes', 'Must fix before merge']
    ].entries()) {
      const cardBtn = node('button', null, { type: 'button', class: 'workspace-decision-card', 'data-decision': value, 'aria-pressed': 'false', 'aria-keyshortcuts': `Alt+${index + 1}`, title: `${titleText} (${ReviewModal.altLabel}${index + 1})` });
      cardBtn.append(node('strong', titleText), node('span', descText), node('kbd', `${ReviewModal.altLabel}${index + 1}`, { class: 'workspace-kbd workspace-kbd-hint workspace-decision-kbd', 'aria-hidden': 'true' }));
      cardBtn.addEventListener('click', () => {
        if (cardBtn.disabled) return;
        this.decision.value = value;
        this.decision.dispatchEvent(new Event('change', { bubbles: true }));
      });
      this.decisionCards.append(cardBtn);
      this.decisionCardButtons.set(value, cardBtn);
    }
    this.decisionCards.addEventListener('keydown', event => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
      const enabled = [...this.decisionCardButtons.entries()].filter(([, btn]) => !btn.disabled);
      if (enabled.length < 2) return;
      const currentKey = this.decision.value === 'APPROVE_WITH_COMMENT' ? 'APPROVE' : this.decision.value;
      const idx = Math.max(0, enabled.findIndex(([val]) => val === currentKey));
      const delta = (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1 : -1;
      const [nextVal, nextBtn] = enabled[(idx + delta + enabled.length) % enabled.length];
      event.preventDefault();
      nextBtn.focus();
      this.decision.value = nextVal;
      this.decision.dispatchEvent(new Event('change', { bubbles: true }));
    });
    this.syncDecisionCards = () => {
      const current = this.decision.value === 'APPROVE_WITH_COMMENT' ? 'APPROVE' : this.decision.value;
      for (const [val, btn] of this.decisionCardButtons.entries()) {
        const isActive = val === current;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
        const opt = this.decision.querySelector(`option[value="${val}"]`);
        btn.disabled = Boolean(opt?.disabled);
      }
      if (this.quickSubmitButton) {
        const action = { APPROVE: 'approval', COMMENT: 'comment review', REQUEST_CHANGES: 'change request' }[current] || 'review';
        const preparing = this.isQuickSubmitting || this.isPreparing;
        this.quickSubmitButton.disabled = this.isSubmitting || preparing || this.cleanupPending;
        this.setQuickLabel?.(this.cleanupPending ? 'Review submitted' : this.isSubmitting ? 'Publishing review\u2026' : preparing ? `Preparing ${action}\u2026` : `Submit ${action}`, !this.cleanupPending && !this.isSubmitting && !preparing);
        if (this.isSubmitting || preparing) {
          this.quickSubmitButton.dataset.loading = 'true';
          this.quickSubmitButton.setAttribute('aria-busy', 'true');
        } else {
          delete this.quickSubmitButton.dataset.loading;
          this.quickSubmitButton.removeAttribute('aria-busy');
        }
        this.quickSubmitButton.dataset.decision = current;
      }
      this.updateSummaryHint?.();
    };
    this.updateSummaryHint = () => {
      if (!this.summaryHint) return;
      const current = this.decision.value === 'APPROVE_WITH_COMMENT' ? 'APPROVE' : this.decision.value;
      if (current === 'APPROVE') {
        this.summaryHint.textContent = 'Optional. An approval can be submitted with no summary and no comments.';
      } else if (this.selectedCount() > 0) {
        this.summaryHint.textContent = 'Optional. Your included comments publish with or without a summary.';
      } else {
        this.summaryHint.textContent = 'Add a summary or include a comment: this decision needs content to publish.';
      }
    };
    this.capabilityStatus = node('p', 'Checking host identity…', { class: 'workspace-muted' });
    this.authoring.append(this.decisionCards, decisions, this.capabilityStatus);
    const label = node('label', 'Review summary (optional)', { for: 'review-body-modal' });
    this.bodyInput = node('textarea', null, { id: 'review-body-modal', rows: '3', spellcheck: 'true', placeholder: 'Optional summary — leave blank to submit without one…' }); // taste-skill-ignore
    this.summaryHint = node('p', '', { class: 'workspace-muted workspace-review-hint' });
    this.authoring.append(label, this.bodyInput, this.summaryHint);
    const summaryReady = window.reviewDrafts.bindSummary(this.bodyInput, this.savedSummary);
    const appendAiButton = this.button('Append AI summary to review body', () => this.appendAISummary());
    appendAiButton.classList.add('workspace-btn-secondary', 'workspace-review-append-ai');
    this.authoring.append(appendAiButton);
    this.decision.addEventListener('change', async () => {
      this.syncDecisionCards();
      try {
        await window.reviewDrafts.setDecision(this.bodyInput, this.decision.value === 'APPROVE_WITH_COMMENT' ? 'APPROVE' : this.decision.value);
        if (this.decision.value === 'APPROVE_WITH_COMMENT') this.bodyInput.focus();
      } catch (error) { this.showError(error); }
    });
    if (manifest.reviewType === 'local') {
      const association = node('section', null, { class: 'workspace-review-association' });
      const input = node('input', null, { type: 'url', id: 'review-association', placeholder: 'https://host/owner/repo/pull/123' });
      input.value = manifest.association?.url || '';
      association.append(node('label', 'Associated PR URL (optional)', { for: 'review-association' }), input,
        node('p', 'Local-only drafts work without a host. Publication requires an explicitly associated PR and a clean, branch-inclusive checkout at its head.'));
      association.append(this.button('Save PR association', async () => {
        await window.reviewDrafts.flushAll(this.reviewId);
        const result = await this.request('association', { method: 'PUT', body: JSON.stringify({ url: input.value || null, expected_revision: this.bodyInput.draftEntry.base.revision }) });
        window.reviewDrafts.ingest([{ ...result.draft, draft_key: `summary:${this.reviewId}`, included: true }]);
        this.invalidate('Target changed. Prepare a new final preview.');
        await this.load();
      }));
      this.authoring.append(association);
    }
    this.count = node('h3', `${manifest.count} selected saved comments`);
    this.authoring.append(this.count);
    this.cards = new Map();
    const bindings = [summaryReady];
    for (const draft of manifest.drafts) {
      const comment = this.comments.get(draft.id);
      if (!comment) throw new Error(`Saved draft ${draft.id} is unavailable. Reload the preview.`);
      const card = node('article', null, { class: 'workspace-review-draft', 'data-draft-id': draft.id });
      const location = draft.wire.isFileLevel ? 'file' : `${draft.wire.side} ${draft.wire.start_line ? `${draft.wire.start_line}–` : ''}${draft.wire.line}`;
      const provenance = node('p', `Draft ${draft.id} · revision ${draft.revision}`, { class: 'workspace-review-provenance' });
      const emptyBadge = node('span', 'Empty — skipped', { class: 'workspace-review-empty-badge' }); // taste-skill-ignore
      emptyBadge.hidden = Boolean((draft.body || '').trim());
      emptyBadge.title = 'Empty comments are optional: this draft is excluded and will not be published.';
      const heading = node('h4', `${draft.wire.path} · ${location}`);
      heading.append(emptyBadge, provenance);
      card.append(heading);
      const includeLabel = node('label', 'Include in submission ');
      const include = node('input', null, { type: 'checkbox', 'aria-label': `Include draft ${draft.id} in submission` });
      include.checked = draft.included;
      includeLabel.prepend(include);
      const tools = node('div', null, { class: 'workspace-review-draft-tools' });
      tools.append(includeLabel);
      const textarea = node('textarea', null, { rows: '3', 'aria-label': `Draft ${draft.id} exact Markdown`, placeholder: 'Optional — leave empty to skip this comment' }); // taste-skill-ignore
      card.append(tools, textarea);
      const view = { card, textarea, include, emptyBadge, provenance };
      textarea.addEventListener('input', () => this.refreshDraftCard(view));
      this.authoring.append(card);
      window.reviewDrafts.bind(textarea, { comment, mode: comment.is_file_level ? 'file-edit' : 'edit' });
      bindings.push(textarea.draftReady.then(entry => {
        if (entry) include.checked = entry.included;
        this.refreshDraftCard(view);
      }));
      include.addEventListener('change', async () => {
        this.updateCount();
        try { await window.reviewDrafts.setIncluded(comment, include.checked); }
        catch (error) { this.showError(error); }
      });
      const anchorStatus = node('div', null, { class: 'workspace-review-anchor', role: 'status' });
      card.append(anchorStatus);
      const deletion = node('div');
      deletion.hidden = true;
      deletion.append(node('p', 'Delete this saved text, not the AI finding or a remote comment. Exclude it instead to keep the text.'));
      const cancelDeletion = this.button('Keep local draft', () => { deletion.hidden = true; });
      const confirmDeletion = this.button('Delete local draft', async () => {
        await window.reviewDrafts.flush(textarea.draftEntry);
        const current = textarea.draftEntry.base;
        await this.request(`comments/${current.id}/draft`, { method: 'DELETE', body: JSON.stringify({ draft_key: current.draft_key, expected_revision: current.revision }) });
        textarea.draftEntry.open = false;
        window.reviewDrafts.entries.delete(current.draft_key);
        this.invalidate('Draft deleted. Prepare a new final preview.');
        await window.prManager.loadUserComments();
        await this.load();
      });
      deletion.append(cancelDeletion, confirmDeletion);
      tools.append(this.button('Delete this local draft…', () => { deletion.hidden = false; cancelDeletion.focus(); }));
      card.append(deletion);
      view.anchorStatus = anchorStatus;
      this.cards.set(draft.key, view);
    }
    this.mode = node('select', null, { id: 'review-publication-mode' });
    this.mode.append(node('option', 'Publish completed review', { value: 'submit' }), node('option', 'Save pending review on host', { value: 'draft' }));
    const modeLabel = node('label', 'Host action ', { for: 'review-publication-mode' });
    modeLabel.append(this.mode);
    this.mode.addEventListener('change', () => this.invalidate('Host action changed. Prepare a new final preview.'));
    this.authoring.append(modeLabel);
    this.actions = node('div', null, { class: 'workspace-review-actions workspace-review-actions--sticky' });
    this.quickSubmitButton = this.button('Submit review', () => this.quickSubmit());
    this.quickSubmitButton.classList.add('btn', 'btn-primary', 'workspace-submit-primary');
    this.quickSubmitButton.setAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter');
    this.quickSubmitButton.title = `Submit review (${ReviewModal.modLabel}⏎)`;
    // One home for shortcut chips: inside the button they act on, hidden
    // until a modifier key is held (html.show-keyboard-hints).
    const kbdChip = text => node('kbd', text, { class: 'workspace-kbd workspace-kbd-hint', 'aria-hidden': 'true' });
    this.setQuickLabel = (text, withChip = true) => {
      const children = [document.createTextNode(text)];
      if (withChip) children.push(kbdChip(`${ReviewModal.modLabel}⏎`));
      this.quickSubmitButton.replaceChildren(...children);
    };
    this.setQuickLabel('Submit review');
    this.prepareButton = this.button('Prepare exact final preview', () => this.prepare());
    this.prepareButton.classList.add('workspace-btn-secondary');
    this.prepareButton.setAttribute('aria-keyshortcuts', 'Meta+Shift+Enter Control+Shift+Enter');
    this.prepareButton.title = `Preview without publishing (${ReviewModal.modLabel}⇧⏎)`;
    this.prepareButton.append(kbdChip(`${ReviewModal.modLabel}⇧⏎`));
    this.refreshButton = this.button('Reload saved drafts', async () => { await window.reviewDrafts.flushAll(this.reviewId); this.invalidate('Saved drafts reloaded.'); await this.load(); });
    this.refreshButton.classList.add('workspace-btn-secondary');
    const skipButton = this.button('Skip — keep drafts local', () => this.modal.close()); // taste-skill-ignore
    skipButton.classList.add('workspace-btn-secondary', 'workspace-btn-ghost');
    this.quickSubmitButton.disabled = this.isSubmitting || this.isQuickSubmitting;
    this.prepareButton.disabled = this.isSubmitting || this.isQuickSubmitting;
    this.refreshButton.disabled = this.isSubmitting || this.isQuickSubmitting;
    this.actions.append(this.quickSubmitButton, this.prepareButton, this.refreshButton, skipButton);
    this.finalSection = node('section', null, { class: 'workspace-review-final', 'aria-label': 'Final submission preview' });
    this.finalSection.hidden = true;
    this.receiptsSection = node('section', null, { class: 'workspace-review-receipts', 'aria-label': 'Durable publication receipts' });
    this.receiptsSection.hidden = true;
    this.content.append(this.authoring, this.actions, this.finalSection, this.receiptsSection);
    await Promise.all(bindings);
    const entry = this.bodyInput.draftEntry;
    if (!entry) throw new Error('Review body could not be loaded. Resolve recoverable text before publication.');
    this.decision.value = entry.event === 'APPROVE' && (entry.body || manifest.count) ? 'APPROVE_WITH_COMMENT' : entry.event;
    this.syncDecisionCards?.();
    this.invalidate();
    if (this.focusOnLoad) {
      this.focusOnLoad = false;
      this.bodyInput.focus({ preventScroll: true });
      this.bodyInput.setSelectionRange(this.bodyInput.value.length, this.bodyInput.value.length);
    }
  }

  applyCapabilities(manifest) {
    this.capabilities = manifest;
    for (const option of this.decision.options) {
      const event = option.value === 'APPROVE_WITH_COMMENT' ? 'APPROVE' : option.value;
      option.disabled = event !== 'COMMENT' && (!manifest.target || !manifest.allowedEvents.includes(event));
    }
    if (this.decision.selectedOptions[0]?.disabled) {
      this.decision.value = 'COMMENT';
    }
    this.syncDecisionCards?.();
    this.capabilityStatus.textContent = manifest.target
      ? `${manifest.target.repository} #${manifest.target.number} · ${manifest.target.account.login}${manifest.allowedEvents.length === 1 ? ' · own PR: comment-only review' : ''}`
      : 'Local-only authoring. Associate a PR before choosing a host approval or change request.';
    this.renderDraftAnchors(manifest);
  }

  invalidate(message) {
    this.version++;
    this.manifest = null;
    this.quickSubmitButton?.classList.remove('workspace-submit-superseded');
    if (this.confirm) { this.confirm.checked = false; this.confirm.disabled = true; }
    if (this.publishButton) this.publishButton.disabled = true;
    if (message && this.note && !this.isSubmitting) this.note.textContent = message;
    if (!this.isSubmitting) this.updateCount?.();
    const heading = this.finalSection?.querySelector('h3');
    if (heading) heading.textContent = 'Previous preview — confirmation cleared'; // taste-skill-ignore
  }

  showError(error) {
    this.error.textContent = error.message;
    if (error.receipt) {
      this.renderReceipts([error.receipt]);
      this.revealReceipt();
    } else if (this.modal?.open) {
      this.error.scrollIntoView({ behavior: 'instant', block: 'start' });
      this.error.tabIndex = -1;
      this.error.focus({ preventScroll: true });
    }
  }

  revealReceipt() {
    this.receiptsSection.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    this.receiptsSection.querySelector('button')?.focus({ preventScroll: true });
  }

  async prepare() {
    if (this.isPreparing || this.isSubmitting) return;
    this.isPreparing = true;
    this.quickSubmitButton.disabled = true;
    this.prepareButton.disabled = true;
    this.refreshButton.disabled = true;
    this.syncDecisionCards?.();
    this.error.textContent = '';
    this.invalidate();
    this.authoring.disabled = true;
    if (this.note) {
      this.note.dataset.state = 'loading';
      this.note.textContent = 'Checking host identity, diff anchors, and preparing submission manifest\u2026';
    }
    try {
      await window.reviewDrafts.flushAll(this.reviewId);
      if (window.reviewDrafts.hasPending(this.reviewId)) throw new Error('Resolve all unsaved or conflicting drafts before preparing publication.');
      const version = this.version;
      const generation = this.generation;
      const manifest = await this.request(`manifest?mode=${this.mode.value}`);
      if (version !== this.version || generation !== this.generation || !this.modal.open) throw new Error('The review changed while preflight loaded. Prepare a new preview.');
      this.manifest = manifest;
      this.renderFinal(manifest);
    } catch (error) {
      if (this.note) {
        delete this.note.dataset.state;
        this.note.textContent = 'Preflight did not complete. Local text is preserved — nothing was published.'; // taste-skill-ignore
      }
      throw error;
    } finally {
      this.isPreparing = false;
      this.authoring.disabled = this.isSubmitting || this.isQuickSubmitting;
      this.quickSubmitButton.disabled = this.isSubmitting || this.isQuickSubmitting;
      this.prepareButton.disabled = this.isSubmitting || this.isQuickSubmitting;
      this.refreshButton.disabled = this.isSubmitting || this.isQuickSubmitting;
      this.syncDecisionCards?.();
      if (this.note?.dataset.state === 'loading') delete this.note.dataset.state;
    }
  }

  renderDraftAnchors(manifest) {
    if (!manifest?.drafts || !this.cards) return;
    const node = ReviewModal.node;
    for (const draft of manifest.drafts) {
      const view = this.cards.get(draft.key);
      if (!view) continue;
      view.anchorStatus.replaceChildren();
      view.card.dataset.included = String(draft.included);
      for (const problem of draft.errors || []) view.anchorStatus.append(node('p', problem));
      if (draft.included && draft.errors?.length && manifest.target) {
        const outsideDiff = draft.errors.some(err => err.includes('outside the current diff'));
        const missingFile = draft.errors.some(err => err.includes('not in the current PR diff'));
        const reanchor = async asFile => {
          await window.reviewDrafts.flush(view.textarea.draftEntry);
          const current = view.textarea.draftEntry.base;
          await this.request(`comments/${current.id}/anchor`, { method: 'PUT', body: JSON.stringify({ draft_key: current.draft_key, expected_revision: current.revision, head: manifest.target.head, as_file: asFile }) });
          this.invalidate('Anchor updated.');
          await window.prManager.loadUserComments();
          await this.load();
        };
        const actionRow = node('div', null, { class: 'workspace-review-actions' });
        if (!outsideDiff && !missingFile) {
          const confirmAnchorBtn = this.button('Confirm this anchor on current head', () => reanchor(false));
          confirmAnchorBtn.classList.add('workspace-btn-secondary');
          actionRow.append(confirmAnchorBtn);
        }
        if (!draft.wire.isFileLevel && !missingFile) {
          const convertFileBtn = this.button('Convert explicitly to file comment', () => reanchor(true));
          convertFileBtn.classList.add('workspace-btn-secondary');
          actionRow.append(convertFileBtn);
        }
        const moveToBodyBtn = this.button('Move exact text to review body and exclude inline draft', async () => {
          this.bodyInput.value = this.bodyInput.value ? `${this.bodyInput.value}\n\n${view.textarea.value}` : view.textarea.value;
          this.bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
          await window.reviewDrafts.flush(this.bodyInput.draftEntry);
          await window.reviewDrafts.setIncluded(view.textarea.draftEntry.base, false);
          view.include.checked = false;
          this.invalidate('Text moved to the review body. Prepare a new final preview.');
        });
        moveToBodyBtn.classList.add('workspace-btn-secondary');
        actionRow.append(moveToBodyBtn);
        view.anchorStatus.append(actionRow);
      }
    }
  }

  async quickSubmit() {
    if (this.isSubmitting || this.isQuickSubmitting || this.isPreparing || this.cleanupPending) return;
    this.isQuickSubmitting = true;
    this.lastReceipt = null;
    this.quickSubmitButton.disabled = true;
    this.quickSubmitButton.dataset.loading = 'true';
    this.quickSubmitButton.setAttribute('aria-busy', 'true');
    this.prepareButton.disabled = true;
    this.refreshButton.disabled = true;
    const current = this.decision?.value === 'APPROVE_WITH_COMMENT' ? 'APPROVE' : this.decision?.value;
    const progressMap = { APPROVE: 'Preparing approval\u2026', COMMENT: 'Preparing comment review\u2026', REQUEST_CHANGES: 'Preparing change request\u2026' };
    this.setQuickLabel?.(progressMap[current] || 'Preparing review\u2026', false);
    try {
      await this.prepare();
      const manifest = this.manifest;
      if (manifest?.target && manifest.drafts?.some(d => d.included && d.errors?.length)) {
        let reanchored = false;
        for (const draft of manifest.drafts) {
          if (!draft.included || !draft.errors?.length) continue;
          if (draft.errors.some(err => err.includes('not in the current PR diff'))) continue;
          const view = this.cards.get(draft.key);
          if (!view?.textarea?.draftEntry) continue;
          await window.reviewDrafts.flush(view.textarea.draftEntry);
          const current = view.textarea.draftEntry.base;
          const asFile = Boolean(draft.wire.isFileLevel || draft.errors.some(err => err.includes('outside the current diff')));
          await this.request(`comments/${current.id}/anchor`, {
            method: 'PUT',
            body: JSON.stringify({ draft_key: current.draft_key, expected_revision: current.revision, head: manifest.target.head, as_file: asFile })
          });
          reanchored = true;
        }
        if (reanchored) {
          await window.prManager?.loadUserComments?.();
          await this.load({ capabilities: manifest });
          await this.prepare();
        }
      }
      if (!this.manifest || this.manifest.blockers?.length) return;
      if (this.confirm) {
        this.confirm.checked = true;
        this.confirm.dispatchEvent(new Event('change'));
      }
      await this.publish();
      if (['submitted', 'draft_saved'].includes(this.lastReceipt?.state) && !this.lastReceipt.error && this.modal?.open) {
        this.modal.close();
      }
    } finally {
      this.isQuickSubmitting = false;
      this.authoring.disabled = this.isSubmitting;
      this.prepareButton.disabled = this.isSubmitting;
      this.refreshButton.disabled = this.isSubmitting;
      this.quickSubmitButton.disabled = this.isSubmitting;
      delete this.quickSubmitButton.dataset.loading;
      this.quickSubmitButton.removeAttribute('aria-busy');
      this.syncDecisionCards?.();
    }
  }

  renderFinal(manifest) {
    const node = ReviewModal.node;
    this.finalSection.hidden = false;
    this.finalSection.replaceChildren(node('h3', 'Exact final preview'));
    const summary = this.bodyInput.draftEntry;
    const aligned = summary?.base.revision === manifest.bodyRevision && summary.body === manifest.body && summary.event === manifest.event &&
      this.cards.size === manifest.drafts.length && manifest.drafts.every(draft => {
        const entry = this.cards.get(draft.key)?.textarea.draftEntry;
        return entry?.base.revision === draft.revision && entry.body === draft.body && entry.included === draft.included;
      });
    if (!aligned) {
      this.invalidate('Saved drafts changed. Reload saved drafts before preparing a new preview.');
      this.finalSection.append(node('p', 'Authoring view is out of date. Publication is disabled; no text was changed.'));
      return;
    }
    for (const draft of manifest.drafts) {
      this.cards.get(draft.key).provenance.textContent = `Draft ${draft.id} · revision ${draft.revision}`;
    }
    this.updateCount();
    this.applyCapabilities(manifest);
    if (manifest.target) {
      const target = manifest.target;
      this.finalSection.append(ReviewModal.link(`${target.repository} #${target.number} · ${target.host}`, target.url),
        node('p', `Publishing as ${target.account.login}${target.account.id == null ? ' (account ID unavailable)' : ` · account ${target.account.id}`}`));
    } else this.finalSection.append(node('p', 'No remote publication target'));
    this.finalSection.append(node('p', `${manifest.event} · ${manifest.mode === 'draft' ? 'Save pending host draft' : 'Publish completed review'} · ${manifest.count} inline/file comments`, { class: 'workspace-review-final-summary' }),
      node('p', 'The review body and selected comment editors above are the exact Markdown payloads. No footer, location prefix or attribution is appended. Editing invalidates this preview.', { class: 'workspace-muted' }));
    if (manifest.skippedEmpty) {
      this.finalSection.append(node('p', `${manifest.skippedEmpty} empty draft${manifest.skippedEmpty === 1 ? '' : 's'} skipped — empty comments are optional and are not published.`, { class: 'workspace-muted' })); // taste-skill-ignore
    }
    const manifestDetails = node('details');
    manifestDetails.append(node('summary', 'Manifest details'),
      ...(manifest.target ? [node('p', `Head ${manifest.target.head}`, { class: 'workspace-review-provenance' })] : []),
      node('p', `Checked ${manifest.fetchedAt} · manifest ${manifest.digest}`, { class: 'workspace-review-provenance' }),
      node('p', 'Keep the pending host draft unchanged while publishing. Its final read and submission are not atomic; edits from another host client can race with publication.', { class: 'workspace-muted' }));
    this.finalSection.append(manifestDetails);
    if (manifest.prose) {
      const policy = manifest.prose;
      const receipt = node('details');
      receipt.append(node('summary', 'Exact outgoing policy receipt'), node('pre', JSON.stringify(policy, null, 2)));
      if (policy.state !== 'configured' && !policy.diagnostics.length) {
        // Nothing to act on: keep the receipt available without a heading.
        manifestDetails.append(node('p', 'No structural prose checks are configured. Exact text is still preserved.', { class: 'workspace-muted' }), receipt);
      } else {
        const section = node('section', null, { 'aria-label': 'Outgoing draft policy' });
        section.append(node('h4', `Prose policy: ${policy.profile || 'No named profile'}`),
          node('p', policy.state === 'configured' ? policy.enforcement : 'No structural prose checks are configured. Exact text is still preserved.'));
        for (const diagnostic of policy.diagnostics) {
          const draft = manifest.comments.find(comment => comment.key === diagnostic.key);
          const label = diagnostic.key === 'summary' ? 'Review body' : `Draft ${draft?.id ?? diagnostic.key}`;
          section.append(node('p', `${diagnostic.severity === 'blocking' ? 'Blocking' : 'Advisory'} · ${label}: ${diagnostic.message} Source: ${diagnostic.source} (${diagnostic.layer || 'source not recorded'})`));
          section.append(this.button(`Edit ${label.toLowerCase()}`, () => {
            const textarea = diagnostic.key === 'summary' ? this.bodyInput : this.cards.get(diagnostic.key)?.textarea;
            textarea?.scrollIntoView({ block: 'center' });
            textarea?.focus({ preventScroll: true });
          }));
        }
        section.append(receipt);
        this.finalSection.append(section);
      }
    }
    this.renderDraftAnchors(manifest);
    if (manifest.blockers.length) {
      const problems = node('ul');
      for (const blocker of manifest.blockers) problems.append(node('li', blocker));
      this.finalSection.append(problems);
    }
    if (manifest.pending?.url) this.finalSection.append(ReviewModal.link('Inspect existing remote draft', manifest.pending.url));
    if (manifest.attempt) this.renderReceipts([manifest.attempt]);
    const confirmLabel = node('label', `I confirm this target, account, head, decision, body and ${manifest.count} selected comments.`, { class: 'workspace-review-confirm' });
    this.confirm = node('input', null, { type: 'checkbox', 'aria-label': 'Confirm this exact submission manifest' });
    this.confirm.disabled = manifest.blockers.length > 0 || !this.manifest;
    confirmLabel.prepend(this.confirm);
    this.publishButton = node('button', manifest.mode === 'draft' ? `Save host draft · ${manifest.count} comments` : `Publish ${manifest.event.toLowerCase().replaceAll('_', ' ')} · ${manifest.count} comments`, { type: 'button', class: 'btn btn-primary workspace-publish' });
    this.publishButton.disabled = true;
    this.confirm.addEventListener('change', () => { this.publishButton.disabled = !this.confirm.checked || !this.manifest || this.isSubmitting; });
    this.publishButton.addEventListener('click', () => this.publish());
    this.finalSection.append(confirmLabel, this.publishButton);
    this.note.textContent = manifest.blockers.length ? 'Publication blocked. Local text is preserved.' : 'Fresh preflight complete. Nothing has been published.';
    // One primary action at a time: while a fresh preview can publish, the
    // sticky quick-submit (which would re-prepare) steps back visually.
    this.quickSubmitButton?.classList.toggle('workspace-submit-superseded', !manifest.blockers.length);
    // Bring the preview to the author; it renders below every draft card.
    if (!this.isQuickSubmitting) this.finalSection.scrollIntoView?.({ behavior: 'instant', block: 'start' });
  }

  async publish() {
    if (this.isSubmitting || !this.confirm?.checked || !this.manifest || this.manifest.blockers.length) return;
    const manifest = this.manifest;
    if (window.reviewDrafts.hasPending(this.reviewId)) { this.invalidate(); this.showError(new Error('Unsaved text invalidated the preview. Save and prepare it again.')); return; }
    this.isSubmitting = true;
    this.authoring.disabled = true;
    if (this.quickSubmitButton) {
      this.quickSubmitButton.disabled = true;
      this.quickSubmitButton.dataset.loading = 'true';
      this.setQuickLabel?.('Publishing review\u2026', false);
    }
    this.publishButton.disabled = true;
    this.publishButton.dataset.loading = 'true';
    this.prepareButton.disabled = true;
    this.refreshButton.disabled = true;
    this.note.dataset.state = 'loading';
    this.note.textContent = 'Publishing the confirmed manifest to GitHub\u2026';
    this.error.textContent = '';
    let receipt;
    try {
      const result = await this.request('submit', { method: 'POST', body: JSON.stringify({ digest: manifest.digest, mode: manifest.mode }) });
      receipt = result.receipt;
      this.lastReceipt = receipt;
      this.renderReceipts([receipt]);
      this.note.dataset.state = receipt.error ? 'warning' : 'success';
      this.note.textContent = receipt.error || (receipt.state === 'submitted' ? 'Remote submission recorded. Your exact submitted text remains in the receipt.' : 'Remote draft saved. It has not been submitted as a completed review.');
      const eventLabels = { APPROVE: 'approval', COMMENT: 'comment review', REQUEST_CHANGES: 'change request' };
      const eventLabel = eventLabels[manifest.event] || 'review';
      if (result.receipt.state === 'submitted') {
        window.toast?.success(`Submitted ${eventLabel} to ${manifest.target?.host || 'GitHub'}.`);
        if (receipt.error) {
          window.toast?.warning(receipt.error);
          this.revealReceipt();
        }
      } else if (result.receipt.state === 'draft_saved') {
        window.toast?.success(`Saved pending draft review on ${manifest.target?.host || 'GitHub'}.`);
      }
      window.dispatchEvent(new CustomEvent('reviewProgressChanged', { detail: { reviewId: this.reviewId } }));
    } catch (error) {
      delete this.note.dataset.state;
      this.showError(error);
      this.note.textContent = error.receipt ? 'Publication is incomplete. Inspect or reconcile the durable receipt before any new write.' : 'No automatic retry. Reload receipts to distinguish a rejected request from a lost response.';
    } finally {
      this.isSubmitting = false;
      this.authoring.disabled = this.isQuickSubmitting;
      if (this.quickSubmitButton) {
        this.quickSubmitButton.disabled = this.isQuickSubmitting;
        if (!this.isQuickSubmitting) {
          delete this.quickSubmitButton.dataset.loading;
          this.syncDecisionCards?.();
        }
      }
      if (this.publishButton) delete this.publishButton.dataset.loading;
      this.prepareButton.disabled = this.isQuickSubmitting;
      this.refreshButton.disabled = this.isQuickSubmitting;
      this.invalidate();
      window.prManager.updateCommentCount();
    }
    if (receipt?.state === 'submitted' && !receipt.error) {
      void this.refreshAfterPublication(manifest, receipt);
    }
  }

  async refreshAfterPublication(manifest, receipt) {
    const generation = this.generation;
    const version = this.version;
    try {
      await window.prManager.loadUserComments();
      if (generation === this.generation && version === this.version && this.modal.open) {
        await this.load({ capabilities: manifest, submitted: receipt });
      }
    } catch (error) {
      window.toast?.warning(`Review already submitted; local view could not refresh. Reload saved drafts, not the approval. ${error.message}`);
    }
  }

  renderReceipts(receipts = []) {
    if (!this.receiptsSection) return;
    this.cleanupPending = receipts.some(receipt => receipt.state === 'submitted' && Boolean(receipt.error));
    this.syncDecisionCards?.();
    const node = ReviewModal.node;
    if (!receipts.length) {
      this.receiptsSection.replaceChildren();
      this.receiptsSection.hidden = true;
      return;
    }
    this.receiptsSection.hidden = false;
    this.receiptsSection.replaceChildren(node('h3', 'Durable publication receipts'));
    for (const receipt of receipts) {
      if (!receipt.error) window.reviewDrafts?.settleSubmission(receipt);
      const cleanupPending = receipt.state === 'submitted' && Boolean(receipt.error);
      const details = node('details');
      details.open = cleanupPending || !['submitted', 'superseded'].includes(receipt.state);
      details.append(node('summary', `${receipt.state.replaceAll('_', ' ')} · ${receipt.updatedAt}`),
        node('p', `Attempt ${receipt.id} · ${receipt.observation} · phase ${receipt.phase}`, { class: 'workspace-review-provenance' }));
      if (receipt.error) details.append(node('p', receipt.error));
      if (receipt.manifest?.target?.url) details.append(ReviewModal.link('Open target pull request', receipt.manifest.target.url));
      if (receipt.url) details.append(ReviewModal.link(receipt.remoteId ? 'Inspect host-reported review' : 'Inspect pending candidate (ownership unconfirmed)', receipt.url));
      details.append(node('p', 'Unknown outcomes are never retried or deduplicated by matching text. Reconciliation is read-only.'));
      const list = node('ul');
      for (const item of receipt.items) list.append(node('li', `Draft ${item.key} · ${item.state}${item.remoteId ? ` · remote ${item.remoteId}` : ''}${item.error ? ` · ${item.error}` : ''}`));
      details.append(list);
      const payload = node('details');
      payload.append(node('summary', 'Inspect recorded authorization and exact payloads'), node('pre', JSON.stringify(receipt.manifest, null, 2)));
      details.append(payload);
      if (cleanupPending || !['submitted', 'superseded'].includes(receipt.state)) details.append(this.button(cleanupPending ? 'Finish local cleanup (no host write)' : 'Reconcile receipt (read-only)', async () => {
        const result = await this.request(`submissions/${receipt.id}/reconcile`, { method: 'POST' });
        this.invalidate('Receipt reconciled. Prepare a fresh preview before another write.');
        this.renderReceipts([result.receipt]);
        if (result.receipt.state === 'submitted') {
          this.note.textContent = result.receipt.error || 'Remote submission reconciled without additional writes.';
          this.note.dataset.state = result.receipt.error ? 'warning' : 'success';
          if (!result.receipt.error) void this.refreshAfterPublication(this.capabilities, result.receipt);
        }
      }));
      this.receiptsSection.append(details);
    }
  }
}

if (typeof window !== 'undefined') {
  window.ReviewModal = ReviewModal;
  window.reviewModal = new ReviewModal();
}
if (typeof module !== 'undefined' && module.exports) module.exports = { ReviewModal };
