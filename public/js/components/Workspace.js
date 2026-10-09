// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
(() => {
  'use strict';
  const settled = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
  const node = (tag, text, attributes = {}) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  const json = async (url, options) => {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  };
  const post = (url, body = {}) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const age = (date, end) => {
    if (!date) return 'not observed';
    const seconds = Math.max(0, Math.floor(((end ? new Date(end).getTime() : Date.now()) - new Date(date).getTime()) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  const runUrl = run => run.reviewType === 'local' ? `/local/${run.reviewId}`
    : `/pr/${run.repository.split('/').map(encodeURIComponent).join('/')}/${run.prNumber}${run.host ? `?host=${encodeURIComponent(run.host)}` : ''}`;

  class Workspace {
    constructor() {
      this.runs = new Map();
      this.activityEvents = null;
      this.reviews = [];
      this.contextVersion = 0;
      this.evidenceGeneration = 0;
      this.commands = new Map();
      this.available = false;
      this.isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      const pr = location.pathname.match(/^\/pr\/([^/]+)\/([^/]+)\/(\d+)\/?$/);
      const local = location.pathname.match(/^\/local\/(\d+)\/?$/);
      this.currentTarget = pr ? { repository: `${decodeURIComponent(pr[1])}/${decodeURIComponent(pr[2])}`, number: Number(pr[3]), host: new URLSearchParams(location.search).get('host'), local: false }
        : local ? { reviewId: Number(local[1]), local: true, repository: 'Local review' } : null;
      this.shortcutHint = `${this.isMac ? '⌘' : 'Ctrl+'}K`;
      this.buildShell();
      this.registerCommands();
      this.keyHandler = event => this.onKey(event);
      document.addEventListener('keydown', this.keyHandler, true);
      window.wsClient?.subscribe('index:analyses', message => {
        if (message.type === 'subscribed') { this.refresh().then(() => this.refresh()); return; }
        if (message.type !== 'activity' || message.run?.parentRunId) return;
        if (this.identity && ((message.dbId && message.dbId !== this.identity.dbId)
          || (message.instanceId && message.instanceId !== this.identity.instanceId))) return;
        const current = this.runs.get(message.run.analysisId);
        if (current && current.sequence >= message.run.sequence) return;
        this.runs.set(message.run.analysisId, { ...message.run, observation: settled.has(message.run.status) ? 'recorded' : 'live' });
        this.activityEvents?.add(message.run.analysisId);
        this.renderActivity();
        this.notify(message.run);
      });
      window.wsClient?.connect();
      window.addEventListener('wsConnected', () => this.refresh());
      window.addEventListener('wsDisconnected', () => { this.available = false; this.renderActivity(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
      window.addEventListener('pageshow', () => this.refresh());
      window.addEventListener('pagehide', () => clearTimeout(this.timer));
      window.addEventListener('reviewProgressChanged', async () => {
        const context = this.contextVersion;
        await Promise.all([this.reviewLoad, this.currentEvidenceLoad]);
        if (context !== this.contextVersion) return;
        this.reviewsAt = 0;
        this.currentEvidenceAt = 0;
        await this.loadReviews();
      });
      this.refresh();
    }

    buildShell() {
      this.rail = node('nav', null, { class: 'workspace-rail', 'aria-label': 'Review workspace' });
      this.activityButton = node('button', 'Connecting to activity…', { type: 'button', 'aria-haspopup': 'dialog', class: 'workspace-activity-button' });
      this.activityButton.addEventListener('click', () => this.showActivity());
      const commands = node('button', `Commands ${this.shortcutHint}`, { type: 'button', 'aria-haspopup': 'dialog', 'aria-keyshortcuts': `${this.isMac ? 'Meta' : 'Control'}+K` });
      commands.addEventListener('click', () => this.showPalette());
      this.rail.append(node('a', 'Review inbox', { href: '/' }), this.activityButton, commands);
      if (this.currentTarget) {
        const evidence = node('button', this.currentTarget.local ? 'Local context' : 'Review evidence', { type: 'button', 'aria-haspopup': 'dialog' });
        evidence.addEventListener('click', () => this.showCurrentEvidence());
        this.rail.insertBefore(evidence, commands);
      }
      document.body.append(this.rail);
      document.body.classList.add('has-workspace');

      this.drawer = this.makeDialog('workspace-activity', 'Analysis activity');
      this.activityList = node('div', null, { class: 'workspace-run-list' });
      this.identityLabel = node('p', '', { class: 'workspace-muted' });
      const notifications = node('button', 'Enable browser completion notifications', { type: 'button' });
      notifications.addEventListener('click', async () => {
        if (!('Notification' in window)) { notifications.textContent = 'Browser notifications unavailable'; return; }
        const permission = await Notification.requestPermission();
        localStorage.setItem('pair-review-completion-notifications', permission === 'granted' ? 'true' : 'false');
        notifications.textContent = permission === 'granted' ? 'Browser notifications enabled' : 'Browser notifications not permitted';
      });
      this.drawer.append(this.identityLabel, this.activityList, notifications);
      this.palette = this.makeDialog('workspace-commands', 'Commands');
      this.search = node('input', null, { type: 'search', role: 'combobox', 'aria-label': 'Search commands, reviews or a PR URL', 'aria-controls': 'workspace-command-results', 'aria-expanded': 'true', 'aria-autocomplete': 'list', autocomplete: 'off', placeholder: 'Find a review or action…' });
      this.results = node('div', null, { id: 'workspace-command-results', role: 'listbox', 'aria-label': 'Matching commands' });
      this.commandStatus = node('p', '', { role: 'status', 'aria-live': 'polite', class: 'workspace-muted' });
      this.moreReviews = node('button', 'Load older saved reviews', { type: 'button' });
      this.moreReviews.hidden = true;
      this.moreReviews.addEventListener('click', async () => {
        await this.loadReviews(true);
        this.renderCommands();
        this.search.focus();
      });
      this.palette.append(this.search, this.results, this.commandStatus, this.moreReviews,
        node('p', '↑ / ↓ choose · Enter opens · Escape closes', { class: 'workspace-muted' }));
      this.search.addEventListener('input', () => this.renderCommands(false));
      this.search.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          this.commandIndex = Math.max(0, Math.min(this.matches.length - 1, this.commandIndex + (event.key === 'ArrowDown' ? 1 : -1)));
          this.highlightCommand();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          this.execute(this.matches[this.commandIndex]);
        }
      });
    }

    makeDialog(id, title) {
      const dialog = node('dialog', null, { id, class: 'workspace-dialog', 'aria-labelledby': `${id}-title` });
      const heading = node('header');
      const close = node('button', 'Close', { type: 'button', 'aria-label': `Close ${title.toLowerCase()}` });
      close.addEventListener('click', () => dialog.close());
      heading.append(node('h2', title, { id: `${id}-title` }), close);
      dialog.append(heading);
      dialog.addEventListener('close', () => {
        const focus = dialog.returnFocus;
        const activeModal = document.activeElement?.closest(window.ModalDetection?.MODAL_SELECTORS.join(',') || 'dialog[open]');
        if (focus?.isConnected && (!activeModal || activeModal.contains(focus))) {
          focus.focus({ preventScroll: true });
          if (dialog.returnSelection && focus.setSelectionRange) focus.setSelectionRange(...dialog.returnSelection);
        }
      });
      document.body.append(dialog);
      return dialog;
    }

    open(dialog) {
      if (dialog.open) return;
      const input = document.activeElement;
      dialog.returnFocus = input;
      dialog.returnSelection = typeof input?.selectionStart === 'number' ? [input.selectionStart, input.selectionEnd] : null;
      dialog.showModal();
    }

    onKey(event) {
      if (event.isComposing || event.altKey) return;
      if ((this.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.showPalette();
      } else if (document.querySelector('.workspace-dialog[open]')) {
        // Native cancellation belongs to the topmost dialog. Do not close an
        // underlying editor or bypass its cancel/close lifecycle.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        if (event.key === 'Escape') event.stopImmediatePropagation();
      }
    }

    register(id, label, action, options = {}) { this.commands.set(id, { id, label, action, ...options }); }
    registerCommands() {
      const navigate = url => { location.href = url; };
      this.register('inbox', 'Review inbox', () => navigate('/'));
      this.register('needs-you', 'Needs you · individual review requests', () => navigate('/?tab=review-requests-tab'));
      this.register('mine', 'My pull requests', () => navigate('/?tab=my-prs-tab'));
      this.register('local', 'Local reviews', () => navigate('/?tab=local-tab'));
      this.register('drafts', 'Saved drafts · ready to preview', () => navigate('/?view=drafts'));
      this.register('activity', 'Show analysis activity', () => this.showActivity());
      this.register('protocol', 'Inspect effective review protocol', () => this.showProtocol(window.prManager?.analysisHistoryManager?.getSelectedRunId()));
      this.register('settings', 'Open settings', () => navigate('/settings'));
      this.register('theme', 'Change light / dark / system theme', () => document.querySelector('#theme-toggle')?.click());
      this.register('analyze', 'Configure analysis…', () => window.prManager.triggerAIAnalysis(), { available: () => !!window.prManager?.analysisConfigModal });
      this.register('preview', 'Open final review preview…', () => window.prManager.openReviewModal(), { available: () => !!window.prManager?.currentPR });
      this.register('next-finding', 'Jump to next unresolved finding', () => window.prManager.suggestionNavigator.goToNext(), { available: () => !!window.prManager?.suggestionNavigator });
      this.register('find-file', 'Find a file in this review', () => this.showPalette('Files'), { keepContext: true, available: () => !!document.querySelector('.file-item[data-path]') });
      this.register('changes-reviewed', 'Show changes since your reviewed revision', () => window.prManager.reviewProgress.showComparison(), { available: () => !!window.prManager?.reviewProgress });
      this.register('resume', 'Resume latest unfinished review', () => {
        const review = this.reviews.find(review => window.ReviewEvidence.hasDraft(review) || review.activity && !settled.has(review.activity.status));
        if (review) navigate(review.url);
      }, { available: () => this.reviews.some(review => window.ReviewEvidence.hasDraft(review) || review.activity && !settled.has(review.activity.status)) });
      this.register('find-review', 'Find a PR or local review', () => { this.showPalette(); this.search.placeholder = 'Search repository, title or PR number…'; }, { keepContext: true });
      this.register('inspect-review', this.currentTarget?.local ? 'Inspect local review context' : 'Inspect this review’s host evidence', () => this.showCurrentEvidence(), { available: () => !!this.currentTarget });
      this.register('open-selected', 'Open this pull request on its canonical host', () => window.ReviewEvidence.externalLink('Open pull request', this.currentSnapshot.identity.url).click(), { available: () => !!window.ReviewEvidence.externalUrl(this.currentSnapshot?.identity?.url) });
      const failing = () => window.ReviewEvidence.failingCheck(window.reviewInbox?.selected?.snapshot || this.currentSnapshot);
      this.register('failing-check', 'Open observed failing check…', () => window.ReviewEvidence.externalLink('Check details', failing().url).click(), { available: () => !!failing() });
    }

    showPalette(group = null) {
      if (this.executingCommand) return;
      this.commandGroup = group;
      this.palette.querySelector('h2').textContent = group || 'Commands';
      this.search.placeholder = group === 'Files' ? 'Find a file…' : 'Find a review or action…';
      this.moreReviews.hidden = group === 'Files' || !this.nextReviewCursor;
      this.open(this.palette);
      this.search.value = '';
      this.renderCommands(false);
      this.search.focus();
      if (group === 'Files') return;
      this.loadReviews().then(() => { if (this.palette.open) this.renderCommands(); });
      this.loadCurrentEvidence().then(() => { if (this.palette.open) this.renderCommands(); });
    }

    renderCommands(preserve = true) {
      const previous = preserve ? this.matches?.[this.commandIndex]?.id : null;
      const query = this.search.value.trim().toLowerCase();
      const candidates = [...this.commands.values(),
        ...this.reviews.map(review => ({ id: `review:${review.id}`, group: 'Reviews',
          label: `${review.repository} ${review.number ? `#${review.number}` : 'local'} · ${review.title}${window.ReviewEvidence.hasDraft(review) ? ' · saved draft' : ''}`,
          action: () => { location.href = review.url; } })),
        ...[...this.runs.values()].filter(run => !settled.has(run.status)).map(run => ({
          id: `run:${run.analysisId}`, group: 'Activity',
          label: `${run.repository} ${run.prNumber ? `#${run.prNumber}` : 'local'} · ${run.status.replaceAll('_', ' ')} · ${run.stage}`,
          action: () => { this.showActivity(); this.activityList.querySelector(`[data-run-id="${CSS.escape(run.analysisId)}"] a`)?.focus(); }
        })),
        ...Array.from(document.querySelectorAll('.file-item[data-path]')).map(file => ({
          id: `file:${file.dataset.path}`, group: 'Files', label: file.dataset.path,
          action: () => file.click()
        }))];
      const input = this.search.value.trim();
      if (/^https?:\/\//i.test(input)) candidates.unshift({ id: 'url', label: `Enter review URL: ${input}`, action: () => { location.href = `/?reviewUrl=${encodeURIComponent(input)}`; } });
      const score = label => {
        label = label.toLowerCase();
        if (label.includes(query)) return 0;
        let position = -1;
        let gaps = 1;
        for (const letter of query.replaceAll(' ', '')) {
          const next = label.indexOf(letter, position + 1);
          if (next < 0) return Infinity;
          gaps += next - position - 1;
          position = next;
        }
        return gaps;
      };
      this.matches = candidates.filter(command => (!this.commandGroup || command.group === this.commandGroup) && (!command.available || command.available()) && (command.id === 'url' || Number.isFinite(score(command.label))))
        .sort((a, b) => (a.id === 'url' ? -1 : score(a.label)) - (b.id === 'url' ? -1 : score(b.label))).slice(0, 30);
      const groups = new Map();
      for (const command of this.matches) {
        const group = command.group || 'Actions';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(command);
      }
      this.matches = [...groups.values()].flat();
      this.commandIndex = Math.max(0, this.matches.findIndex(command => command.id === previous));
      this.results.replaceChildren();
      let index = 0;
      for (const [label, commands] of groups) {
        const group = node('div', null, { role: 'group', 'aria-label': label });
        group.append(node('p', label, { class: 'workspace-muted', 'aria-hidden': 'true' }));
        for (const command of commands) {
          const result = node('div', command.label, { id: `workspace-result-${index++}`, role: 'option', 'aria-selected': 'false', class: 'workspace-command' });
          result.addEventListener('click', () => this.execute(command));
          group.append(result);
        }
        this.results.append(group);
      }
      this.commandStatus.textContent = [
        !this.matches.length ? 'No matching actions or reviews.' : '',
        this.reviewError ? `Review search unavailable: ${this.reviewError}. Cached results are retained.` : '',
        this.nextReviewCursor ? `${this.reviews.length} saved reviews loaded; load older results below to extend this search.` : ''
      ].filter(Boolean).join(' ');
      this.highlightCommand();
    }

    highlightCommand() {
      const rows = this.results.querySelectorAll('[role="option"]');
      rows.forEach((row, index) => row.setAttribute('aria-selected', String(index === this.commandIndex)));
      const selected = rows[this.commandIndex];
      if (selected) { this.search.setAttribute('aria-activedescendant', selected.id); selected.scrollIntoView({ block: 'nearest' }); }
      else this.search.removeAttribute('aria-activedescendant');
    }

    async execute(command) {
      if (!command || this.executingCommand) return;
      if (command.keepContext) { command.action(); return; }
      this.executingCommand = true;
      try {
        // Explicit navigation/action leaves the current modal context. Wait for
        // close listeners before an action can reopen an authoring dialog.
        await Promise.all([...document.querySelectorAll('.workspace-dialog[open]')].map(dialog => new Promise(resolve => {
          dialog.addEventListener('close', resolve, { once: true });
          dialog.returnFocus = null;
          dialog.close();
        })));
      } finally { this.executingCommand = false; }
      return command.action();
    }

    async loadReviews(more = false) {
      if (this.reviewLoad) return this.reviewLoad;
      if (more && !this.nextReviewCursor || !more && Date.now() - (this.reviewsAt || 0) < 30000) return;
      this.moreReviews.disabled = true;
      const context = this.contextVersion;
      const through = !more && this.reviewHistoryLoaded ? this.nextReviewCursor || 'end' : null;
      this.reviewLoad = (async () => {
        const reviews = [];
        let cursor = more ? this.nextReviewCursor : null;
        let data;
        do {
          const params = new URLSearchParams();
          if (cursor) params.set('before', cursor);
          if (through) params.set('through', through);
          data = await json(`/api/reviews/recent?${params}`);
          if (context !== this.contextVersion) return;
          reviews.push(...data.reviews);
          cursor = data.next;
        } while (through && cursor && !data.covered);
        // Publish only a complete refresh. A failed later page must not erase
        // cached history or make deleted records survive an append-only merge.
        this.reviews = [...new Map([...(more ? this.reviews : []), ...reviews].map(review => [review.id, review])).values()];
        this.nextReviewCursor = cursor;
        if (more) this.reviewHistoryLoaded = true;
        this.moreReviews.hidden = !cursor;
        this.reviewError = null;
        this.reviewsAt = Date.now();
        window.dispatchEvent(new CustomEvent('workspaceReviews', { detail: this.reviews }));
      })().catch(error => { if (context === this.contextVersion) this.reviewError = error.message; }).finally(() => {
        if (context === this.contextVersion) { this.reviewLoad = null; this.moreReviews.disabled = false; }
      });
      return this.reviewLoad;
    }

    async loadCurrentEvidence(refresh = false) {
      if (!this.currentTarget) return null;
      if (this.currentEvidenceLoad && (!refresh || this.currentEvidenceOwner.refresh)) return this.currentEvidenceLoad;
      if (!this.currentEvidenceLoad && !refresh && Date.now() - (this.currentEvidenceAt || 0) < 30000) return this.currentSnapshot;
      const owner = { refresh };
      this.currentEvidenceOwner = owner;
      this.currentEvidenceLoad = (async () => {
        await this.loadReviews();
        if (this.currentEvidenceOwner !== owner) return this.currentEvidenceLoad || this.currentSnapshot || { availability: 'unavailable' };
        const target = this.currentTarget;
        const review = this.reviews.find(review => target.local ? review.reviewType === 'local' && review.id === target.reviewId
          : review.reviewType !== 'local' && review.repository.toLowerCase() === target.repository.toLowerCase() && review.number === target.number
            && window.ReviewEvidence.hostIdentity(review.host) === window.ReviewEvidence.hostIdentity(target.host));
        let value;
        try {
          const params = new URLSearchParams();
          if (target.host) params.set('host', target.host);
          if (refresh) params.set('refresh', 'true');
          if (review?.headSha) params.set('headSha', review.headSha);
          value = target.local ? { availability: 'local' }
            : await json(`/api/pr/${target.repository.split('/').map(encodeURIComponent).join('/')}/${target.number}/snapshot?${params}`);
        } catch (error) {
          value = { ...this.currentSnapshot, availability: this.currentSnapshot?.headSha ? 'stale' : 'unavailable', error: error.message };
        }
        if (this.currentEvidenceOwner !== owner) return this.currentEvidenceLoad || this.currentSnapshot || { availability: 'unavailable' };
        this.currentReview = review;
        if (review) Object.assign(target, { title: review.title, repository: review.repository, url: review.url });
        this.currentSnapshot = value;
        this.currentEvidenceAt = Date.now();
        return value;
      })().finally(() => { if (this.currentEvidenceOwner === owner) this.currentEvidenceLoad = null; });
      return this.currentEvidenceLoad;
    }

    async showCurrentEvidence(refresh = false) {
      if (!this.currentTarget) return;
      const generation = ++this.evidenceGeneration;
      if (!this.evidence) {
        this.evidence = this.makeDialog('workspace-review-inspector', 'Review evidence');
        this.evidence.classList.add('workspace-inspector');
        this.evidenceBody = node('div');
        this.evidence.append(this.evidenceBody);
      }
      this.open(this.evidence);
      this.evidenceBody.replaceChildren(node('p', 'Loading read-only review evidence…'));
      const snapshot = await this.loadCurrentEvidence(refresh);
      if (generation !== this.evidenceGeneration || !this.evidence.open) return;
      window.ReviewEvidence.render(this.evidenceBody, this.currentTarget, snapshot, this.currentReview, () => this.showCurrentEvidence(true));
    }

    async refresh() {
      if (this.refreshing) return this.refreshing;
      clearTimeout(this.timer);
      const events = new Set();
      this.activityEvents = events;
      this.refreshing = (async () => {
        try {
          const data = await json('/api/analyses/activity');
          const previous = this.identity;
          this.identity = data;
          if (previous && (previous.dbId !== data.dbId || previous.instanceId !== data.instanceId)) {
            this.contextVersion++;
            this.runs.clear();
            events.clear();
            this.reviews = [];
            this.reviewsAt = 0;
            this.reviewLoad = null;
            this.reviewHistoryLoaded = false;
            this.nextReviewCursor = null;
            this.moreReviews.hidden = true;
            this.moreReviews.disabled = false;
            this.currentReview = null;
            this.currentSnapshot = null;
            this.currentEvidenceAt = 0;
            this.currentEvidenceLoad = null;
            this.currentEvidenceOwner = null;
            this.evidenceGeneration++;
            this.evidenceBody?.replaceChildren(node('p', 'Server context changed. Refresh evidence from this connection.'));
            if (this.palette.open) this.renderCommands();
            if (this.currentTarget && !this.contextNotice) {
              this.contextNotice = node('a', 'Server changed · reload this review before editing', { href: location.href });
              this.rail.append(this.contextNotice);
            }
            window.dispatchEvent(new CustomEvent('workspaceContextChanged', { detail: { databaseChanged: previous.dbId !== data.dbId } }));
          }
          window.reviewDrafts?.connect(data);
          const next = new Map();
          for (const run of data.runs) {
            const current = this.runs.get(run.analysisId);
            next.set(run.analysisId, current && current.sequence > run.sequence ? current : run);
          }
          // Preserve events received during this request without relying on wall-clock ordering.
          for (const [id, run] of this.runs) if (!next.has(id) && events.has(id)) next.set(id, run);
          this.runs = next;
          this.available = true;
          for (const run of this.runs.values()) this.notify(run);
        } catch { this.available = false; }
        finally {
          this.refreshing = null;
          this.activityEvents = null;
          this.renderActivity();
          this.timer = setTimeout(() => this.refresh(), document.hidden ? 60000 : 15000);
        }
      })();
      return this.refreshing;
    }

    renderActivity() {
      const runs = [...this.runs.values()];
      const live = runs.filter(run => run.observation === 'live' && !settled.has(run.status));
      const unread = runs.filter(run => settled.has(run.status) && !run.seenAt);
      const unknown = runs.filter(run => run.observation === 'unavailable');
      let label = !this.available ? 'Activity unavailable; last observed state retained'
        : live.length ? `${live.length} ${live.length === 1 ? 'analysis' : 'analyses'} ${live.some(r => r.status === 'cancellation_requested') ? 'active / cancelling' : 'running'} · ${live[0].repository} · ${live[0].stage} · ${age(live[0].startedAt)}`
          : 'No active analyses observed on this server';
      if (unknown.length) label += ` · ${unknown.length} unobserved executor${unknown.length === 1 ? '' : 's'}`;
      if (unread.length) label += ` · ${unread.length} unread result${unread.length === 1 ? '' : 's'}`;
      if (this.identity?.draftCount) label += ` · ${this.identity.draftCount} review${this.identity.draftCount === 1 ? '' : 's'} with saved drafts`;
      this.activityButton.textContent = label;
      this.activityButton.dataset.state = !this.available ? 'unknown' : live.length ? 'running' : unread.some(r => ['failed', 'partial'].includes(r.status)) ? 'attention' : 'idle';
      if (this.drawer.open) this.renderActivityList();
      window.dispatchEvent(new CustomEvent('workspaceActivity', { detail: { runs, available: this.available } }));
    }

    showActivity() { this.open(this.drawer); this.renderActivityList(); this.refresh(); }
    renderActivityList() {
      this.identityLabel.textContent = this.identity ? `Connected instance ${this.identity.instanceId.slice(0, 8)} · database ${this.identity.dbId.slice(0, 8)} · ${location.origin}. Other processes or machines may not be observed.` : 'Connection unavailable';
      const focusedId = this.drawer.contains(document.activeElement) ? document.activeElement.dataset.actionId : null;
      this.activityList.replaceChildren();
      for (const run of this.runs.values()) {
        const card = node('article', null, { class: 'workspace-run', 'data-state': run.status, 'data-run-id': run.analysisId });
        card.append(node('a', `${run.repository}${run.prNumber ? ` #${run.prNumber}` : ''}`, { href: runUrl(run), 'data-action-id': `open-${run.analysisId}` }),
          node('strong', run.status.replaceAll('_', ' ')), node('p', run.stage),
          node('p', `${run.provider || 'Provider unknown'} · ${!run.model || run.model === 'default' ? 'Configured default; resolved model not reported' : run.model} · ${run.entryPoint || 'entry point unknown'}`, { class: 'workspace-muted' }),
          node('p', `Last event ${age(run.lastEventAt)} ago${run.startedAt ? ` · ${settled.has(run.status) ? 'runtime' : 'elapsed'} ${age(run.startedAt, run.completedAt)}` : ''}`, { class: 'workspace-muted' }));
        if (!settled.has(run.status) && run.observation === 'live' && run.entryPoint !== 'standalone') {
          const cancel = node('button', run.status === 'cancellation_requested' ? 'Cancellation requested' : 'Cancel analysis', { type: 'button', 'data-action-id': `cancel-${run.analysisId}` });
          cancel.disabled = run.status === 'cancellation_requested';
          cancel.addEventListener('click', async () => { try { await post(`/api/analyses/${run.analysisId}/cancel`); await this.refresh(); } catch (error) { card.append(node('p', error.message, { role: 'alert' })); } });
          card.append(cancel);
        }
        if (settled.has(run.status) && !run.seenAt) {
          const seen = node('button', 'Mark result seen', { type: 'button', 'data-action-id': `seen-${run.analysisId}` });
          seen.addEventListener('click', async () => { try { await post(`/api/analyses/${run.analysisId}/seen`, { sequence: run.sequence }); } finally { this.refresh(); } });
          card.append(seen);
        }
        const protocol = node('button', 'Inspect run protocol', { type: 'button', 'data-action-id': `protocol-${run.analysisId}` });
        protocol.addEventListener('click', () => this.showProtocol(run.analysisId));
        card.append(protocol);
        this.activityList.append(card);
      }
      if (!this.runs.size) this.activityList.append(node('p', this.available ? 'No recorded results or active analyses on this instance' : 'Activity could not be loaded'));
      if (focusedId) [...this.drawer.querySelectorAll('[data-action-id]')].find(el => el.dataset.actionId === focusedId)?.focus({ preventScroll: true });
    }

    async notify(run) {
      if (!settled.has(run.status) || run.seenAt || run.notificationClaimedAt || localStorage.getItem('pair-review-completion-notifications') !== 'true'
        || !('Notification' in window) || Notification.permission !== 'granted') return;
      try {
        const result = await post(`/api/analyses/${run.analysisId}/notification`);
        if (!result.claimed) return;
        const notice = new Notification(`Review ${run.status}`, { body: run.repository, tag: `${this.identity?.dbId}:${run.analysisId}` });
        notice.onclick = () => { window.focus(); location.href = runUrl(run); notice.close(); };
      } catch { /* The in-app result remains available without desktop notifications. */ }
    }

    async showProtocol(runId) {
      if (!this.protocol) this.protocol = this.makeDialog('workspace-protocol', 'Effective review protocol');
      this.open(this.protocol);
      this.protocol.querySelector('.workspace-protocol-content')?.remove();
      const content = node('div', 'Loading effective configuration…', { class: 'workspace-protocol-content' });
      this.protocol.append(content);
      try {
        const receipt = await json(`/api/protocol${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);
        content.replaceChildren();
        const defaults = receipt['Server defaults'] || {};
        const captured = receipt['Selected run (captured configuration)'];
        const settingSources = receipt['Server setting sources'] || {};
        const policy = receipt['Configured outgoing prose policy'] || {};
        const facts = node('dl');
        const fact = (label, value) => facts.append(node('dt', label), node('dd', value));
        fact('Single-provider default', `${defaults.provider || 'Unknown'} · ${defaults.model || 'unresolved default'}`);
        if (defaults.councilId) fact('Configured default council', `${defaults.councilId} (${settingSources.default_council_id?.source || 'source not recorded'}); resolved when starting analysis, subject to repository and per-run overrides`);
        fact('Public comment format', `${defaults.commentFormat || 'Unknown'} (${settingSources.comment_format?.source || 'source not recorded'}) · external comments ${defaults.externalComments ? 'enabled' : 'disabled'}`);
        fact('Chat configuration', `${defaults.chatProvider || 'Unknown'} · ${defaults.chatModel || 'provider default'} (separate from analysis)`);
        fact('Writing profile', `${policy.profile || 'None configured'} (${policy.profileSource || 'source not recorded'})`);
        const checks = policy.rules || [];
        fact('Outgoing prose checks', checks.length
          ? `${checks.filter(rule => rule.severity === 'blocking').length} blocking, ${checks.filter(rule => rule.severity === 'advisory').length} advisory; checked against selected text in the final publication preview`
          : 'No structural prose checks configured; human judgment is still required');
        const sources = receipt['Configuration sources'] || [];
        fact('Loaded policy', receipt['Instruction content loaded']?.present ? 'Instruction content was loaded; see receipt for hashes and precedence' : 'No global instruction content loaded');
        fact('Disk changes', sources.some(source => source.restartRequired) ? 'Restart required for future runs; current runs keep captured configuration'
          : sources.some(source => source.availability === 'unavailable') ? 'Some sources could not be read; disk changes are unknown'
            : 'No change detected in observed configuration sources');
        if (captured) {
          fact('Selected run', `${captured.provider || 'Unknown provider'} · ${captured.model || 'unresolved default'} · ${captured.status}`);
          fact('Captured run policy', captured.protocol
            ? `${captured.protocol.prosePolicy?.profile || 'No named profile'}; captured inputs, source hashes and per-run/voice overrides are in the receipt below`
            : 'No protocol snapshot was recorded. Current server defaults do not describe this run');
          const voices = receipt['Council voice receipts'] || [];
          if (voices.length) fact('Council voices', voices.map(voice => `${voice.provider} · ${voice.model || 'unresolved default'} · ${voice.status}`).join('; '));
        }
        content.append(facts, node('p', 'Instructions guide behavior; they are not an OS sandbox or proof of correctness. A configured default does not identify the served model.', { class: 'workspace-muted' }));
        const details = node('details');
        details.append(node('summary', 'Full protocol receipt'));
        details.append(node('pre', JSON.stringify(receipt, null, 2)));
        content.append(details);
      } catch (error) { content.textContent = error.message; }
    }
  }

  const start = () => { if (!window.reviewWorkspace) window.reviewWorkspace = new Workspace(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
