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
        if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === 1 && (node.matches?.('.select-mode-header,.tab-pane-header,.btn-select-toggle') || node.querySelector?.('.select-mode-header,.tab-pane-header,.btn-select-toggle'))))) this.placeStatus();
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
      window.addEventListener('bulkAnalysisChanged', () => { this.renderRows(); this.applyFilters(); });
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
      const refresh = this.refreshBtn = element('button', 'Refresh status', { type: 'button' });
      refresh.addEventListener('click', async () => {
        if (refresh.disabled) return;
        refresh.disabled = true;
        refresh.setAttribute('aria-busy', 'true');
        refresh.textContent = 'Refreshing status…';
        try {
          const results = await Promise.all([...this.records.values()].filter(record => !record.local && record.row.getClientRects().length).map(record => this.load(record, true)));
          this.operationStatus.textContent = results.some(result => result.availability === 'unavailable' || result.availability === 'stale')
            ? 'Some evidence could not be refreshed. Inspect unavailable rows and try again.' : 'Visible evidence refreshed.';
        } finally {
          refresh.disabled = false;
          refresh.removeAttribute('aria-busy');
          refresh.textContent = 'Refresh status';
        }
      });
      this.sort = element('button', 'Sort by next action', { type: 'button', title: 'Drafts and personal requests first, then waiting items; oldest activity breaks ties. Background updates stop reordering once you interact.' });
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
      this.status = element('p', '', { class: 'workspace-muted workspace-results-status', role: 'status', 'aria-live': 'polite' });
      this.operationStatus = element('p', '', { class: 'workspace-muted workspace-operation-status', role: 'status', 'aria-live': 'polite' });
      this.requestDateNotice = element('p', '', { class: 'workspace-muted workspace-operation-status', role: 'status', 'aria-live': 'polite' });
      this.filters = element('details', null, { class: 'workspace-filters' });
      this.filterSummary = element('summary', 'Filters and order');
      const options = element('div', null, { class: 'workspace-filter-options' });
      const labelled = (text, control) => { const label = element('label', text); label.append(control); return label; };
      options.append(labelled('Repository', this.repository), labelled('Author', this.author), labelled('Review state', this.view), this.hideApprovedBtn, this.clearApprovedBtn, refresh, this.sort);
      this.filters.append(this.filterSummary, options);
      const wide = matchMedia('(min-width: 769px)');
      this.filters.open = wide.matches;
      wide.addEventListener('change', () => { this.filters.open = wide.matches; });
      const searchLabel = labelled('Search', this.search);
      searchLabel.className = 'workspace-search-field';
      tools.append(searchLabel, this.filters);
      this.root.before(heading);
      this.root.querySelector('.section-header').after(tools, this.status, this.requestDateNotice, this.operationStatus);
      const form = this.root.querySelector('#pr-tab .start-review-section');
      if (form) {
        const launcher = element('details', null, { class: 'workspace-open-review' });
        launcher.open = new URLSearchParams(location.search).has('reviewUrl');
        form.before(launcher);
        launcher.append(element('summary', 'Open a pull request by URL'), form);
        this.root.querySelector('#pr-tab').append(launcher);
      }
    }

    placeStatus() {
      const header = this.root.querySelector('.tab-pane.active .select-mode-header, .tab-pane.active .tab-pane-header');
      if (header) {
        header.classList.add('workspace-results-header');
        if (this.status.parentElement !== header) header.prepend(this.status);
      } else {
        const tools = this.root.querySelector('.workspace-inbox-tools');
        if (this.status.previousElementSibling !== tools) tools.after(this.status);
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
        const lane = name => row.querySelector(`.col-${name}`);
        if (!repository || !number && !local || !title || !lane('ai') || !lane('state') || !lane('actions') || !local && !lane('requested')) continue;
        for (const cell of row.querySelectorAll('.col-ai, .col-state, .col-requested')) cell.replaceChildren();
        row.querySelector('.col-actions .workspace-next-action')?.remove();
        const link = row.querySelector('.col-pr a');
        const host = row.dataset.host || (link ? new URL(link.href).searchParams.get('host') : null);
        const record = { row, repository, number, host, local, title: title.textContent, key: local ? `local:${row.dataset.sessionId}` : `${hostIdentity(host)}:${repository.toLowerCase()}#${number}` };
        const summary = element('div', null, { class: 'workspace-row-state' });
        record.requested = local ? null : element('time', 'Request history not fetched');
        record.requestContext = local ? null : element('div', '', { class: 'inbox-secondary' });
        record.model = element('div', '', { class: 'inbox-secondary' });
        record.badge = element('span', '', { class: 'workspace-review-badge', hidden: '' });
        record.decisions = element('span', '', { class: 'workspace-review-decisions' });
        record.approvals = element('button', 'Approvals not fetched', { type: 'button', 'aria-haspopup': 'dialog' });
        record.checks = element('button', 'CI not fetched', { type: 'button', 'aria-haspopup': 'dialog' });
        record.reason = element('span', 'Responsibility not fetched');
        record.activity = element('button', 'Not AI reviewed', { type: 'button', class: 'workspace-ai-pill', 'aria-haspopup': 'dialog' });
        record.draft = element('span');
        record.next = element('a', 'Inspect next action', { class: 'workspace-next-action', href: local ? `/local/${row.dataset.sessionId}` : link?.href || '#' });
        if (!local && !link) {
          record.next.href = `/?reviewUrl=${encodeURIComponent(row.dataset.prUrl || '')}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
          record.next.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); row.click(); });
        }
        if (local) { record.approvals.textContent = 'Inspect local review'; record.checks.hidden = true; record.reason.textContent = 'Local only'; }
        for (const button of [record.approvals, record.checks]) button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.inspect(record); });
        record.activity.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.showAIHistory(record); });
        summary.append(record.badge, record.decisions, record.approvals, record.checks, record.draft);
        lane('state').append(summary);
        lane('ai').append(record.activity, record.model);
        if (!local) lane('requested').append(record.requested, record.requestContext, record.reason);
        row.querySelector('.col-actions')?.prepend(record.next);
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
      for (const current of this.records.values()) if (current.key === record.key && !current.snapshot) {
        current.snapshot = { availability: 'loading' };
        this.render(current);
      }
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
          write(record.badge, 'Changes requested by you');
        } else {
          record.badge.hidden = true;
          record.badge.removeAttribute('data-status');
          write(record.badge, '');
        }
      }
      if (record.requested) {
        const request = s?.viewer?.reviewRequest;
        const date = request?.firstRequestedAt && new Date(request.firstRequestedAt);
        const validDate = request?.availability === 'known' && date && Number.isFinite(date.getTime());
        const missingSchema = s?.viewer && !Object.hasOwn(s.viewer, 'reviewRequest') && !['loading', 'unavailable'].includes(s.availability) && !s.error;
        const failed = s?.availability === 'unavailable' || !!s?.error;
        const reasons = {
          'incomplete-history': 'Request history is incomplete.',
          'unknown-viewer': 'Your host account could not be identified.',
          'unknown-request-target': 'A historical request has an unidentified recipient.',
          'unknown-team-membership': 'Your team membership could not be established.',
          'invalid-request-date': 'The host returned an invalid request date.',
          unauthenticated: 'Sign in to the host to load request history.',
          'rate-limited': 'The host rate limit was reached. Try refreshing later.',
          'permission-denied-or-rate-limited': 'The host denied access or rate-limited request history.',
          'not-available': 'Request history is not available from the host.',
          'offline-or-unsupported': 'The host is offline or does not support request history.'
        };
        const explanation = missingSchema ? ''
          : failed ? 'Request history could not be loaded. Refresh status to try again.'
            : request?.availability === 'known' && request.firstRequestedAt && !validDate ? reasons['invalid-request-date']
              : request?.availability !== 'known' && request ? reasons[request.reason] || 'Request history could not be established.'
                : '';
        // Scan-friendly: "Today, 11:43 AM" / "Oct 23, 11:43 AM"; the year and
        // time zone appear only when they disambiguate. Exact value stays in
        // the title and datetime attribute.
        const compactDate = d => {
          const now = new Date();
          const sameDay = d.toDateString() === now.toDateString();
          const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
          if (sameDay) return `Today, ${time}`;
          const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
          return `${day}, ${time}`;
        };
        write(record.requested, validDate
          ? `${stale ? 'Last observed: ' : ''}${compactDate(date)}`
          : missingSchema ? 'Server update needed'
            : failed || request?.availability === 'unavailable' ? 'Request date unavailable'
              : s?.availability === 'loading' ? 'Loading request history…'
                : !s ? 'Request history not fetched'
                  : request?.availability === 'known' && !request.firstRequestedAt ? 'No recorded request' : 'Request date unknown');
        record.requested.title = validDate ? `First requested: ${date.toLocaleString()} (${request.firstRequestedAt})` : explanation || record.requested.textContent;
        if (validDate) record.requested.setAttribute('datetime', request.firstRequestedAt);
        else record.requested.removeAttribute('datetime');
        write(record.requestContext, validDate ? [
          request.source === 'team' ? `Via team ${request.team?.name || request.team?.slug || '(unknown)'}` : 'Direct request to you',
          request.requestedBy?.login ? `by @${request.requestedBy.login}` : request.requestedBy?.name ? `by ${request.requestedBy.name}` : ''
        ].filter(Boolean).join(' · ') : explanation);
      }
      if (s) {
        const approving = s.approvals?.approving?.map(person => person.reviewer?.name || person.reviewer?.login || person.login).filter(Boolean) || [];
        const approvalText = `${stale ? 'Stale: ' : ''}${partialReviews ? 'Approvals unknown · partial history' : s.approvals?.observedCount == null ? 'Approvals unavailable' : `${s.approvals.observedCount} approved${s.approvals.requiredCount == null ? '' : ` / ${s.approvals.requiredCount} required`}`}`;
        write(record.approvals, approvalText);
        record.approvals.title = approving.length ? `Approvals: ${approving.join(', ')}` : approvalText;
        const counts = s.checks?.counts;
        const attention = Number(counts?.failed || 0) + Number(counts?.actionRequired || 0) + Number(counts?.cancelled || 0);
        const compactChecks = !counts || s.checks?.availability === 'unavailable' ? 'CI unavailable'
          : attention ? `CI: ${attention} need attention`
            : counts.pending ? `CI: ${counts.pending} pending`
              : `CI: ${counts.passed || 0} passed${s.checks?.availability === 'partial' ? ' · partial' : ''}`;
        write(record.checks, `${stale ? 'Stale: ' : ''}${compactChecks}`);
        record.checks.dataset.tone = !stale && (s.checks?.counts?.failed || s.checks?.counts?.actionRequired) ? 'error' : !stale && s.checks?.counts?.passed && !s.checks?.counts?.pending ? 'good' : '';
        const reasonText = s.viewer?.reason || 'Review responsibility unavailable';
        const history = s.viewer?.reviewRequest;
        const repeatsRequest = history?.availability === 'known' && history.firstRequestedAt
          && (history.source === 'direct' && s.viewer?.requestedDirectly || history.source === 'team' && s.viewer?.requestedViaTeam);
        const responsibility = repeatsRequest || viewerApproved && reasonText.startsWith('You already approved') ? '' : reasonText;
        write(record.reason, responsibility ? `${stale ? 'Last observed: ' : ''}${s.viewer?.requestedDirectly ? 'Currently requested from you' : s.viewer?.requestedViaTeam ? 'Currently requested via team' : responsibility}` : '');
        record.reason.title = reasonText;
        record.checks.title = `${checkLabel(s.checks)} · Head ${s.headSha || 'unknown'} · fetched ${s.fetchedAt ? new Date(s.fetchedAt).toLocaleString() : 'never'}`;
        const viewerLogin = s.viewer?.identity?.login;
        const changes = (s.approvals?.effective || []).filter(review => review.state === 'CHANGES_REQUESTED'
          && !(viewerChangesRequested && viewerLogin && review.reviewer?.login?.toLowerCase() === viewerLogin.toLowerCase()));
        write(record.decisions, changes.length
          ? `${stale ? 'Last observed: ' : ''}${partialReviews ? 'Observed in partial history: changes requested by ' : 'Changes requested by '}${changes.map(review => review.reviewer?.login ? `@${review.reviewer.login}` : review.reviewer?.name || 'reviewer identity unavailable').join(', ')}`
          : '');
      }
      const run = this.runs?.filter(run => run.reviewId === local?.id).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
      const savedAi = local?.latestAiRun;
      const latestAi = run && (!savedAi || run.analysisId === savedAi.id || Date.parse(run.startedAt) >= Date.parse(savedAi.startedAt))
        ? { ...(run.analysisId === savedAi?.id ? savedAi : {}), ...run, totalSuggestions: run.suggestionsCount ?? run.totalSuggestions ?? (run.analysisId === savedAi?.id ? savedAi.totalSuggestions : undefined) } : savedAi || null;
      const aiRunCount = Math.max(Number(local?.aiRunCount || 0), run ? 1 : 0);
      const actualModels = latestAi?.actualModels || [];
      const modelNames = actualModels.map(item => [item.provider, item.model].filter(Boolean).join('/')).filter(Boolean);
      write(record.model, latestAi ? modelNames.length > 1 ? `${modelNames[0]} +${modelNames.length - 1} · inspect history` : modelNames[0] || 'Model not recorded' : '');
      record.model.title = modelNames.join(', ');
      const isAiRunning = Boolean(latestAi && ['starting', 'queued', 'running', 'cancellation_requested'].includes(latestAi.status));
      record.aiReviewed = Boolean(aiRunCount > 0 || (latestAi && ['completed', 'partial'].includes(latestAi.status)));
      if (isAiRunning) {
        record.activity.dataset.aiState = 'running';
        write(record.activity, `AI reviewing \u00B7 ${latestAi.stage || latestAi.status.replaceAll('_', ' ')}`);
        record.activity.title = latestAi.stage || '';
      } else if (latestAi && aiRunCount > 0) {
        const status = latestAi.status || 'completed';
        const count = Number(latestAi.totalSuggestions ?? latestAi.suggestionsCount ?? 0);
        const findingsLabel = count === 0 ? '0 findings' : `${count} finding${count === 1 ? '' : 's'}`;
        const runsLabel = aiRunCount > 1 ? ` \u00B7 ${aiRunCount} runs` : '';
        const outcomes = latestAi.levelOutcomes || latestAi.level_outcomes;
        const failedStages = outcomes && typeof outcomes === 'object'
          ? [['level1', 'L1'], ['1', 'L1'], ['level2', 'L2'], ['2', 'L2'], ['level3', 'L3'], ['3', 'L3'], ['consolidation', 'consolidation']]
            .filter(([key]) => ['failed', 'error', 'cancelled'].includes(outcomes[key]?.status || outcomes[key]))
            .map(([, label]) => label)
          : [];
        const uniqueFailed = [...new Set(failedStages)];
        if (status === 'completed') {
          record.activity.dataset.aiState = 'reviewed';
          write(record.activity, `AI reviewed \u00B7 ${findingsLabel}${runsLabel}`);
          record.activity.title = `AI review completed (${findingsLabel})`;
        } else if (status === 'partial') {
          record.activity.dataset.aiState = 'reviewed';
          const failNote = uniqueFailed.length ? ` (${uniqueFailed.join(', ')} failed)` : '';
          write(record.activity, `AI partial \u00B7 ${findingsLabel}${failNote}${runsLabel}`);
          record.activity.title = latestAi.stage || `Finished with partial results${failNote}: ${findingsLabel}`;
        } else {
          record.activity.dataset.aiState = status === 'failed' ? 'error' : 'reviewed';
          write(record.activity, `AI ${status.replaceAll('_', ' ')}${runsLabel}`);
          record.activity.title = latestAi.stage || `AI ${status.replaceAll('_', ' ')}`;
        }
      } else {
        record.activity.dataset.aiState = 'unreviewed';
        write(record.activity, 'Not AI reviewed');
        record.activity.title = '';
      }
      const bulk = window.bulkAnalysisLauncher?.state(record.local
        ? { local: true, reviewId: record.row.dataset.sessionId }
        : { owner: record.repository.split('/')[0], repo: record.repository.split('/')[1], number: record.number, host: record.host });
      if (bulk && bulk.status !== 'completed' && (!bulk.analysisId || !latestAi || (latestAi.analysisId || latestAi.id) === bulk.analysisId)) {
        record.activity.dataset.aiState = ['failed', 'uncertain'].includes(bulk.status) ? 'error'
          : ['queued', 'preparing', 'launching', 'accepted', 'starting', 'running', 'cancellation_requested'].includes(bulk.status) ? 'running' : 'reviewed';
        write(record.activity, `AI ${bulk.message}`);
        record.activity.title = bulk.message;
        if (!bulk.analysisId || (latestAi?.analysisId || latestAi?.id) !== bulk.analysisId) {
          write(record.model, 'Execution model pending');
          record.model.title = '';
        }
      }
      const hasActiveDraft = hasDraft(local);
      write(record.draft, [s?.draft ? 'Draft pull request' : '', hasActiveDraft ? draftLabel(local) : ''].filter(Boolean).join(' · '));
      write(record.next, hasActiveDraft ? 'Preview draft' : record.local ? 'Continue local review'
        : s?.viewer?.newRevision ? 'Review new commits'
          : viewerApproved || viewerChangesRequested ? 'View review' : 'Review PR');
      if (local?.url) record.next.href = local.url;
    }

    applyFilters(explicit = false) {
      const query = this.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let visible = 0;
      let loaded = 0;
      let unknown = 0;
      let deferred = 0;
      let needsServerUpdate = false;
      const protectedRow = this.root.querySelector('tr:hover') || document.activeElement.closest('tr');
      const holdMembership = !explicit && protectedRow && this.root.contains(protectedRow);
      for (const record of this.records.values()) {
        if (record.row.closest('.tab-pane')?.classList.contains('active')) loaded++;
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
          if (!record.local && s?.viewer && !Object.hasOwn(s.viewer, 'reviewRequest') && !['loading', 'unavailable'].includes(s.availability) && !s.error) needsServerUpdate = true;
          if (primary == null || secondary == null || unavailable) unknown++;
        }
      }
      this.placeStatus();
      const message = `${visible} ${deferred ? 'displayed' : 'matching'} of ${loaded} loaded${unknown ? ` · ${unknown} with unavailable or outdated status` : ''}${deferred ? ` · ${deferred} updates held; reapply filters when ready` : ''}`;
      if (this.status.textContent !== message) this.status.textContent = message;
      const requestDateMessage = needsServerUpdate ? 'Request dates need a server restart. Finish active analyses, restart pair-review, then reload this page.' : '';
      if (this.requestDateNotice.textContent !== requestDateMessage) this.requestDateNotice.textContent = requestDateMessage;
      const filterCount = Number(!!this.repository.value) + Number(!!this.author.value) + Number(this.view.value !== 'all');
      this.filterSummary.textContent = `Filters and order${filterCount ? ` · ${filterCount} active` : ''}`;
      window.dispatchEvent(new CustomEvent('workspaceFilterChanged'));
      const clearableIds = this.approvedCandidates().map(record => Number(record.row.dataset.reviewId));
      if (this.clearApprovedBtn) {
        this.clearApprovedBtn.hidden = !this.clearingApproved && clearableIds.length === 0;
        this.clearApprovedBtn.disabled = Boolean(this.clearingApproved);
        this.clearApprovedBtn.setAttribute('aria-busy', String(Boolean(this.clearingApproved)));
        this.clearApprovedBtn.textContent = this.clearingApproved ? 'Clearing approved…' : `Clear approved (${clearableIds.length})`;
      }
    }


    approvedCandidates() {
      return [...this.records.values()].filter(record => record.viewerApproved && record.row.dataset.reviewId);
    }

    async clearApprovedReviews() {
      if (this.clearingApproved) return;
      const candidates = this.approvedCandidates();
      const ids = [...new Set(candidates.map(record => Number(record.row.dataset.reviewId)))];
      if (!ids.length) return;
      this.clearingApproved = true;
      this.applyFilters();
      const context = this.workspace.contextVersion;
      try {
        const unique = [...new Map(candidates.map(record => [record.row.dataset.reviewId, record])).values()];
        const comments = unique.reduce((count, record) => count + Number(this.local(record)?.draftCount || 0), 0);
        const summaries = unique.filter(record => this.local(record)?.hasDraftSummary).length;
        const targets = unique.map(record => `${record.repository} #${record.number}${record.host ? ` (${record.host})` : ''}`).join('\n');
        const confirmed = await window.confirmDialog.show({
          title: 'Clear approved local reviews?',
          message: `Remove local history and saved drafts for ${ids.length} approved review${ids.length === 1 ? '' : 's'}? This includes ${comments} saved comment${comments === 1 ? '' : 's'} and ${summaries} saved review summar${summaries === 1 ? 'y' : 'ies'} (body or decision). Remote reviews stay unchanged. Active work is not cancelled; shared checkouts may be retained.\n\n${targets}`,
          confirmText: 'Remove local history and drafts'
        });
        if (confirmed !== 'confirm' || context !== this.workspace.contextVersion) return;
        const errors = [], warnings = [], removed = new Set();
        for (let offset = 0; offset < ids.length; offset += 50) {
          const batch = ids.slice(offset, offset + 50);
          try {
            const response = await fetch('/api/worktrees/bulk-delete', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch })
            });
            const data = await response.json();
            if (context !== this.workspace.contextVersion) return;
            if (!response.ok) throw new Error(data.error || 'Could not clear approved reviews');
            const failed = new Set((data.errors || []).map(item => Number(item.id)));
            errors.push(...(data.errors || []));
            warnings.push(...(data.warnings || []));
            for (const id of batch) if (!failed.has(id)) removed.add(id);
          } catch (error) {
            errors.push(...batch.map(id => ({ id, error: error.message })));
          }
        }
        for (const record of this.records.values()) if (removed.has(Number(record.row.dataset.reviewId))) record.row.remove();
        this.scan();
        this.cleanupResults?.remove();
        this.cleanupResults = element('section', null, { class: 'bulk-removal-results', role: 'status', 'aria-live': 'polite' });
        this.cleanupResults.append(element('p', `Removed ${removed.size} approved local review${removed.size === 1 ? '' : 's'}; retained ${ids.length - removed.size}. Remote reviews unchanged.`));
        const list = element('ul');
        for (const item of [...errors.map(item => ({ ...item, message: `Retained — ${item.error}` })), ...warnings]) {
          const target = unique.find(record => Number(record.row.dataset.reviewId) === Number(item.id));
          list.append(element('li', `${target ? `${target.repository} #${target.number}` : `Review ${item.id}`}: ${item.message}`));
        }
        if (list.childNodes.length) this.cleanupResults.append(list);
        this.status.after(this.cleanupResults);
        await Promise.all([this.workspace.loadReviews(), window.refreshRecentReviews?.()]);
      } catch (error) {
        window.toast?.error(`Clear approved failed: ${error.message}`);
        this.operationStatus.textContent = `Clear approved failed: ${error.message}. Try again.`;
      } finally {
        this.clearingApproved = false;
        this.applyFilters();
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
        if (!response.ok) throw new Error(data.error || `History unavailable (${response.status})`);
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
          const outcomes = run.level_outcomes && typeof run.level_outcomes === 'object' ? run.level_outcomes : null;
          const stageSummary = outcomes
            ? [['level1', 'Level 1'], ['level2', 'Level 2'], ['level3', 'Level 3'], ['consolidation', 'Consolidation']]
              .filter(([key]) => key in outcomes)
              .map(([key, label]) => `${label}: ${outcomes[key]?.status || outcomes[key]}`)
            : [];
          const hasStageFailure = Boolean(outcomes && Object.values(outcomes).some(val => ['failed', 'error', 'cancelled'].includes(val?.status || val)));
          const displayStatus = run.status === 'completed' && hasStageFailure ? 'partial' : (run.status || 'completed');
          const card = element('article', null, { class: 'workspace-run', 'data-state': displayStatus });
          const count = Number(run.total_suggestions || 0);
          const header = element('p');
          const badge = element('strong', idx === 0 ? `Latest (#${runs.length})` : `Run #${runs.length - idx}`);
          const actual = run.actualModels?.length ? run.actualModels.map(item => [item.provider, item.model].filter(Boolean).join('/')).join(', ') : 'model not recorded';
          const statusNote = displayStatus !== 'completed' ? ` \u00B7 ${displayStatus}` : '';
          const meta = element('span', `${statusNote} \u00B7 ${actual} \u00B7 ${count === 0 ? '0 findings' : `${count} finding${count === 1 ? '' : 's'}`} \u00B7 ${run.completed_at || run.started_at || ''}${run.head_sha ? ` \u00B7 @${String(run.head_sha).slice(0, 7)}` : ''}`);
          header.append(badge, meta);
          card.append(header);
          if (stageSummary.length && hasStageFailure) {
            card.append(element('p', `Stages \u2014 ${stageSummary.join(' \u00B7 ')}`, { class: 'workspace-muted' }));
          }
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
