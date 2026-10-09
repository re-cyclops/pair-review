// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
class ReviewProgress {
  constructor(manager) {
    this.manager = manager;
    this.desired = new Set();
    this.queue = Promise.resolve();
    this.generation = 0;
    this.viewedVersion = 0;
    const refresh = event => {
      if (event.detail?.reviewId !== this.manager.currentPR?.id) return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh().catch(error => this.showError(error)), 200);
    };
    window.addEventListener('reviewDraftSaved', refresh);
    for (const type of ['review:progress_changed', 'review:comments_changed', 'review:suggestions_changed', 'review:analysis_completed']) document.addEventListener(type, refresh);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh({ detail: { reviewId: this.manager.currentPR?.id } });
    });
  }

  async request(suffix = '', input, reviewId = this.manager.currentPR?.id) {
    const response = await fetch(`/api/reviews/${reviewId}/${suffix || 'progress'}`, input ? {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Client-ID': this.manager._clientId || '' }, body: JSON.stringify(input)
    } : undefined);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Progress unavailable (${response.status})`);
    return data;
  }

  owns(reviewId, generation) {
    return this.manager.currentPR?.id === reviewId && this.generation === generation;
  }

  apply(state) {
    if (this.state?.token === state.token && this.state.progressRevision > state.progressRevision) return false;
    this.state = state;
    this.render();
    return true;
  }

  async importHistory(state, reviewId) {
    const pr = this.manager.currentPR;
    const key = pr.localPath && pr.head_sha
      ? `pair-review-local-viewed:${btoa(unescape(encodeURIComponent(pr.localPath)))}:${pr.head_sha}`
      : `${PRManager.getRepoStorageKey('pair-review-viewed', pr.owner, pr.repo)}:${pr.number}`;
    let saved, files;
    try { saved = localStorage.getItem(key); files = saved ? JSON.parse(saved) : null; }
    catch { return state; }
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) return state;
    const imported = await this.request('', { token: state.token, action: 'import-history', files }, reviewId);
    try { if (localStorage.getItem(key) === saved) localStorage.removeItem(key); }
    catch { /* A later import is idempotent; never clear before server acknowledgement. */ }
    return imported;
  }

  async load() {
    const generation = ++this.generation;
    const reviewId = this.manager.currentPR?.id;
    this.state = null;
    let state = await this.request('', undefined, reviewId);
    if (!this.owns(reviewId, generation)) return;
    const displayed = this.manager.displayedProgressContext;
    if (!displayed || displayed.head !== state.head || displayed.digest !== state.contentDigest) {
      throw new Error('The displayed diff no longer matches the saved revision. Refresh the full current diff before recording progress.');
    }
    if (state.available) state = await this.importHistory(state, reviewId);
    if (!this.owns(reviewId, generation)) return;
    this.apply(state);
    this.desired = new Set(state.files);
    this.manager.viewedFiles = new Set(state.files);
    if (state.available && this.openedToken !== state.token) {
      this.openedToken = state.token;
      this.request('', { token: state.token, action: 'opened' }, reviewId).then(opened => {
        if (this.owns(reviewId, generation)) this.apply(opened);
      }).catch(error => { if (this.owns(reviewId, generation)) this.showError(error); });
    }
  }

  async refresh() {
    const generation = this.generation;
    const reviewId = this.manager.currentPR?.id;
    const token = this.state?.token;
    if (!token) return;
    await this.queue.catch(() => {});
    const version = this.viewedVersion;
    const state = await this.request('', undefined, reviewId);
    if (!this.owns(reviewId, generation)) return;
    if (state.token !== token) {
      this.showError(new Error('The review revision, scope or pinned content changed. Refresh the full current diff.'));
      return;
    }
    if (this.apply(state) && version === this.viewedVersion) {
      this.desired = new Set(state.files);
      this.manager.viewedFiles = new Set(state.files);
      this.syncCheckboxes();
    }
  }

  saveViewed(files) {
    const next = new Set(files);
    const changes = {};
    for (const file of next) if (!this.desired.has(file)) Object.defineProperty(changes, file, { value: true, enumerable: true });
    for (const file of this.desired) if (!next.has(file)) Object.defineProperty(changes, file, { value: false, enumerable: true });
    this.desired = next;
    if (!Object.keys(changes).length) return this.queue;
    const token = this.state?.token;
    const reviewId = this.manager.currentPR?.id;
    const generation = this.generation;
    const version = ++this.viewedVersion;
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!this.owns(reviewId, generation)) return;
      const state = await this.request('', { action: 'files', token, changes }, reviewId);
      if (!this.owns(reviewId, generation)) return;
      if (this.apply(state) && version === this.viewedVersion) {
        this.desired = new Set(state.files);
        this.manager.viewedFiles = new Set(state.files);
        this.syncCheckboxes();
      }
    }).catch(async error => {
      if (!this.owns(reviewId, generation)) return;
      try { await this.load(); this.syncCheckboxes(); } catch { /* Keep the failed-save message visible. */ }
      this.showError(error);
      throw error;
    });
    return this.queue;
  }

  syncCheckboxes() {
    const keys = new Set([...this.manager.viewedFiles, ...this.desired]);
    for (const file of this.manager.diffFiles || []) keys.add(file.file);
    for (const file of this.manager.contextFiles || []) keys.add(`context:${file.file}`);
    for (const key of keys) {
      const context = key.startsWith('context:');
      const file = context ? key.slice(8) : key;
      const wrapper = context ? this.manager.findContextFileWrapper(file) : this.manager.findFileElement(file);
      const header = wrapper?.querySelector('.d2h-file-header');
      if (header) window.DiffRenderer.updateFileViewedState(header, this.manager.viewedFiles.has(key));
      this.manager.updateFileItemViewedState(file, this.manager.viewedFiles.has(key), { contextItem: context });
    }
  }

  visit(file) {
    if (!this.state?.available || this.state.visited.includes(file)) return;
    const token = this.state.token;
    const reviewId = this.manager.currentPR?.id;
    const generation = this.generation;
    this.request('', { action: 'visited', token, file }, reviewId).then(state => {
      if (!this.owns(reviewId, generation) || this.state?.token !== token) return;
      this.apply(state);
    }).catch(error => { if (this.owns(reviewId, generation)) this.showError(error); });
  }

  showError(error) {
    this.render();
    if (!this.message) return;
    this.message.textContent = `Progress not saved: ${error.message}`;
    this.message.setAttribute('role', 'alert');
  }

  render() {
    const node = ReviewModal.node;
    if (!this.panel?.isConnected) {
      const diff = document.getElementById('diff-container');
      if (!diff) return;
      this.panel = node('section', null, { class: 'workspace-review-progress', 'aria-label': 'Review progress' });
      this.summary = node('p', '', { role: 'status' });
      this.message = node('p', '', { class: 'workspace-muted' });
      const actions = node('div', null, { class: 'workspace-progress-actions' });
      const compare = node('button', 'Changes since reviewed…', { type: 'button' });
      compare.addEventListener('click', () => this.showComparison());
      this.mark = node('button', 'Mark revision reviewed…', { type: 'button' });
      this.mark.addEventListener('click', () => this.confirmReviewed());
      this.panel.append(this.summary, this.message, actions);
      actions.append(compare, this.mark);
      diff.before(this.panel);
    }
    const s = this.state;
    this.mark.disabled = !s?.available;
    if (!s) { this.summary.textContent = 'Review progress unavailable'; return; }
    this.summary.textContent = `${s.visitedFiles}/${s.totalFiles} files visited · ${s.reviewedFiles}/${s.totalFiles} content-bound viewed marks · ${s.triagedFindings} findings triaged · ${s.selectedComments} comments selected${s.submitted ? ' · prior submission recorded' : ''}`;
    this.message.removeAttribute('role');
    this.message.textContent = !s.available ? 'Current diff unavailable. Any existing reviewed baseline is preserved.'
      : `${s.lastReviewed ? `Last explicitly reviewed ${s.lastReviewed.head.slice(0, 12)}${s.newCommits ? ' · new head since review' : s.changedContent ? ' · comparison content or scope changed' : ''}` : 'No revision explicitly marked reviewed'} · opening or AI completion never marks a revision reviewed.${s.staleDrafts ? ` ${s.staleDrafts} drafts need current-head anchor review; text is retained.` : ''}${s.legacyViewedCount ? ` ${s.legacyViewedCount} older marks lack revision evidence; mark current content again.` : ''}`;
  }

  confirmReviewed() {
    const workspace = window.reviewWorkspace;
    const node = ReviewModal.node;
    if (!workspace || !this.state?.available) return;
    const token = this.state.token;
    const reviewId = this.manager.currentPR?.id;
    const generation = this.generation;
    if (!this.confirmDialog) this.confirmDialog = workspace.makeDialog('review-progress-confirm', 'Record reviewed revision');
    this.confirmDialog.querySelector('.workspace-progress-body')?.remove();
    const content = node('div', null, { class: 'workspace-progress-body' });
    content.append(node('p', `Mark displayed revision ${this.state.head} as reviewed? This sets your next comparison baseline. It does not publish, approve, mark files viewed, or certify correctness.`));
    const confirm = node('button', 'Mark this revision reviewed', { type: 'button' });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        if (!this.owns(reviewId, generation)) throw new Error('The open review changed. Reopen this confirmation from its current diff.');
        const state = await this.request('', { action: 'reviewed', token }, reviewId);
        if (!this.owns(reviewId, generation)) return;
        this.apply(state);
        this.confirmDialog.close();
        window.dispatchEvent(new CustomEvent('reviewProgressChanged', { detail: { reviewId } }));
      } catch (error) { content.append(node('p', error.message, { role: 'alert' })); }
      finally { confirm.disabled = false; }
    });
    content.append(confirm);
    this.confirmDialog.append(content);
    workspace.open(this.confirmDialog);
  }

  async showComparison() {
    const workspace = window.reviewWorkspace;
    const node = ReviewModal.node;
    if (!workspace) return;
    if (!this.comparison) this.comparison = workspace.makeDialog('review-progress-comparison', 'Changes since your reviewed revision');
    this.comparison.querySelector('.workspace-progress-body')?.remove();
    const content = node('div', null, { class: 'workspace-progress-body' });
    content.append(node('p', 'Loading comparison. The full current review remains unchanged.'));
    this.comparison.append(content);
    workspace.open(this.comparison);
    const generation = (this.comparisonGeneration || 0) + 1;
    this.comparisonGeneration = generation;
    try {
      const reviewId = this.manager.currentPR?.id;
      const contextGeneration = this.generation;
      const result = await this.request(`changes-since-reviewed?token=${encodeURIComponent(this.state?.token || '')}`, undefined, reviewId);
      if (!this.owns(reviewId, contextGeneration) || generation !== this.comparisonGeneration || !this.comparison.open) return;
      content.replaceChildren(node('p', result.available
        ? `${result.commitCount} commits · ${result.files.length} changed files · ${result.baseline.head.slice(0, 12)} → ${result.head.slice(0, 12)}` : result.reason));
      content.append(node('p', 'Read-only navigation comparison. AI analysis still receives the full review scope and this recorded baseline. Add comments only in the full current diff so anchors remain explicit.'));
      const full = node('button', 'Return to full current diff', { type: 'button' });
      full.addEventListener('click', () => this.comparison.close());
      content.append(full);
      if (result.available) {
        for (const file of result.files) {
          if (!this.manager.canonicalFileOrder?.has(file.file)) {
            content.append(node('p', `${file.file} changed since review but is absent from the full current review diff; no current inline anchor is offered.`));
            continue;
          }
          const jump = node('button', `Open ${file.file} in current diff`, { type: 'button' });
          jump.addEventListener('click', async () => { this.comparison.close(); await this.manager.scrollToFile(file.file); });
          content.append(jump);
        }
        content.append(node('pre', result.diff || 'No committed changes since this reviewed revision.', { class: 'workspace-comparison-diff', tabindex: '0', 'aria-label': 'Read-only changes since reviewed' }));
      }
    } catch (error) { if (generation === this.comparisonGeneration) content.replaceChildren(node('p', `Comparison unavailable: ${error.message}. The full current diff remains displayed.`, { role: 'alert' })); }
  }
}
window.ReviewProgress = ReviewProgress;
