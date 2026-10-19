// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
(() => {
  'use strict';
  const element = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const { checkLabel, hostIdentity, hasDraft, draftLabel } = window.ReviewEvidence;

  class ReviewInbox {
    constructor(workspace) {
      this.workspace = workspace;
      this.records = new Map();
      this.cache = new Map();
      this.observations = new Map();
      this.queue = [];
      this.inFlight = 0;
      this.root = document.getElementById('recent-reviews-section');
      if (!this.root) return;
      this.buildTools();
      this.primary = this.root.querySelector('#unified-tab-bar .active')?.dataset.workspaceView || 'all';
      window.addEventListener('workspaceViewChanged', event => {
        this.primary = event.detail;
        requestAnimationFrame(() => this.applyFilters(true));
      });
      this.root.addEventListener('pointerenter', () => { this.orderLocked = true; }, { once: true });
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          const record = this.records.get(entry.target);
          if (record && !record.local && !record.queued && !record.snapshot) { record.queued = true; this.queue.push(record); }
        }
        this.drain();
      }, { rootMargin: '120px' });
      this.mutations = new MutationObserver(changes => {
        if (changes.some(change => change.target.matches?.('tr') || [...change.addedNodes, ...change.removedNodes].some(node => node.nodeType === 1 && (node.matches?.('tr,table,tbody,.tab-pane') || node.querySelector?.('tr'))))) this.scan();
      });
      this.mutations.observe(this.root, { childList: true, subtree: true });
      window.addEventListener('workspaceReviews', () => { this.renderRows(); this.applyFilters(); this.sortRows(); });
      window.addEventListener('workspaceCollectionObserved', event => this.observeCollection(event.detail));
      window.addEventListener('workspaceContextChanged', () => {
        this.cache.clear();
        this.observations.clear();
        this.inspectGeneration = (this.inspectGeneration || 0) + 1;
        this.inspectorBody?.replaceChildren(element('p', 'Server context changed. Select the review again to inspect current evidence.'));
        for (const record of this.records.values()) record.snapshot = { availability: 'unavailable', error: 'Server context changed' };
        this.runs = [];
        this.renderRows();
        this.applyFilters();
        this.workspace.loadReviews();
      });
      window.addEventListener('workspaceActivity', event => {
        this.runs = event.detail.runs; this.renderRows(); this.applyFilters(); this.refreshVisible();
      });
      window.addEventListener('online', () => this.drain());
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.drain(); });
      this.root.addEventListener('keydown', event => this.onKey(event));
      this.root.addEventListener('focusin', event => {
        this.orderLocked = true;
        const row = event.target.closest('tr');
        if (!this.records.has(row)) return;
        this.selected = this.records.get(row);
        this.focusIndex = [...row.querySelectorAll('a,button,input,select')].indexOf(event.target);
      });
      this.workspace.register('inspect-review', 'Inspect selected review evidence', () => this.inspect(this.selected), { available: () => !!this.selected?.row.isConnected });
      this.workspace.register('open-selected', 'Open selected pull request on its host', () => {
        const link = this.selected?.row.querySelector('.col-actions a[target="_blank"]');
        if (link) link.click();
        else this.inspect(this.selected);
      }, { available: () => !!this.selected?.row.isConnected });
      this.workspace.loadReviews();
      this.scan();
    }

    observeCollection({ collection, sources }) {
      this.scan();
      let changed = false;
      for (const source of sources || []) {
        if (!Object.hasOwn(source, 'observationId')) continue;
        const host = hostIdentity(source.host);
        const scope = `${collection}:${host}:${source.repo || ''}`;
        if (this.observations.has(scope) && this.observations.get(scope) === source.observationId) continue;
        this.observations.set(scope, source.observationId);
        const prefix = source.repo ? `${host}:${source.repo.toLowerCase()}#` : `${host}:`;
        for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
        for (const record of this.records.values()) if (!record.local && record.key.startsWith(prefix)) {
          record.snapshot = null;
          record.force = true;
        }
        changed = true;
      }
      if (!changed) return;
      this.inspectGeneration = (this.inspectGeneration || 0) + 1;
      this.inspectorBody?.replaceChildren(element('p', 'Queue observation changed. Select the review again to inspect current evidence.'));
      this.renderRows();
      this.applyFilters();
      this.refreshVisible();
    }

    buildTools() {
      const heading = element('div', null, { class: 'workspace-inbox-heading' });
      heading.append(element('h1', 'Review inbox'), element('p', 'Decide what needs you. Inspect evidence before opening a review.', { class: 'workspace-muted' }));
      const tools = element('div', null, { class: 'workspace-inbox-tools', role: 'search', 'aria-label': 'Filter loaded reviews' });
      this.search = element('input', null, { type: 'search', name: 'inbox-search', autocomplete: 'off', spellcheck: 'false', placeholder: 'Repository, author, title, or PR number\u2026', 'aria-label': 'Filter loaded reviews' });
      this.view = element('select', null, { 'aria-label': 'Additional review filter' });
      for (const [id, name] of [['all', 'All states'], ['unapproved', 'Unapproved only'], ['approved', 'Approved by you'], ['ai-unreviewed', 'Not AI reviewed'], ['ai-reviewed', 'AI reviewed'], ['individual', 'Individual requests'], ['teams', 'Team requests'], ['failed-ci', 'CI needs attention'], ['changed', 'New commits since your review'], ['pr-draft', 'Draft pull requests'], ['pr-ready', 'Non-draft pull requests'], ['running', 'Analysis running'], ['completed', 'Analysis completed'], ['unknown', 'Unknown or stale evidence']]) this.view.append(element('option', name, { value: id }));
      this.view.value = localStorage.getItem('pair-review-inbox-filter') || 'all';
      if (!this.view.value) this.view.value = 'all';
      this.hideApproved = localStorage.getItem('pair-review-hide-approved') === 'true';
      this.repository = element('select', null, { 'aria-label': 'Repository filter' });
      this.author = element('select', null, { 'aria-label': 'Author filter' });
      for (const select of [this.repository, this.author]) select.addEventListener('change', () => this.applyFilters(true));
      this.search.addEventListener('input', () => this.applyFilters(true));
      this.view.addEventListener('change', () => {
        const value = this.view.value;
        localStorage.setItem('pair-review-inbox-filter', value);
        if (value === 'teams') this.root.querySelector('[data-tab="team-reviews-tab"]')?.click();
        else if (this.primary === 'teams') this.root.querySelector('[data-workspace-view="all"]')?.click();
        this.applyFilters(true);
      });
      const refresh = element('button', 'Refresh visible evidence', { type: 'button' });
      refresh.addEventListener('click', () => {
        for (const record of this.records.values()) if (record.row.getClientRects().length && !record.queued) {
          record.queued = true; record.force = true; this.queue.push(record);
        }
        this.drain();
      });
      this.sort = element('button', 'Apply next-action order', { type: 'button', title: 'Drafts and personal requests first, then waiting items; oldest activity breaks ties. Background updates stop reordering once you interact.' });
      this.sort.addEventListener('click', () => { this.applyFilters(true); this.sortRows(true); });
      this.hideApprovedBtn = element('button', this.hideApproved ? 'Showing unapproved only' : 'Hide approved', {
        type: 'button',
        class: `workspace-hide-approved-btn${this.hideApproved ? ' active' : ''}`,
        'aria-pressed': String(this.hideApproved),
        title: 'Hide pull requests you have already approved'
      });
      this.hideApprovedBtn.addEventListener('click', () => {
        this.hideApproved = !this.hideApproved;
        localStorage.setItem('pair-review-hide-approved', String(this.hideApproved));
        this.hideApprovedBtn.classList.toggle('active', this.hideApproved);
        this.hideApprovedBtn.setAttribute('aria-pressed', String(this.hideApproved));
        this.hideApprovedBtn.textContent = this.hideApproved ? 'Showing unapproved only' : 'Hide approved';
        this.applyFilters(true);
      });
      this.clearApprovedBtn = element('button', 'Clear approved', {
        type: 'button',
        class: 'workspace-clear-approved-btn',
        hidden: '',
        title: 'Remove local history for pull requests you have already approved'
      });
      this.clearApprovedBtn.addEventListener('click', () => this.clearApprovedReviews());
      this.status = element('p', '', { class: 'workspace-muted', role: 'status', 'aria-live': 'polite' });
      this.filters = element('details', null, { class: 'workspace-filters' });
      this.filterSummary = element('summary', 'Filters and order');
      const options = element('div', null, { class: 'workspace-filter-options' });
      options.append(this.repository, this.author, this.view, this.hideApprovedBtn, this.clearApprovedBtn, refresh, this.sort);
      this.filters.append(this.filterSummary, options);
      const wide = matchMedia('(min-width: 769px)');
      this.filters.open = wide.matches;
      wide.addEventListener('change', () => { this.filters.open = wide.matches; });
      tools.append(this.search, this.filters);
      this.root.before(heading);
      this.root.querySelector('.section-header').after(tools, this.status);
      const form = this.root.querySelector('#pr-tab .start-review-section');
      if (form) {
        const launcher = element('details', null, { class: 'workspace-open-review' });
        launcher.open = new URLSearchParams(location.search).has('reviewUrl');
        form.before(launcher);
        launcher.append(element('summary', 'Open a pull request by URL'), form);
        this.root.querySelector('#pr-tab').append(launcher);
      }
    }

    scan() {
      const restoreFocus = this.selected && !this.selected.row.isConnected && document.activeElement === document.body;
      for (const [row, record] of this.records) if (!row.isConnected || !row.classList.contains('delete-confirm-row') && !record.approvals.isConnected) {
        this.observer.unobserve(row); this.records.delete(row);
      }
      for (const row of this.root.querySelectorAll('tbody tr')) {
        if (this.records.has(row) || row.classList.contains('delete-confirm-row')) continue;
        const repository = row.dataset.owner ? `${row.dataset.owner}/${row.dataset.repo}` : row.querySelector('.col-repo')?.textContent.trim();
        const number = Number(row.dataset.number || row.querySelector('.col-pr')?.textContent.match(/\d+/)?.[0]);
        const title = row.querySelector('.col-title, .col-local-name');
        const local = !!row.dataset.sessionId;
        if (!repository || !number && !local || !title) continue;
        title.querySelector('.workspace-row-state')?.remove();
        const link = row.querySelector('.col-pr a');
        const host = row.dataset.host || (link ? new URL(link.href).searchParams.get('host') : null);
        const record = { row, repository, number, host, local, title: title.textContent, key: local ? `local:${row.dataset.sessionId}` : `${hostIdentity(host)}:${repository.toLowerCase()}#${number}` };
        const summary = element('div', null, { class: 'workspace-row-state' });
        record.badge = element('span', '', { class: 'workspace-review-badge', hidden: '' });
        record.approvals = element('button', 'Approvals not fetched', { type: 'button', 'aria-haspopup': 'dialog' });
        record.checks = element('button', 'CI not fetched', { type: 'button', 'aria-haspopup': 'dialog' });
        record.reason = element('span', 'Responsibility not fetched');
        record.activity = element('button', 'Not AI reviewed', { type: 'button', class: 'workspace-ai-pill', 'aria-haspopup': 'dialog' });
        record.draft = element('span');
        record.next = element('a', 'Inspect next action', { class: 'workspace-next-action', href: local ? `/local/${row.dataset.sessionId}` : link?.href || '#' });
        if (local) { record.approvals.textContent = 'Inspect local review'; record.checks.hidden = true; record.reason.textContent = 'Local only'; }
        for (const button of [record.approvals, record.checks]) button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.inspect(record); });
        record.activity.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.showAIHistory(record); });
        summary.append(record.badge, record.next, record.approvals, record.checks, record.reason, record.activity, record.draft);
        title.append(summary);
        row.tabIndex = 0;
        this.records.set(row, record);
        this.observer.observe(row);
        row.querySelector('.btn-delete-review')?.setAttribute('aria-label', 'Remove local history and drafts');
      }
      this.updateFilterOptions();
      this.renderRows();
      this.applyFilters();
      this.sortRows();
      if (this.selected?.row.isConnected) this.selected = this.records.get(this.selected.row) || this.selected;
      if (restoreFocus) {
        const replacement = [...this.records.values()].find(record => record.key === this.selected.key && record.row.getClientRects().length);
        if (replacement) (replacement.row.querySelectorAll('a,button,input,select')[this.focusIndex] || replacement.row).focus({ preventScroll: true });
      }
    }

    local(record) {
      return this.workspace.reviews.find(review => record.local
        ? review.reviewType === 'local' && String(review.id) === record.row.dataset.sessionId
        : review.reviewType !== 'local' && review.repository.toLowerCase() === record.repository.toLowerCase()
          && review.number === record.number && hostIdentity(review.host) === hostIdentity(record.host));
    }

    updateFilterOptions() {
      for (const [select, label, values] of [
        [this.repository, 'All repositories', [...this.records.values()].map(record => record.repository)],
        [this.author, 'All authors', [...this.records.values()].map(record => record.row.querySelector('.col-author')?.textContent.trim()).filter(Boolean)]
      ]) {
        const selected = select.value;
        const options = [...new Set(values)].sort();
        if (selected && !options.includes(selected)) options.push(selected);
        select.replaceChildren(element('option', label, { value: '' }), ...options.map(value => element('option', value, { value })));
        select.value = selected;
      }
    }

    sortRows(explicit = false) {
      if (!explicit && this.orderLocked) return;
      const rank = record => record.viewerApproved && !this.local(record)?.draftCount ? 4
        : hasDraft(this.local(record)) ? 0
          : record.snapshot?.viewer?.requestedDirectly || record.snapshot?.viewer?.effectiveReview?.state === 'CHANGES_REQUESTED' && record.snapshot.viewer.newRevision ? 1
            : record.snapshot?.viewer?.requestedViaTeam ? 2 : 3;
      for (const tbody of this.root.querySelectorAll('tbody')) {
        const current = [...tbody.children];
        const sorted = current.filter(row => this.records.has(row)).sort((a, b) => {
          const ra = this.records.get(a), rb = this.records.get(b);
          return rank(ra) - rank(rb) || String(this.local(ra)?.updatedAt || '').localeCompare(String(this.local(rb)?.updatedAt || '')) || ra.key.localeCompare(rb.key);
        });
        if (!sorted.every((row, index) => row === current[index])) for (const row of sorted) tbody.append(row);
      }
    }

    refreshVisible() {
      if (document.hidden || !navigator.onLine) return;
      for (const record of this.records.values()) {
        if (record.local || record.queued || !record.row.getClientRects().length) continue;
        const rect = record.row.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > innerHeight) continue;
        const age = Date.now() - (this.cache.get(record.key)?.at || 0);
        if (record.force || age > (record.snapshot?.checks?.counts?.pending ? 30000 : 60000)) { record.queued = true; this.queue.push(record); }
      }
      this.drain();
    }

    async drain() {
      if (document.hidden || !navigator.onLine) return;
      while (this.inFlight < 3 && this.queue.length) {
        const record = this.queue.shift();
        if (!record.row.isConnected) continue;
        this.inFlight++;
        const force = record.force;
        record.force = false;
        this.load(record, force).finally(() => {
          record.queued = false;
          this.inFlight--;
          if (record.force) this.refreshVisible();
          this.drain();
        });
      }
    }

    async load(record, refresh = false) {
      if (record.local) return { availability: 'local', headSha: this.local(record)?.headSha };
      const head = this.local(record)?.headSha || null;
      let entry = this.cache.get(record.key);
      if (!entry) {
        entry = { at: 0, value: null, reads: 0 };
        this.cache.set(record.key, entry);
      }
      if (entry.promise && entry.head === head && (!refresh || entry.refresh)) return entry.promise;
      if (!entry.promise && !refresh && entry.value && Date.now() - entry.at < 60000 && (!head || entry.value.headSha === head)) {
        record.snapshot = entry.value;
        this.render(record);
        this.applyFilters();
        this.sortRows();
        return entry.value;
      }
      const owner = {};
      entry.owner = owner;
      entry.head = head;
      entry.refresh = refresh;
      entry.reads++;
      entry.promise = (async () => {
        let value;
        try {
          const params = new URLSearchParams();
          if (record.host) params.set('host', record.host);
          if (refresh) params.set('refresh', 'true');
          if (head) params.set('headSha', head);
          const response = await fetch(`/api/pr/${record.repository.split('/').map(encodeURIComponent).join('/')}/${record.number}/snapshot?${params}`);
          if (!response.ok) throw new Error(`Evidence unavailable (${response.status})`);
          value = await response.json();
        } catch (error) {
          value = { ...entry.value, availability: entry.value?.headSha ? 'stale' : 'unavailable', error: error.message };
        }
        // Queue, inspector and duplicate rows share one owner for this target.
        // Superseded reads may finish, but cannot overwrite fresh data or errors.
        if (entry.owner !== owner) return entry.promise || entry.value;
        if (this.cache.get(record.key) !== entry) return { availability: 'unavailable', error: 'Evidence context changed. Refresh to read the current target.' };
        entry.value = value;
        entry.at = Date.now();
        for (const current of this.records.values()) if (current.key === record.key && current.row.isConnected) {
          current.snapshot = value;
          this.render(current);
        }
        this.applyFilters();
        this.sortRows();
        return value;
      })().finally(() => {
        entry.reads--;
        if (entry.owner === owner) entry.promise = null;
        for (const [key, cached] of this.cache) {
          if (this.cache.size <= 512) break;
          if (!cached.reads) this.cache.delete(key);
        }
      });
      return entry.promise;
    }

    renderRows() { for (const record of this.records.values()) this.render(record); }
    render(record) {
      const s = record.snapshot;
      const local = this.local(record);
      const write = (node, value) => { if (node.textContent !== value) node.textContent = value; };
      const stale = s?.availability === 'stale' || s?.fetchedAt && Date.now() - new Date(s.fetchedAt).getTime() > 120000;
      const partialReviews = s?.approvals?.availability === 'partial';
      const viewerState = s?.viewer?.effectiveReview?.state
        || (local?.status === 'submitted' ? (local.submittedEvent === 'APPROVE' ? 'APPROVED' : local.submittedEvent) : null);
      const viewerApproved = viewerState === 'APPROVED' && !s?.viewer?.newRevision;
      const viewerChangesRequested = viewerState === 'CHANGES_REQUESTED' && !s?.viewer?.newRevision;
      record.viewerApproved = viewerApproved;
      record.row.dataset.viewerApproved = viewerApproved ? 'true' : 'false';
      if (record.badge) {
        if (viewerApproved) {
          record.badge.hidden = false;
          record.badge.dataset.status = 'approved';
          write(record.badge, 'Approved by you');
        } else if (viewerChangesRequested) {
          record.badge.hidden = false;
          record.badge.dataset.status = 'changes-requested';
          write(record.badge, 'Changes requested');
        } else {
          record.badge.hidden = true;
          record.badge.removeAttribute('data-status');
          write(record.badge, '');
        }
      }
      if (s) {
        const approving = s.approvals?.approving?.map(person => person.reviewer?.name || person.reviewer?.login || person.login).filter(Boolean) || [];
        write(record.approvals, `${stale ? 'Stale: ' : ''}${partialReviews ? 'Review history partial · approvals unknown' : s.approvals?.observedCount == null ? 'Approvals unavailable' : `${s.approvals.observedCount} approved${approving.length ? ` · ${approving.join(', ')}` : ''}${s.approvals.requiredCount == null ? '' : ` · ${s.approvals.requiredCount} required`}`}`);
        write(record.checks, `${stale ? 'Stale: ' : ''}${checkLabel(s.checks)}`);
        record.checks.dataset.tone = !stale && (s.checks?.counts?.failed || s.checks?.counts?.actionRequired) ? 'error' : !stale && s.checks?.counts?.passed && !s.checks?.counts?.pending ? 'good' : '';
        const reasonText = s.viewer?.reason || 'Review responsibility unavailable';
        write(record.reason, viewerApproved && reasonText.startsWith('You already approved') ? '' : `${stale ? 'Last observed: ' : ''}${reasonText}`);
        record.checks.title = `Head ${s.headSha || 'unknown'} · fetched ${s.fetchedAt ? new Date(s.fetchedAt).toLocaleString() : 'never'}`;
      }
      const run = this.runs?.filter(run => run.reviewId === local?.id).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
      const latestAi = local?.latestAiRun || run || null;
      const aiRunCount = Math.max(Number(local?.aiRunCount || 0), run ? 1 : 0);
      const isAiRunning = Boolean(run && ['starting', 'queued', 'running', 'cancellation_requested'].includes(run.status));
      record.aiReviewed = Boolean(aiRunCount > 0 || (latestAi && latestAi.status === 'completed'));
      if (isAiRunning) {
        record.activity.dataset.aiState = 'running';
        write(record.activity, `AI reviewing \u00B7 ${run.stage || run.status.replaceAll('_', ' ')}`);
      } else if (latestAi && aiRunCount > 0) {
        const status = latestAi.status || 'completed';
        const count = Number(latestAi.totalSuggestions ?? latestAi.suggestionsCount ?? 0);
        const modelLabel = [latestAi.provider, latestAi.model].filter(Boolean).join('/');
        const runsLabel = aiRunCount > 1 ? ` \u00B7 ${aiRunCount} runs` : '';
        if (status === 'completed') {
          record.activity.dataset.aiState = 'reviewed';
          write(record.activity, `AI reviewed \u00B7 ${count === 0 ? '0 findings' : `${count} finding${count === 1 ? '' : 's'}`}${modelLabel ? ` \u00B7 ${modelLabel}` : ''}${runsLabel}`);
        } else {
          record.activity.dataset.aiState = status === 'failed' ? 'error' : 'reviewed';
          write(record.activity, `AI ${status.replaceAll('_', ' ')}${modelLabel ? ` \u00B7 ${modelLabel}` : ''}${runsLabel}`);
        }
      } else {
        record.activity.dataset.aiState = 'unreviewed';
        write(record.activity, 'Not AI reviewed');
      }
      const hasActiveDraft = viewerApproved ? Number(local?.draftCount) > 0 : hasDraft(local);
      write(record.draft, hasActiveDraft ? draftLabel(local) : '');
      write(record.next, hasActiveDraft ? 'Preview saved draft' : record.local ? 'Continue local review'
        : viewerApproved ? 'View review'
        : !s || stale ? 'Inspect available evidence' : s.viewer?.self ? 'Inspect your pull request'
          : s.viewer?.requestedDirectly || s.viewer?.effectiveReview?.state === 'CHANGES_REQUESTED' && s.viewer.newRevision ? 'Review requested changes'
            : s.viewer?.effectiveReview?.state === 'CHANGES_REQUESTED' ? 'Check author updates'
              : s.viewer?.requestedViaTeam ? 'Inspect team request' : 'Open review');
      if (local?.url) record.next.href = local.url;
    }

    applyFilters(explicit = false) {
      const query = this.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let visible = 0;
      let unknown = 0;
      let deferred = 0;
      const protectedRow = this.root.querySelector('tr:hover') || document.activeElement.closest('tr');
      const holdMembership = !explicit && protectedRow && this.root.contains(protectedRow);
      for (const record of this.records.values()) {
        const s = record.snapshot;
        const local = this.local(record);
        const unavailable = !record.local && (!s || ['stale', 'unavailable'].includes(s.availability) || s.fetchedAt && Date.now() - new Date(s.fetchedAt).getTime() > 120000);
        const matches = filter => {
          if (filter === 'all') return true;
          if (filter === 'unapproved') return !record.viewerApproved;
          if (filter === 'approved') return Boolean(record.viewerApproved);
          if (filter === 'ai-unreviewed') return !record.aiReviewed;
          if (filter === 'ai-reviewed') return Boolean(record.aiReviewed);
          if (filter === 'drafts') return local ? hasDraft(local) : null;
          if (filter === 'running') return this.runs?.some(run => run.reviewId === local?.id && ['starting', 'queued', 'running', 'cancellation_requested'].includes(run.status)) ?? null;
          if (filter === 'completed') return Boolean(record.aiReviewed);
          if (filter === 'changed' && local?.lastReviewedHead) {
            const head = record.local ? local.headSha : !unavailable ? s?.headSha : null;
            return head ? head !== local.lastReviewedHead : null;
          }
          if (record.local) return filter === 'needs-you' ? local ? hasDraft(local) : null : filter === 'unknown' ? !local : false;
          if (filter === 'unknown') return unavailable || s?.viewer?.needsYou == null
            || ['approvals', 'requests', 'checks', 'policy', 'threads'].some(section => s?.[section]?.availability !== 'known');
          if (unavailable) return null;
          if (['needs-you', 'individual', 'teams'].includes(filter) && (s.merged || s.state === 'closed')) return false;
          if (filter === 'needs-you') return s.viewer?.self ? false : s.viewer?.needsYou == null ? null
            : !!(s.viewer.requestedDirectly || s.viewer.effectiveReview?.state === 'CHANGES_REQUESTED' || s.viewer.pendingReview || hasDraft(local));
          if (filter === 'individual') return s.viewer?.requestedDirectly ?? null;
          if (filter === 'teams') return s.viewer?.requestedViaTeam ?? null;
          if (filter === 'pr-draft') return s.draft;
          if (filter === 'pr-ready') return !s.draft;
          if (filter === 'failed-ci') {
            const counts = s.checks?.counts;
            if (!counts) return null;
            if (counts.failed || counts.actionRequired || counts.cancelled) return true;
            return s.checks.availability === 'known' ? false : null;
          }
          if (filter === 'changed') return s.viewer?.newRevision ?? null;
          return true;
        };
        const primary = matches(this.primary);
        const secondary = matches(this.view.value);
        const author = record.row.querySelector('.col-author')?.textContent.trim() || s?.author?.login || '';
        const text = `${record.repository} ${record.local ? 'local' : `#${record.number}`} ${record.title} ${author}`.toLowerCase();
        const hidden = primary === false || secondary === false || (this.hideApproved && record.viewerApproved && this.view.value !== 'approved') || !query.every(term => text.includes(term))
          || !!this.repository.value && record.repository !== this.repository.value || !!this.author.value && author !== this.author.value;
        if (holdMembership && record.row.hidden !== hidden) deferred++;
        else record.row.hidden = hidden;
        if (!record.row.hidden && record.row.closest('.tab-pane')?.classList.contains('active')) {
          visible++;
          if (primary == null || secondary == null || unavailable) unknown++;
        }
      }
      const message = `${visible} ${deferred ? 'displayed' : 'matching'} loaded review${visible === 1 ? '' : 's'}${unknown ? ` · ${unknown} with unknown or stale evidence kept visible` : ''}.${deferred ? ` ${deferred} filter updates held to keep your target stable; reapply a filter when ready.` : ''} Filters apply to loaded reviews; Show more includes older entries when available.`;
      if (this.status.textContent !== message) this.status.textContent = message;
      const filterCount = Number(!!this.repository.value) + Number(!!this.author.value) + Number(this.view.value !== 'all');
      this.filterSummary.textContent = `Filters and order${filterCount ? ` · ${filterCount} active` : ''}`;
      window.dispatchEvent(new CustomEvent('workspaceFilterChanged'));
      const clearableIds = [...this.records.values()]
        .filter(r => r.viewerApproved && r.row.dataset.reviewId && !(Number(this.local(r)?.draftCount) > 0))
        .map(r => Number(r.row.dataset.reviewId));
      if (this.clearApprovedBtn) {
        this.clearApprovedBtn.hidden = clearableIds.length === 0;
        this.clearApprovedBtn.textContent = `Clear approved (${clearableIds.length})`;
      }
    }


    async clearApprovedReviews() {
      const ids = [...this.records.values()]
        .filter(r => r.viewerApproved && r.row.dataset.reviewId && !(Number(this.local(r)?.draftCount) > 0))
        .map(r => Number(r.row.dataset.reviewId));
      if (!ids.length) return;
      this.clearApprovedBtn.disabled = true;
      try {
        const response = await fetch('/api/worktrees/bulk-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not clear approved reviews');
        for (const record of this.records.values()) {
          if (ids.includes(Number(record.row.dataset.reviewId))) {
            record.row.remove();
          }
        }
        this.scan();
        window.toast?.success(`Cleared ${data.deleted || ids.length} approved review${(data.deleted || ids.length) === 1 ? '' : 's'} from inbox.`);
      } catch (error) {
        window.toast?.error(`Clear approved failed: ${error.message}`);
      } finally {
        this.clearApprovedBtn.disabled = false;
      }
    }

    async showAIHistory(record) {
      const local = this.local(record);
      const prUrl = record.local ? `/local/${record.row.dataset.sessionId}` : `/pr/${record.repository.split('/').map(encodeURIComponent).join('/')}/${record.number}${record.host ? `?host=${encodeURIComponent(record.host)}` : ''}`;
      if (!this.aiHistoryModal) {
        this.aiHistoryModal = this.workspace.makeDialog('workspace-ai-history-modal', 'AI review history');
        this.aiHistoryBody = element('div', null, { class: 'workspace-run-list' });
        this.aiHistoryModal.append(this.aiHistoryBody);
      }
      this.aiHistoryModal.querySelector('h2').textContent = `AI review history \u00B7 ${record.repository}${record.local ? '' : ` #${record.number}`}`;
      this.aiHistoryBody.replaceChildren(element('p', 'Loading historic AI analysis runs\u2026', { class: 'workspace-muted' }));
      this.workspace.open(this.aiHistoryModal);

      if (!local?.id) {
        this.aiHistoryBody.replaceChildren(
          element('p', 'No AI analysis has been run on this pull request yet.'),
          element('a', 'Open and analyze pull request', { href: `${prUrl}${prUrl.includes('?') ? '&' : '?'}analyze=true`, class: 'workspace-next-action' })
        );
        return;
      }

      try {
        const response = await fetch(`/api/analyses/runs?reviewId=${local.id}`);
        const data = await response.json();
        const runs = data.runs || [];
        this.aiHistoryBody.replaceChildren();
        if (!runs.length) {
          this.aiHistoryBody.append(
            element('p', 'No AI analysis runs recorded for this review yet.'),
            element('a', 'Open and analyze pull request', { href: `${prUrl}${prUrl.includes('?') ? '&' : '?'}analyze=true`, class: 'workspace-next-action' })
          );
          return;
        }
        runs.forEach((run, idx) => {
          const card = element('article', null, { class: 'workspace-run', 'data-state': run.status || 'completed' });
          const count = Number(run.total_suggestions || 0);
          const header = element('p');
          const badge = element('strong', idx === 0 ? `Latest (#${runs.length})` : `Run #${runs.length - idx}`);
          const meta = element('span', ` \u00B7 ${[run.provider, run.model].filter(Boolean).join('/')} \u00B7 ${count === 0 ? '0 findings' : `${count} finding${count === 1 ? '' : 's'}`} \u00B7 ${run.completed_at || run.started_at || ''}${run.head_sha ? ` \u00B7 @${String(run.head_sha).slice(0, 7)}` : ''}`);
          header.append(badge, meta);
          card.append(header);
          if (run.summary) {
            card.append(element('p', run.summary, { class: 'workspace-muted' }));
          }
          const openLink = element('a', `Open this AI review run (${count === 0 ? '0 findings' : `${count} findings`})`, {
            href: `${prUrl}${prUrl.includes('?') ? '&' : '?'}runId=${encodeURIComponent(run.id)}`
          });
          card.append(openLink);
          this.aiHistoryBody.append(card);
        });
      } catch (error) {
        this.aiHistoryBody.replaceChildren(element('p', `Could not load AI history: ${error.message}`, { role: 'alert' }));
      }
    }
    onKey(event) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.target.closest('input,textarea,select,button,a,[contenteditable]')) return;
      const rows = [...this.records.keys()].filter(row => row.getClientRects().length);
      const index = rows.indexOf(event.target.closest('tr'));
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'j' ? 1 : -1)))]?.focus();
      } else if (event.key === 'Enter' && this.records.has(event.target)) { event.preventDefault(); this.inspect(this.records.get(event.target)); }
    }

    async inspect(record, refresh = false) {
      if (!record) return;
      this.selected = record;
      const generation = this.inspectGeneration = (this.inspectGeneration || 0) + 1;
      if (!this.inspector) {
        this.inspector = this.workspace.makeDialog('workspace-review-inspector', 'Review evidence');
        this.inspector.classList.add('workspace-inspector');
        this.inspectorBody = element('div');
        this.inspector.append(this.inspectorBody);
      }
      this.workspace.open(this.inspector);
      this.inspectorBody.replaceChildren(element('p', 'Loading read-only review evidence…'));
      const s = await this.load(record, refresh);
      if (generation !== this.inspectGeneration) return;
      window.ReviewEvidence.render(this.inspectorBody, record, s, this.local(record), () => this.inspect(record, true));
    }

  }
  const start = () => { if (window.reviewWorkspace && !window.reviewInbox) window.reviewInbox = new ReviewInbox(window.reviewWorkspace); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
