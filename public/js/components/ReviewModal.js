// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/** Local authoring and one server-bound final preview. Opening never publishes. */
class ReviewModal {
  constructor() {
    this.generation = 0;
    this.version = 0;
    this.isSubmitting = false;
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

  button(label, action) {
    const button = ReviewModal.node('button', label, { type: 'button' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action(); } catch (error) { this.showError(error); }
      finally { button.disabled = false; }
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
    if (this.isSubmitting) { window.reviewWorkspace.open(this.modal); return; }
    if (this.isVisible) return;
    this.reviewId = window.prManager.currentPR.id;
    if (!this.modal) {
      this.modal = window.reviewWorkspace.makeDialog('review-modal', 'Review authoring and final preview');
      this.modal.classList.add('workspace-review');
      this.content = ReviewModal.node('div', null, { class: 'workspace-review-content' });
      this.modal.append(this.content);
      this.modal.addEventListener('close', () => {
        this.generation++;
        for (const textarea of this.modal.querySelectorAll('textarea[data-draft-key]')) window.reviewDrafts.close(textarea);
      });
    }
    this.content.replaceChildren();
    this.manifest = null;
    this.note = ReviewModal.node('p', 'Loading saved local drafts…', { role: 'status' });
    this.error = ReviewModal.node('p', '', { role: 'alert', class: 'workspace-review-error' });
    this.content.append(this.note, this.error);
    window.reviewWorkspace.open(this.modal);
    await this.load();
  }

  async load() {
    const generation = ++this.generation;
    try {
      const [summary, comments, manifest, receipts] = await Promise.all([
        this.request('draft'), this.request('comments'), this.request('manifest?local=true'), this.request('submissions')
      ]);
      if (generation !== this.generation || !this.modal.open) return;
      this.savedSummary = summary;
      this.localManifest = manifest;
      this.comments = new Map(comments.comments.map(comment => [comment.id, comment]));
      window.reviewDrafts.ingest([...comments.comments, { ...summary, draft_key: `summary:${summary.id}`, included: true }]);
      await this.renderAuthoring(manifest);
      if (generation !== this.generation || !this.modal.open) return;
      this.renderReceipts(receipts.receipts);
      this.note.textContent = 'Saved locally. No host write occurs until you confirm an exact, fresh preview.';
      try {
        const capabilities = await this.request('manifest');
        if (generation === this.generation && this.modal.open) this.applyCapabilities(capabilities);
      } catch (error) {
        if (generation === this.generation) this.capabilityStatus.textContent = `Host identity unavailable: ${error.message}. Local authoring remains available.`;
      }
    } catch (error) { if (generation === this.generation) this.showError(error); }
  }

  async renderAuthoring(manifest) {
    this.authoring?.remove();
    this.finalSection?.remove();
    this.actions?.remove();
    this.receiptsSection?.remove();
    const node = ReviewModal.node;
    this.authoring = node('fieldset', null, { class: 'workspace-review-authoring' });
    this.authoring.disabled = this.isSubmitting;
    this.authoring.append(node('legend', 'Local drafts'));
    const label = node('label', 'Review body — exact Markdown', { for: 'review-body-modal' });
    this.bodyInput = node('textarea', null, { id: 'review-body-modal', rows: '5', spellcheck: 'true' });
    this.authoring.append(label, this.bodyInput);
    const summaryReady = window.reviewDrafts.bindSummary(this.bodyInput, this.savedSummary);
    this.authoring.append(this.button('Append AI summary to review body', () => this.appendAISummary()));
    this.capabilityStatus = node('p', 'Checking host identity; approval actions remain unavailable until checked.');
    const decisions = node('label', 'Decision ', { for: 'review-decision' });
    this.decision = node('select', null, { id: 'review-decision' });
    for (const [value, label] of [['COMMENT', 'Comment only'], ['APPROVE', 'Approve'], ['APPROVE_WITH_COMMENT', 'Approve with comment'], ['REQUEST_CHANGES', 'Request changes']]) {
      const option = node('option', label, { value });
      option.disabled = value !== 'COMMENT';
      this.decision.append(option);
    }
    decisions.append(this.decision);
    this.authoring.append(decisions, this.capabilityStatus, node('p', 'Approval includes any selected comments and body. Choosing a decision never clears your text.'));
    this.decision.addEventListener('change', async () => {
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
      card.append(node('h4', `${draft.wire.path} · ${location}`), provenance);
      const includeLabel = node('label', 'Include in submission ');
      const include = node('input', null, { type: 'checkbox', 'aria-label': `Include draft ${draft.id} in submission` });
      include.checked = draft.included;
      includeLabel.prepend(include);
      const textarea = node('textarea', null, { rows: '4', 'aria-label': `Draft ${draft.id} exact Markdown` });
      card.append(includeLabel, textarea);
      this.authoring.append(card);
      window.reviewDrafts.bind(textarea, { comment, mode: comment.is_file_level ? 'file-edit' : 'edit' });
      bindings.push(textarea.draftReady.then(entry => { if (entry) include.checked = entry.included; }));
      include.addEventListener('change', async () => {
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
      card.append(this.button('Delete this local draft…', () => { deletion.hidden = false; cancelDeletion.focus(); }), deletion);
      this.cards.set(draft.key, { card, textarea, include, anchorStatus, provenance });
    }
    this.mode = node('select', null, { id: 'review-publication-mode' });
    this.mode.append(node('option', 'Publish completed review', { value: 'submit' }), node('option', 'Save pending review on host', { value: 'draft' }));
    const modeLabel = node('label', 'Host action ', { for: 'review-publication-mode' });
    modeLabel.append(this.mode);
    this.mode.addEventListener('change', () => this.invalidate('Host action changed. Prepare a new final preview.'));
    this.authoring.append(modeLabel);
    this.actions = node('div', null, { class: 'workspace-review-actions' });
    this.prepareButton = this.button('Prepare exact final preview', () => this.prepare());
    this.refreshButton = this.button('Reload saved drafts', async () => { await window.reviewDrafts.flushAll(this.reviewId); this.invalidate('Saved drafts reloaded.'); await this.load(); });
    this.prepareButton.disabled = this.isSubmitting;
    this.refreshButton.disabled = this.isSubmitting;
    this.actions.append(this.prepareButton, this.refreshButton, this.button('Skip — keep drafts local', () => this.modal.close()));
    this.finalSection = node('section', null, { class: 'workspace-review-final', 'aria-label': 'Final submission preview' });
    this.receiptsSection = node('section', null, { class: 'workspace-review-receipts', 'aria-label': 'Durable publication receipts' });
    this.content.append(this.authoring, this.actions, this.finalSection, this.receiptsSection);
    await Promise.all(bindings);
    const entry = this.bodyInput.draftEntry;
    if (!entry) throw new Error('Review body could not be loaded. Resolve recoverable text before publication.');
    this.decision.value = entry.event === 'APPROVE' && (entry.body || manifest.count) ? 'APPROVE_WITH_COMMENT' : entry.event;
    this.invalidate();
  }

  applyCapabilities(manifest) {
    for (const option of this.decision.options) {
      const event = option.value === 'APPROVE_WITH_COMMENT' ? 'APPROVE' : option.value;
      option.disabled = event !== 'COMMENT' && (!manifest.target || !manifest.allowedEvents.includes(event));
    }
    this.capabilityStatus.textContent = manifest.target
      ? `${manifest.target.repository} #${manifest.target.number} · ${manifest.target.account.login}${manifest.allowedEvents.length === 1 ? ' · own PR: comment-only review' : ''}`
      : 'Local-only authoring. Associate a PR before choosing a host approval or change request.';
  }

  invalidate(message) {
    this.version++;
    this.manifest = null;
    if (this.confirm) { this.confirm.checked = false; this.confirm.disabled = true; }
    if (this.publishButton) this.publishButton.disabled = true;
    if (message && this.note && !this.isSubmitting) this.note.textContent = message;
    if (message && this.count && !this.isSubmitting) this.count.textContent = 'Selection changed — prepare to confirm the saved count';
    const heading = this.finalSection?.querySelector('h3');
    if (heading) heading.textContent = 'Previous preview — confirmation cleared';
  }

  showError(error) {
    this.error.textContent = error.message;
    if (error.receipt) this.renderReceipts([error.receipt]);
  }

  async prepare() {
    this.error.textContent = '';
    this.invalidate();
    this.authoring.disabled = true;
    try {
      await window.reviewDrafts.flushAll(this.reviewId);
      if (window.reviewDrafts.hasPending(this.reviewId)) throw new Error('Resolve all unsaved or conflicting drafts before preparing publication.');
      const version = this.version;
      const generation = this.generation;
      const manifest = await this.request(`manifest?mode=${this.mode.value}`);
      if (version !== this.version || generation !== this.generation || !this.modal.open) throw new Error('The review changed while preflight loaded. Prepare a new preview.');
      this.manifest = manifest;
      this.renderFinal(manifest);
    } finally { this.authoring.disabled = false; }
  }

  renderFinal(manifest) {
    const node = ReviewModal.node;
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
    this.count.textContent = `${manifest.count} selected saved comments`;
    this.applyCapabilities(manifest);
    if (manifest.target) {
      const target = manifest.target;
      this.finalSection.append(ReviewModal.link(`${target.repository} #${target.number} · ${target.host}`, target.url),
        node('p', `Publishing as ${target.account.login}${target.account.id == null ? ' (account ID unavailable)' : ` · account ${target.account.id}`}`),
        node('p', `Head ${target.head}`, { class: 'workspace-review-provenance' }));
    } else this.finalSection.append(node('p', 'No remote publication target'));
    this.finalSection.append(node('p', `${manifest.event} · ${manifest.mode === 'draft' ? 'Save pending host draft' : 'Publish completed review'} · ${manifest.count} inline/file comments`),
      node('p', 'The review body and selected comment editors above are the exact Markdown payloads. No footer, location prefix or attribution is appended. Editing invalidates this preview.'),
      node('p', `Checked ${manifest.fetchedAt} · manifest ${manifest.digest}`, { class: 'workspace-review-provenance' }));
    this.finalSection.append(node('p', 'Keep the pending host draft unchanged while publishing. Its final read and submission are not atomic; edits from another host client can race with publication.', { class: 'workspace-muted' }));
    if (manifest.prose) {
      const policy = manifest.prose;
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
      const details = node('details');
      details.append(node('summary', 'Exact outgoing policy receipt'), node('pre', JSON.stringify(policy, null, 2)));
      section.append(details);
      this.finalSection.append(section);
    }
    for (const draft of manifest.drafts) {
      const view = this.cards.get(draft.key);
      view.anchorStatus.replaceChildren();
      view.card.dataset.included = String(draft.included);
      for (const problem of draft.errors || []) view.anchorStatus.append(node('p', problem));
      if (draft.included && draft.errors?.length && manifest.target) {
        const reanchor = async asFile => {
          await window.reviewDrafts.flush(view.textarea.draftEntry);
          const current = view.textarea.draftEntry.base;
          await this.request(`comments/${current.id}/anchor`, { method: 'PUT', body: JSON.stringify({ draft_key: current.draft_key, expected_revision: current.revision, head: manifest.target.head, as_file: asFile }) });
          this.invalidate('Anchor changed. Prepare a new final preview.');
          await window.prManager.loadUserComments();
          await this.load();
        };
        view.anchorStatus.append(this.button('Confirm this anchor on current head', () => reanchor(false)));
        if (!draft.wire.isFileLevel) view.anchorStatus.append(this.button('Convert explicitly to file comment', () => reanchor(true)));
        view.anchorStatus.append(this.button('Move exact text to review body and exclude inline draft', async () => {
          this.bodyInput.value = this.bodyInput.value ? `${this.bodyInput.value}\n\n${view.textarea.value}` : view.textarea.value;
          this.bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
          await window.reviewDrafts.flush(this.bodyInput.draftEntry);
          await window.reviewDrafts.setIncluded(view.textarea.draftEntry.base, false);
          view.include.checked = false;
          this.invalidate('Text moved to the review body. Prepare a new final preview.');
        }));
      }
    }
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
    this.publishButton = node('button', manifest.mode === 'draft' ? `Save host draft · ${manifest.count} comments` : `Publish ${manifest.event.toLowerCase().replaceAll('_', ' ')} · ${manifest.count} comments`, { type: 'button', class: 'btn btn-primary' });
    this.publishButton.disabled = true;
    this.confirm.addEventListener('change', () => { this.publishButton.disabled = !this.confirm.checked || !this.manifest || this.isSubmitting; });
    this.publishButton.addEventListener('click', () => this.publish());
    this.finalSection.append(confirmLabel, this.publishButton);
    this.note.textContent = manifest.blockers.length ? 'Publication blocked. Local text is preserved.' : 'Fresh preflight complete. Nothing has been published.';
  }

  async publish() {
    if (this.isSubmitting || !this.confirm?.checked || !this.manifest || this.manifest.blockers.length) return;
    const manifest = this.manifest;
    if (window.reviewDrafts.hasPending(this.reviewId)) { this.invalidate(); this.showError(new Error('Unsaved text invalidated the preview. Save and prepare it again.')); return; }
    this.isSubmitting = true;
    this.authoring.disabled = true;
    this.publishButton.disabled = true;
    this.prepareButton.disabled = true;
    this.refreshButton.disabled = true;
    this.note.textContent = 'Publishing the confirmed manifest. Closing this dialog does not cancel host writes; the receipt is stored durably.';
    this.error.textContent = '';
    try {
      const result = await this.request('submit', { method: 'POST', body: JSON.stringify({ digest: manifest.digest, mode: manifest.mode }) });
      await window.prManager.loadUserComments();
      if (result.receipt.state === 'submitted') await this.load();
      else this.renderReceipts([result.receipt]);
      this.note.textContent = result.receipt.state === 'submitted' ? 'Remote submission recorded. Your exact submitted text remains in the receipt.' : 'Remote draft saved. It has not been submitted as a completed review.';
    } catch (error) {
      this.showError(error);
      this.note.textContent = error.receipt ? 'Publication is incomplete. Inspect or reconcile the durable receipt before any new write.' : 'No automatic retry. Reload receipts to distinguish a rejected request from a lost response.';
    } finally {
      this.isSubmitting = false;
      this.authoring.disabled = false;
      this.prepareButton.disabled = false;
      this.refreshButton.disabled = false;
      this.invalidate();
      window.prManager.updateCommentCount();
    }
  }

  renderReceipts(receipts = []) {
    if (!this.receiptsSection) return;
    const node = ReviewModal.node;
    this.receiptsSection.replaceChildren(node('h3', 'Durable publication receipts'));
    if (!receipts.length) this.receiptsSection.append(node('p', 'No recorded publication attempts for this review.'));
    for (const receipt of receipts) {
      window.reviewDrafts?.settleSubmission(receipt);
      const details = node('details');
      details.open = !['submitted', 'superseded'].includes(receipt.state);
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
      if (!['submitted', 'superseded'].includes(receipt.state)) details.append(this.button('Reconcile receipt (read-only)', async () => {
        const result = await this.request(`submissions/${receipt.id}/reconcile`, { method: 'POST' });
        this.invalidate('Receipt reconciled. Prepare a fresh preview before another write.');
        this.renderReceipts([result.receipt]);
        await window.prManager.loadUserComments();
        if (result.receipt.state === 'submitted') {
          await this.load();
          this.note.textContent = 'Remote submission reconciled without additional writes.';
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
