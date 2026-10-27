// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
(() => {
  'use strict';
  const active = status => ['queued', 'starting', 'running', 'cancellation_requested'].includes(status);
  const host = value => !value || value === 'github' || value === 'github.com' ? 'github.com' : value;
  const key = target => target.local ? `local:${target.reviewId}` : `${host(target.host)}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
  class BulkAnalysisLauncher {
    constructor(workspace) {
      this.workspace = workspace;
      this.targets = new Map();
      this.runs = new Map(workspace?.runs || []);
      this.generation = 0;
      this.available = workspace?.available;
      window.addEventListener('workspaceActivity', event => {
        this.available = event.detail.available;
        for (const run of event.detail.runs) this.runs.set(run.analysisId, run);
        this.reconcile();
      });
      window.addEventListener('workspaceContextChanged', () => {
        this.generation++;
        this.controller?.abort();
        this.runs.clear();
        this.targets.clear();
        this.section?.remove();
        this.section = null;
        this.changed();
      });
    }
    state(target) { return this.targets.get(key(target)); }
    matches(target, run) {
      if (target.local) return run.reviewType === 'local' && String(run.reviewId) === String(target.reviewId);
      return run.reviewType !== 'local' && run.repository?.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase()
        && Number(run.prNumber) === Number(target.number) && host(run.host) === host(target.host);
    }
    activeRun(target) { return [...(this.workspace?.runs?.values() || this.runs.values())].find(run => this.matches(target, run) && active(run.status)); }
    reconcile() {
      for (const target of this.targets.values()) {
        const run = target.analysisId && this.runs.get(target.analysisId);
        if (run) {
          target.status = run.status;
          target.message = `${run.status.replaceAll('_', ' ')}${run.stage ? ' · ' + run.stage : ''}${run.error ? ' · ' + run.error : ''}`;
          if (!active(run.status) && target.refreshedStatus !== run.status) {
            target.refreshedStatus = run.status;
            window.dispatchEvent(new CustomEvent('reviewProgressChanged'));
          }
        }
      }
      this.changed();
    }
    changed() {
      if (this.section) this.render();
      window.dispatchEvent(new CustomEvent('bulkAnalysisChanged'));
    }
    render() {
      const values = [...this.targets.values()];
      const pending = values.filter(target => ['queued', 'preparing', 'launching'].includes(target.status)).length;
      const counts = new Map();
      for (const target of values) counts.set(target.status, (counts.get(target.status) || 0) + 1);
      const guidance = pending ? 'Keep this page open while targets are prepared and submitted.'
        : values.some(target => target.analysisId && (active(target.status) || target.status === 'accepted')) ? 'Accepted reviews continue in the background.'
          : values.some(target => target.analysisId) ? 'Open Activity for results. Inspect any launch failures below.'
            : 'No launch was confirmed. Inspect failures below and Activity before trying again.';
      this.summary.textContent = `${values.length} ${values.length === 1 ? 'review' : 'reviews'} · ${[...counts].map(([status, count]) => `${count} ${status.replaceAll('_', ' ')}`).join(', ')}. ${guidance}${this.available === false ? ' Activity unavailable; last observed progress retained.' : ''}`;
      for (const target of values) {
        if (!target.item) {
          target.item = document.createElement('li');
          const link = document.createElement('a');
          link.href = target.url;
          link.textContent = target.local ? `Local review ${target.reviewId}` : `${target.owner}/${target.repo} #${target.number}${target.host ? ' · ' + target.host : ''}`;
          target.note = document.createElement('span');
          target.item.append(link, target.note);
          this.list.append(target.item);
        }
        target.item.dataset.state = target.status;
        target.note.textContent = ' — ' + target.message;
      }
    }
    async request(url, body, signal) {
      const response = await fetch(url, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
      return data;
    }
    body(config) {
      if (config.isCouncil) return { councilId: config.councilId || undefined, councilConfig: config.councilConfig || undefined, configType: config.configType || 'advanced', customInstructions: config.customInstructions || null, excludePrevious: config.excludePrevious || undefined };
      // The modal owns defaults. Never replace a missing choice with a different paid model.
      if (!config.provider || !config.model) throw new Error('Choose a provider and model in analysis settings.');
      return { provider: config.provider, model: config.model, tier: config.tier || 'balanced', customInstructions: config.customInstructions || null, enabledLevels: config.enabledLevels || [1, 2, 3], skipLevel3: config.skipLevel3 || false, excludePrevious: config.excludePrevious || undefined };
    }
    async start(rows, config) {
      if (this.preparing) return;
      const generation = this.generation;
      const controller = this.controller = new AbortController();
      const signal = controller.signal;
      const current = () => generation === this.generation;
      this.preparing = true;
      if (!this.section) {
        this.section = document.createElement('section');
        this.section.className = 'workspace-bulk-analysis';
        this.section.setAttribute('aria-label', 'Bulk analysis progress');
        const heading = document.createElement('h2');
        heading.textContent = 'Bulk analysis';
        this.summary = document.createElement('p');
        this.summary.setAttribute('role', 'status');
        this.summary.setAttribute('aria-live', 'polite');
        const activity = document.createElement('button');
        activity.type = 'button';
        activity.textContent = 'Open Activity';
        activity.addEventListener('click', () => this.workspace?.showActivity());
        this.list = document.createElement('ul');
        const details = document.createElement('details');
        const detailsLabel = document.createElement('summary');
        detailsLabel.textContent = 'Target details and failures';
        details.append(detailsLabel, this.list);
        this.section.append(heading, this.summary, activity, details);
        document.querySelector('#recent-reviews-section .section-header')?.after(this.section);
      }
      const batch = [];
      for (const row of rows) {
        const previous = this.state(row);
        if (previous && (['queued', 'preparing', 'launching', 'accepted', 'uncertain'].includes(previous.status) || active(previous.status))) continue;
        const target = { ...row, status: 'queued', message: 'Queued on this page — awaiting preparation' };
        previous?.item?.remove();
        this.targets.set(key(target), target);
        batch.push(target);
      }
      this.changed();
      try {
        for (const target of batch) {
          if (!current()) break;
          let submitting = false;
          try {
            const existing = this.activeRun(target);
            if (existing) {
              target.analysisId = existing.analysisId;
              target.message = 'Already active — no duplicate submitted';
              target.status = existing.status;
              this.reconcile();
              continue;
            }
            target.status = 'preparing';
            target.message = target.local ? 'Checking working directory' : 'Preparing pull request checkout';
            this.changed();
            const base = target.local ? `/api/local/${encodeURIComponent(target.reviewId)}` : `/api/pr/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${target.number}`;
            if (target.local) {
              const stale = await this.request(`${base}/check-stale`, undefined, signal);
              if (!current()) break;
              if (stale.isStale === true) throw new Error('Working directory changed. Open this local review to refresh the diff or choose Analyze Anyway.');
              if (stale.isStale == null) throw new Error(stale.error || 'Could not verify working directory. Open this local review before analyzing.');
            } else {
              const setupHost = target.host ? { host: ['github', 'github.com'].includes(target.host) ? null : target.host } : {};
              const setup = await this.request(`/api/setup/pr/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${target.number}`, setupHost, signal);
              if (!current()) break;
              if (!setup.existing) {
                if (!setup.setupId) throw new Error('Setup did not return an operation ID. Open the review to inspect checkout state.');
                while (current()) {
                  const status = await this.request(`/api/setup/${encodeURIComponent(setup.setupId)}/status`, undefined, signal);
                  if (!current()) break;
                  if (status.status === 'error') throw new Error(status.error || 'Checkout setup failed');
                  if (status.status === 'complete') break;
                  target.message = status.progress || 'Preparing pull request checkout';
                  this.changed();
                  await new Promise(resolve => {
                    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
                    const timer = setTimeout(done, 1000);
                    signal.addEventListener('abort', done, { once: true });
                  });
                }
              }
            }
            if (!current()) break;
            const becameActive = this.activeRun(target);
            if (becameActive) { target.analysisId = becameActive.analysisId; this.reconcile(); continue; }
            const body = this.body(config);
            target.status = 'launching';
            target.message = 'Submitting analysis — awaiting server acceptance';
            this.changed();
            submitting = true;
            const result = await this.request(`${base}/analyses${config.isCouncil ? '/council' : ''}`, body, signal);
            if (!current()) break;
            if (typeof result.analysisId !== 'string' || !result.analysisId.trim()) throw new Error('Server did not return an analysis ID. Inspect Activity before trying again.');
            target.analysisId = result.analysisId;
            target.status = 'accepted';
            target.message = 'Accepted by server — awaiting activity';
          } catch (error) {
            if (!current()) break;
            // A transport failure after submission is ambiguous: do not retry paid work.
            target.status = submitting && (error instanceof TypeError || /analysis ID/.test(error.message)) ? 'uncertain' : 'failed';
            target.message = `${target.status === 'uncertain' ? 'Launch outcome unknown. Inspect Activity before retrying. ' : 'Not launched: '}${error.message}`;
            this.changed();
            continue;
          }
          // Server acceptance is final even if a subsequent progress UI/read fails.
          // Keep this outside launch error handling so paid work is never reported unsubmitted.
          try {
            // An executor can complete before its launch HTTP response arrives.
            this.reconcile();
            await this.workspace?.refresh();
            if (!current()) break;
            await this.workspace?.loadReviews();
          } catch (error) {
            if (!current()) break;
            target.message += ' · Could not refresh progress: ' + error.message + '. Open Activity to reconnect.';
            this.changed();
          }
        }
      } finally {
        this.preparing = false;
        if (current()) this.changed();
      }
    }
  }
  if (typeof window !== 'undefined') window.BulkAnalysisLauncher = BulkAnalysisLauncher;
  if (typeof module !== 'undefined') module.exports = BulkAnalysisLauncher;
})();
