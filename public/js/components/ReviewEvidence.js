// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
(() => {
  'use strict';
  const element = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const externalUrl = href => {
    try {
      const url = new URL(href);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  };
  const externalLink = (label, href) => {
    const url = externalUrl(href);
    return url ? element('a', label, { href: url, target: '_blank', rel: 'noopener noreferrer' })
      : element('span', `${label} (link unavailable)`);
  };
  const hostIdentity = host => !host || host === 'github' || host === 'github.com' ? 'github.com' : host;
  const hasDraft = local => Boolean(local?.draftCount || local?.hasDraftSummary);
  const draftLabel = local => {
    if (!local) return 'Saved draft state unavailable';
    const parts = [];
    if (local.draftCount) parts.push(`${local.draftCount} saved comment${local.draftCount === 1 ? '' : 's'}`);
    if (local.hasDraftSummary) parts.push('Saved review body or decision');
    return parts.join(' · ') || 'No unfinished saved draft';
  };
  const checkLabel = checks => {
    if (!checks?.counts || checks.availability === 'unavailable') return 'CI unavailable';
    const c = checks.counts;
    const summary = [['failed', c.failed], ['action required', c.actionRequired], ['pending', c.pending], ['cancelled', c.cancelled], ['passed', c.passed], ['skipped', c.skipped], ['neutral', c.neutral], ['unknown', c.unknown]]
      .filter(([, count]) => count).map(([label, count]) => `${count} ${label}`).join(' · ');
    return `${checks.availability === 'partial' ? 'CI partial: ' : 'CI: '}${summary || 'no runs observed'}`;
  };
  const failingCheck = snapshot => {
    const latest = new Map();
    for (const check of [...(snapshot?.checks?.items || [])].sort((a, b) => Number(a.id) - Number(b.id) || String(a.startedAt || '').localeCompare(String(b.startedAt || '')))) {
      if (check.revision && check.revision === snapshot.checks.revision) latest.set(`${check.source}:${check.appId}:${check.name}`, check);
    }
    return [...latest.values()].find(check => ['failure', 'error', 'timed_out', 'action_required'].includes(check.conclusion) && externalUrl(check.url));
  };
  const render = (body, record, s, local, refresh) => {
    body.replaceChildren(element('h3', `${record.repository} ${record.local ? '· local review' : `#${record.number}`}`), element('p', record.title));
    const url = local?.url || record.url || record.next?.href;
    if (url) body.append(element('a', 'Open review', { href: url }));
    if (record.local) {
      body.append(element('p', `Local-only review · ${draftLabel(local)}`),
        element('p', `Recorded HEAD: ${local?.headSha || 'unknown'}`),
        element('p', `Last explicitly reviewed: ${local?.lastReviewedHead || 'not recorded'}`),
        element('p', 'No GitHub approval, CI or merge-readiness inference applies to this local review.'));
      return;
    }
    if (s.identity?.url) body.append(document.createTextNode(' · '), externalLink('Open pull request', s.identity.url));
    body.append(element('p', s.fetchedAt ? `Fetched ${new Date(s.fetchedAt).toLocaleString()}${s.availability === 'stale' ? ' · stale; refresh failed' : ''}` : 'Host evidence unavailable', { class: 'workspace-muted' }));
    if (s.error) body.append(element('p', `${s.error}${s.retryAfterSeconds ? ` · retry after ${s.retryAfterSeconds}s` : ''}`, { role: 'status' }));
    const refreshButton = element('button', 'Refresh this evidence', { type: 'button' });
    refreshButton.addEventListener('click', refresh);
    body.append(refreshButton);
    const facts = element('dl');
    const fact = (name, value) => facts.append(element('dt', name), element('dd', value));
    fact('Your responsibility', s.viewer?.reason || 'Unknown');
    fact('PR state', s.state ? `${s.merged ? 'Merged' : s.state}${s.draft ? ' · draft PR' : ''}` : 'Unknown');
    fact('Observed head', s.headSha || 'Unknown');
    if (local?.headSha && local.headSha !== s.headSha) fact('Loaded review head', `${local.headSha} · differs from this host snapshot; refresh the review before relying on its diff`);
    fact('Last explicitly reviewed revision', local?.lastReviewedHead || s.local?.lastReviewedHead || 'Not recorded; opening and AI analysis do not mark a revision reviewed');
    fact('Approvals', s.approvals?.availability === 'partial' ? 'Review history is partial; current approval total is unknown' : s.approvals?.observedCount == null ? 'Unavailable' : `${s.approvals.observedCount} observed · ${s.approvals.requiredCount == null ? 'required count unknown' : `${s.approvals.requiredCount} required`}`);
    const opinion = s.viewer?.effectiveReview;
    fact('Your effective review', opinion ? `${opinion.state} at ${opinion.commitSha || 'unknown revision'} · ${opinion.submittedAt || 'submission time unavailable'}`
      : s.approvals?.complete && s.viewer?.identity?.availability === 'known' ? 'No effective opinion observed' : 'Unavailable or partial review history');
    fact('Personal requests', s.requests?.users ? s.requests.users.map(user => user.login).join(', ') || 'None observed' : 'Unavailable');
    fact('Team requests', s.requests?.teams ? s.requests.teams.map(team => team.slug).join(', ') || 'None observed' : 'Unavailable');
    fact('Remote pending draft', s.viewer?.pendingReview == null ? 'Unknown' : s.viewer.pendingReview ? 'Present on host' : 'None observed');
    fact('Local draft', local ? `${draftLabel(local)}; only included comments enter the final manifest` : 'No cached review loaded');
    fact('Conversation threads', s.threads?.unresolved == null ? 'Unavailable' : `${s.threads.unresolved} unresolved${s.threads.complete ? '' : ' · partial count'}`);
    fact('Merge conflicts', s.merge?.conflict == null ? 'Unknown' : s.merge.conflict ? 'Conflicts reported' : 'No conflicts reported');
    fact('Host merge state', s.merge?.providerMergeState || 'Unknown');
    fact('Requirement knowledge', s.policy?.note || 'Branch protection / rules unavailable; approval count alone is not readiness');
    if (s.policy?.codeOwnersRequired) fact('Code owners', 'Required; eligible-owner coverage is not established');
    if (s.policy?.otherRules?.length) fact('Other rules', s.policy.otherRules.join(', '));
    for (const [label, section] of [['Review history', s.approvals], ['Review requests', s.requests], ['Head checks', s.checks], ['Branch policy', s.policy]]) fact(`${label} availability`, section?.availability || 'Unavailable');
    body.append(facts);
    if (s.approvals?.effective?.length) {
      body.append(element('h3', s.approvals.availability === 'known' ? 'Effective reviewer opinions' : 'Observed review history · incomplete'));
      const list = element('ul');
      for (const review of s.approvals.effective) {
        const person = review.reviewer.name ? `${review.reviewer.name} (${review.reviewer.login})` : review.reviewer.login;
        const item = element('li', `${person}${review.reviewer.type === 'Bot' ? ' · bot' : ''} · ${review.state} · ${review.commitSha === s.headSha ? 'current head' : 'earlier or unknown revision'} `);
        if (review.url) item.append(externalLink('Review', review.url));
        list.append(item);
      }
      body.append(list);
    }
    for (const [title, checks] of [['Head checks', s.checks], ['Test-merge checks (not the PR head)', s.testMerge]]) {
      if (!checks && title !== 'Head checks') continue;
      body.append(element('h3', title), element('p', checkLabel(checks)));
      if (checks?.revision) body.append(element('p', `Revision ${checks.revision}`, { class: 'workspace-muted' }));
      for (const check of checks?.items || []) {
        const item = element('div', null, { class: 'workspace-check' });
        item.append(externalLink(`${check.name} · ${check.status === 'completed' ? check.conclusion || 'unknown' : check.status}`, check.url),
          element('span', `${check.source}${check.appId != null ? ` · app ${check.appId}` : ''} · ID ${check.id} · revision ${check.revision || 'unknown'}${check.revision !== checks.revision ? ' · different revision; excluded from current totals' : ''}`, { class: 'workspace-muted' }));
        body.append(item);
      }
    }
    if (s.policy?.requiredChecks?.length) {
      body.append(element('h3', 'Required check evidence'));
      for (const check of s.policy.requiredChecks) body.append(element('p', `${check.name}: ${check.presentOnHead ? 'observed on head' : 'not observed on head'}${check.presentOnTestMerge ? ' · observed on test merge' : ''}. Missing evidence is not a passing check.`));
    }
    if (s.threads?.items?.some(thread => !thread.resolved)) {
      body.append(element('h3', 'Unresolved threads'));
      for (const thread of s.threads.items.filter(thread => !thread.resolved)) {
        const paragraph = element('p');
        paragraph.append(externalLink(`Open thread${thread.outdated ? ' (outdated)' : ''}`, thread.url));
        body.append(paragraph);
      }
    }
  };
  window.ReviewEvidence = { render, checkLabel, externalLink, externalUrl, failingCheck, hostIdentity, hasDraft, draftLabel };
})();
