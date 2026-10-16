// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * GitHub Collections Routes
 *
 * Handles endpoints for PR collections:
 * - Review Requests: personal requests and the viewer's outstanding change requests
 * - Team Review Requests: PRs where a team the user belongs to is requested,
 *   but the user is not requested directly
 * - My PRs: PRs authored by the user
 *
 * Each collection exposes two endpoints registered by `registerCollection`:
 * - GET  /api/github/:collection          → cached rows from github_pr_cache
 * - POST /api/github/:collection/refresh  → fetch from GitHub and re-cache
 */

const express = require('express');
const { createHash, randomUUID } = require('node:crypto');
const { GitHubClient } = require('../github/client');
const { getGitHubToken, resolveHostBinding } = require('../config');
const logger = require('../utils/logger');
const { resolveRepoLinks } = require('../links/repo-links');
const { resolveBindingRepositoryForHost, setupHostParam } = require('../utils/host-resolution');
const { readReviewHistory } = require('../github/operations/review-snapshot');

const router = express.Router();
const pendingRefreshes = new WeakMap();
const credentialHash = token => token ? createHash('sha256').update(token).digest('hex') : null;

// `host` is additive: NULL for github.com rows, the repo's `api_host` URL for
// alt-host rows. Both GET and the refresh re-read echo it so the frontend can
// open a PR against the system it actually lives on without re-probing.
const SELECT_COLUMNS = 'owner, repo, number, title, author, updated_at, html_url, state, fetched_at, host';

// Valid `org/team` slug: two non-empty segments of GitHub-allowed characters.
// Used to guard against query injection when interpolating the team into the
// GitHub search query string. Must be applied server-side; client validation
// is UX only.
const TEAM_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Collection definitions. `buildQuery` receives the authenticated user's login
 * and an optional params object, and returns the GitHub search query for that
 * collection. Only collections with `supportsTeamFilter: true` consume
 * `params.team` (currently just `team-reviews`); the others accept and ignore
 * it. The flag also gates the team plumbing in `registerCollection`: a stray
 * `?team=` on a collection that doesn't support it is ignored rather than
 * validated or folded into the cache key, so it can never create a misleading
 * namespaced cache entry for a query whose results are identical to the
 * unfiltered view.
 */
// Each definition also carries a `classifyAlt(pr, login, team)` predicate that
// buckets a REST-listed alt-host PR into this collection. Alt-hosts generally
// have no Search API, so the collection semantics that `buildQuery` expresses
// as a github.com search string are re-expressed here as a local predicate
// over the fields `client.listOpenPullRequests` returns. `pr.requested_teams`
// holds team *slugs*; `team`, when set, is a validated `org/team` slug.
const COLLECTIONS = [
  {
    name: 'review-requests',
    label: 'review requests',
    buildQuery: (login) => `is:pr is:open archived:false user-review-requested:${login}`,
    classifyAlt: (pr, login) => pr.requested_reviewers.includes(login)
  },
  {
    name: 'team-reviews',
    label: 'team review requests',
    supportsTeamFilter: true,
    // Review requested from a team the user belongs to, excluding PRs where the
    // user is requested directly (those appear under review-requests).
    //
    // When a specific `team` (org/team) is provided, narrow to that team's open
    // review requests and drop the `-user-review-requested` exclusion: once the
    // user explicitly picks a team, "show everything awaiting this team" is the
    // least surprising behavior. The team value MUST already be validated.
    buildQuery: (login, params) => {
      const team = params && params.team;
      if (team) {
        return `is:pr is:open archived:false team-review-requested:${team}`;
      }
      return `is:pr is:open archived:false review-requested:${login} -user-review-requested:${login}`;
    },
    // A specific `team` filters to PRs requesting that team's slug (the part
    // after the slash, since REST `requested_teams` carries bare slugs, not
    // `org/team`); the all-teams view keeps the same "exclude direct requests"
    // rule as the github.com search so a directly-requested PR shows under
    // review-requests, not here.
    classifyAlt: (pr, login, team) => {
      if (pr.requested_teams.length === 0) return false;
      if (team) {
        const slug = team.slice(team.indexOf('/') + 1);
        return pr.requested_teams.includes(slug);
      }
      return !pr.requested_reviewers.includes(login);
    }
  },
  {
    name: 'my-prs',
    label: 'your pull requests',
    buildQuery: (login) => `is:pr is:open archived:false author:${login}`,
    classifyAlt: (pr, login) => pr.author === login
  }
];

/**
 * Derive an `owner/repo` pair from a `config.repos` key. Alt-host config
 * entries are keyed by the canonical `owner/repo`; monorepo-style entries can
 * be keyed by something else and matched to PRs via `url_pattern`, but the
 * collections sweep needs a concrete owner/repo to call `pulls.list`, so those
 * keys are skipped rather than guessed at.
 * @param {string} repoKey - A `config.repos` key.
 * @returns {{ owner: string, repo: string }|null} Null when not owner/repo shaped.
 */
function ownerRepoFromKey(repoKey) {
  if (typeof repoKey !== 'string') return null;
  const parts = repoKey.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

// Capture bindings once. A cached queue belongs to credentials, not merely to
// a collection name; fingerprints stay on the server and never enter responses.
function collectionSources(config, cachedOnly = false) {
  const token = getGitHubToken(config, undefined, { cachedOnly });
  const sources = [{ host: null, repo: null, binding: token, credentialHash: credentialHash(token),
    source: JSON.stringify([null, null]), error: token ? null : 'no github.com token configured' }];
  const bySource = new Map();
  for (const [repoKey, entry] of Object.entries(config?.repos || {})) {
    if (!entry || typeof entry.api_host !== 'string' || !entry.api_host) continue;
    const ownerRepo = ownerRepoFromKey(repoKey);
    const source = { host: entry.api_host, repo: ownerRepo ? repoKey : null, ownerRepo,
      source: JSON.stringify([entry.api_host, repoKey.toLowerCase()]), credentialHash: null, error: null };
    const existing = bySource.get(source.source);
    if (existing) {
      existing.credentialHash = null;
      existing.error = 'Multiple case-insensitive bindings name this repository. Keep one binding.';
      continue;
    }
    bySource.set(source.source, source);
    sources.push(source);
    if (!ownerRepo) { source.error = 'configured key is not an owner/repo pair'; continue; }
    try {
      source.binding = resolveHostBinding(repoKey, config, { host: source.host, cachedOnly });
      source.credentialHash = credentialHash(source.binding.token);
      if (!source.credentialHash) source.error = 'no credentials configured';
    } catch { source.error = 'host credentials could not be resolved'; }
  }
  return sources;
}

// A global "changes requested" search is only candidate discovery. Another
// reviewer's objection must not put a PR back in a viewer's individual queue.
async function outstandingChanges(client, candidates, login, statuses) {
  const rows = [];
  const others = candidates.filter(pr => pr.author?.toLowerCase() !== login.toLowerCase());
  for (let offset = 0; offset < others.length; offset += 3) {
    const batch = await Promise.all(others.slice(offset, offset + 3).map(async pr => {
      const history = await readReviewHistory(client, pr, login);
      if (!history.complete) {
        statuses.push({ host: client.apiHost || null, repo: `${pr.owner}/${pr.repo}#${pr.number}`, ok: false,
          error: 'Effective review unavailable or partial; queue membership is unknown' });
        return pr;
      }
      return history.viewerReview?.state === 'CHANGES_REQUESTED' ? pr : null;
    }));
    rows.push(...batch.filter(Boolean));
  }
  return rows;
}

// Every source is independently observed. A failed GitHub search must not
// discard readable alternate-host data (or certify an empty queue).
async function collectSource(source, def, team, accounts) {
  if (source.error) { source.status = 401; return; }
  const client = new GitHubClient(source.binding);
  source.warnings = [];
  try {
    const accountKey = `${source.host || 'github.com'}:${source.credentialHash}`;
    let account = accounts.get(accountKey);
    if (!account) {
      const user = await client.getAuthenticatedUser();
      if (!user?.login) throw new Error('Authenticated identity unavailable');
      account = { login: user.login, credentialHash: credentialHash(client.token) };
      accounts.set(`${source.host || 'github.com'}:${account.credentialHash}`, account);
    }
    const login = account.login;
    if (source.host) {
      const prs = await client.listOpenPullRequests(source.ownerRepo.owner, source.ownerRepo.repo);
      source.rows = [];
      const candidates = [];
      for (const pr of prs) {
        if (def.classifyAlt(pr, login, team) && (def.name !== 'review-requests' || pr.author?.toLowerCase() !== login.toLowerCase())) source.rows.push(pr);
        else if (def.name === 'review-requests') candidates.push(pr);
      }
      if (candidates.length) source.rows.push(...await outstandingChanges(client, candidates, login, source.warnings));
    } else {
      source.rows = await client.searchPullRequests(def.buildQuery(login, { team }));
      if (def.name === 'review-requests') {
        source.rows = source.rows.filter(pr => pr.author?.toLowerCase() !== login.toLowerCase());
        const direct = new Set(source.rows.map(pr => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()));
        const candidates = await client.searchPullRequests(`is:pr is:open archived:false reviewed-by:${login} review:changes_requested -author:${login}`);
        source.rows.push(...await outstandingChanges(client, candidates.filter(pr => !direct.has(`${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase())), login, source.warnings));
      }
    }
    source.credentialHash = credentialHash(client.token);
    if (source.credentialHash !== account.credentialHash) {
      source.error = 'Authentication changed while reading the queue. Refresh to observe the current account.';
      source.status = 409;
      return;
    }
    source.ok = true;
  } catch (error) {
    source.credentialHash = credentialHash(client.token);
    source.status = [401, 403, 429].includes(error.status) ? error.status : 503;
    source.error = `Host read unavailable (${source.status})`;
    logger.warn(`Collections: ${source.host || 'github.com'} read failed (${source.status})`);
  }
}

/**
 * Derive the cache storage key for a collection, namespacing by team so a
 * filtered view never clobbers the all-teams cache. Both the GET (read) and
 * POST refresh (write/delete) handlers must route through this single helper so
 * they never diverge.
 * @param {string} name - Collection name.
 * @param {string} [team] - Validated `org/team` slug, or falsy for all-teams.
 * @returns {string} The `collection` column value to use.
 */
function cacheKey(name, team) {
  return team ? `${name}:${team}` : name;
}

/**
 * Validate and normalize the `team` query param.
 * @param {*} raw - The raw `team` value from the request.
 * @returns {{ team: string|null, error: string|null }} `team` is the validated
 *   slug (or null for all-teams); `error` is set when the input is invalid.
 */
function parseTeamParam(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { team: null, error: null };
  }
  if (typeof raw !== 'string' || !TEAM_SLUG_PATTERN.test(raw)) {
    return { team: null, error: 'Invalid team. Use the form org/team.' };
  }
  return { team: raw, error: null };
}

// Only a matching successful observation can authorize cached rows, including
// a successful observation with zero rows. Legacy unowned rows stay unavailable.
function cachedCollection(db, collection, sources, config) {
  const observation = db.prepare('SELECT * FROM github_collection_observations WHERE collection = ? AND source = ?');
  const rows = [];
  const hosts = [];
  const times = [];
  for (const source of sources) {
    const previous = observation.get(collection, source.source);
    const matches = source.credentialHash && previous?.credential_hash === source.credentialHash;
    let availability = 'unavailable';
    let error = source.error || (matches ? previous.error : null) || 'No cached observation for the current credentials. Refresh this queue.';
    if (matches && previous.fetched_at) {
      availability = previous.availability;
      error = previous.error;
      if (availability === 'known' && Date.now() - new Date(previous.fetched_at).getTime() > 120000) {
        availability = 'stale';
        error = 'Cached observation is older than two minutes. Refresh this queue.';
      }
      const predicate = source.host ? 'host = ? AND owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE' : 'host IS NULL';
      const params = source.host ? [collection, source.host, source.ownerRepo.owner, source.ownerRepo.repo] : [collection];
      rows.push(...db.prepare(`SELECT ${SELECT_COLUMNS} FROM github_pr_cache WHERE collection = ? AND ${predicate}`).all(...params));
      times.push(previous.fetched_at);
    }
    hosts.push({ host: source.host, repo: source.repo, ok: availability === 'known', availability,
      observationId: matches ? previous.request_id : null,
      fetched_at: matches ? previous.fetched_at : null, ...(error ? { error } : {}) });
  }
  rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(a.host || '').localeCompare(String(b.host || ''))
    || a.owner.localeCompare(b.owner) || a.repo.localeCompare(b.repo) || a.number - b.number);
  const availability = hosts.every(source => source.availability === 'known') ? 'known'
    : !times.length ? 'unavailable' : hosts.some(source => source.availability === 'unavailable' || source.availability === 'partial') ? 'partial' : 'stale';
  return { success: true, prs: attachRepoLinks(rows, config), fetched_at: times.sort()[0] || null, availability, hosts,
    error: hosts.filter(source => source.error).map(source => `${source.repo || source.host || 'GitHub'}: ${source.error}`).join('; ') || null };
}

async function refreshCollection(db, collection, sources, config, def, team) {
  let pending = pendingRefreshes.get(db);
  if (!pending) { pending = new Map(); pendingRefreshes.set(db, pending); }
  const key = JSON.stringify([collection, sources.map(source => [source.source, source.credentialHash]).sort()]);
  if (pending.has(key)) return pending.get(key);
  const requestId = randomUUID();
  const refresh = (async () => {
    const claim = db.prepare(`INSERT INTO github_collection_observations (collection, source, credential_hash, request_id)
      VALUES (?, ?, ?, ?) ON CONFLICT(collection, source) DO UPDATE SET
      fetched_at = CASE WHEN credential_hash IS excluded.credential_hash THEN fetched_at ELSE NULL END,
      availability = CASE WHEN credential_hash IS excluded.credential_hash THEN availability ELSE 'unavailable' END,
      error = CASE WHEN credential_hash IS excluded.credential_hash THEN error ELSE NULL END,
      credential_hash = excluded.credential_hash, request_id = excluded.request_id`);
    db.transaction(() => { for (const source of sources) claim.run(collection, source.source, source.credentialHash, requestId); })();
    const accounts = new Map();
    for (const source of sources) await collectSource(source, def, team, accounts);
    // Network calls are finished before this short, synchronous transaction.
    // A newer credential context/request owns any source whose claim changed.
    db.transaction(() => {
      const current = db.prepare('SELECT * FROM github_collection_observations WHERE collection = ? AND source = ?');
      const update = db.prepare(`UPDATE github_collection_observations SET credential_hash = ?, fetched_at = ?,
        availability = ?, error = ? WHERE collection = ? AND source = ? AND request_id = ?`);
      const insert = db.prepare(`INSERT INTO github_pr_cache (owner, repo, number, title, author, updated_at, html_url, state, collection, host)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const source of sources) {
        const previous = current.get(collection, source.source);
        if (previous?.request_id !== requestId) continue;
        let fetchedAt = previous.credential_hash === source.credentialHash ? previous.fetched_at : null;
        let error = source.error;
        let availability = fetchedAt ? 'stale' : 'unavailable';
        if (source.ok) {
          if (source.host) db.prepare('DELETE FROM github_pr_cache WHERE collection = ? AND host = ? AND owner = ? COLLATE NOCASE AND repo = ? COLLATE NOCASE')
            .run(collection, source.host, source.ownerRepo.owner, source.ownerRepo.repo);
          else db.prepare('DELETE FROM github_pr_cache WHERE collection = ? AND host IS NULL').run(collection);
          for (const pr of source.rows) insert.run(pr.owner, pr.repo, pr.number, pr.title, pr.author, pr.updated_at, pr.html_url, pr.state, collection, source.host);
          fetchedAt = new Date().toISOString();
          availability = source.warnings.length ? 'partial' : 'known';
          error = source.warnings.map(warning => `${warning.repo}: ${warning.error}`).join('; ') || null;
        }
        update.run(source.credentialHash, fetchedAt, availability, error, collection, source.source, requestId);
        // Retain this opaque generation for browser cache invalidation. It is
        // not a heartbeat or evidence that a refresh is still running.
      }
    })();
    const payload = cachedCollection(db, collection, sources, config);
    for (const source of sources) if (source.warnings?.length) payload.hosts.push(...source.warnings);
    const status = sources.some(source => source.ok) ? 200 : sources.find(source => source.status)?.status || 503;
    payload.success = status === 200;
    return { status, payload };
  })().finally(() => pending.delete(key));
  pending.set(key, refresh);
  return refresh;
}

/**
 * Attach the host-aware repository link configuration consumed by the landing
 * page, plus the `?host=` value its rows navigate with. Resolution is an
 * in-memory config lookup, so this avoids per-row HTTP requests while keeping
 * cached and refreshed responses identical.
 *
 * A row's `host` is authoritative here, unlike a legacy `pr_metadata` NULL:
 * every refresh re-derives these rows, stamping NULL from the github.com search
 * branch and the `api_host` from the alt-host sweep. Both the links and the
 * navigation target are therefore resolved for that known host, through the
 * same two helpers the setup route uses — so a row's action icon and its click
 * always reach the system the PR actually lives on.
 */
function attachRepoLinks(rows, config) {
  return rows.map((row) => {
    const bindingRepository = resolveBindingRepositoryForHost(row.owner, row.repo, config, row.host);
    return {
      ...row,
      repo_links: resolveRepoLinks(config, bindingRepository, row.host),
      setup_host: setupHostParam(config, row.owner, row.repo, row.host)
    };
  });
}

/**
 * Register the GET (cached) and POST (refresh) routes for a single collection.
 * @param {Object} def - Collection definition
 *   ({ name, label, buildQuery, supportsTeamFilter }).
 */
function registerCollection(def) {
  const { name, label, supportsTeamFilter } = def;

  // GET cached PRs.
  router.get(`/api/github/${name}`, async (req, res) => {
    try {
      // Only team-aware collections consume `team`; for the rest, ignore any
      // stray `?team=` so it can't validate-error or skew the cache key.
      let team = null;
      if (supportsTeamFilter) {
        const parsed = parseTeamParam(req.query.team);
        if (parsed.error) {
          return res.status(400).json({ success: false, error: parsed.error });
        }
        team = parsed.team;
      }

      const db = req.app.get('db');
      const config = req.app.get('config') || {};
      res.json(cachedCollection(db, cacheKey(name, team), collectionSources(config, true), config));
    } catch (error) {
      logger.error(`Failed to fetch ${label}:`, error);
      res.status(500).json({ success: false, error: `Failed to fetch ${label}` });
    }
  });

  // POST refresh from GitHub.
  router.post(`/api/github/${name}/refresh`, async (req, res) => {
    try {
      // Only team-aware collections consume `team` (from the query string or
      // request body); for the rest, ignore any stray value so it can't
      // validate-error or skew the cache key. Empty/absent means "all teams".
      let team = null;
      if (supportsTeamFilter) {
        const rawTeam = req.query.team !== undefined ? req.query.team : (req.body && req.body.team);
        const parsed = parseTeamParam(rawTeam);
        if (parsed.error) {
          return res.status(400).json({ success: false, error: parsed.error });
        }
        team = parsed.team;
      }

      const config = req.app.get('config') || {};
      const sources = collectionSources(config);
      const result = await refreshCollection(req.app.get('db'), cacheKey(name, team), sources, config, def, team);
      res.status(result.status).json(result.payload);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        return res.status(error.status).json({ success: false, availability: 'unavailable',
          error: error.status === 401 ? 'GitHub authentication failed' : 'GitHub access denied or rate limited' });
      }
      logger.error(`Failed to refresh ${label}:`, error);
      res.status(500).json({ success: false, error: `Failed to refresh ${label}` });
    }
  });
}

COLLECTIONS.forEach(registerCollection);

module.exports = router;
