// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Repo-scoped credentials and host isolation at CLI entry points.
 */
import { describe, it, expect } from 'vitest';

const { resolveHostBinding } = require('../../src/config');
const { setupHostParam, resolvePreflightBinding } = require('../../src/utils/host-resolution');
const { resolveCliBindingRepository } = require('../../src/main');

describe('main.js — repo-scoped-only config resolves to a token', () => {
  it('resolveHostBinding finds a repo-scoped token even when top-level is empty', () => {
    // This is the configuration shape that USED to fail in handlePullRequest's
    // preflight: no top-level token, no env var, only `repos[*].token`.
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const config = {
        // Intentionally no `github_token` / `github_token_command`.
        repos: {
          'owner/repo': {
            token: 'repo-scoped-secret'
          }
        }
      };
      const binding = resolveHostBinding('owner/repo', config);
      expect(binding.token).toBe('repo-scoped-secret');
      expect(binding.source).toBe('repo:token');
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });

  it('alt-host repo-scoped token resolves even when GITHUB_TOKEN env var would otherwise fire', () => {
    // For alt-host repos the env var is intentionally NOT used (it's a
    // github.com token). The repo-scoped token must still be found.
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'github-com-token-must-not-leak-to-alt-host';
    try {
      const config = {
        repos: {
          'owner/alt': {
            api_host: 'https://ghe.example.com/api/v3',
            token: 'alt-host-secret',
            features: { review_lifecycle: 'rest', pending_review_comments: 'rest' }
          }
        }
      };
      const binding = resolveHostBinding('owner/alt', config);
      expect(binding.token).toBe('alt-host-secret');
      expect(binding.apiHost).toBe('https://ghe.example.com/api/v3');
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });
});

describe('main.js — CLI binding key is host-aware at every PR entry point', () => {
  const ALT = 'https://alt.example/api/v3';
  const MONOREPO_PATTERN = '^https://alt\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)';

  const dualMonorepo = {
    github_token: 'gh-tok',
    repos: {
      'acme/platform': { api_host: ALT, exclusive: false, url_pattern: MONOREPO_PATTERN, token: 'alt-tok' }
    }
  };
  const exclusiveMonorepo = {
    github_token: 'gh-tok',
    repos: {
      'acme/platform': { api_host: ALT, url_pattern: MONOREPO_PATTERN, token: 'alt-tok' }
    }
  };

  it('a canonical github.com URL KEEPS a dual monorepo entry (its local config still applies)', () => {
    // Parser dropped its key (canonical github URL) and reports host null. The
    // dual entry does serve github.com, so it — and its path/pool/reset
    // configuration — must be retained.
    expect(resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: null },
      dualMonorepo
    )).toBe('acme/platform');
  });

  it('a canonical github.com URL rejects an EXCLUSIVE monorepo entry', () => {
    expect(resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: null },
      exclusiveMonorepo
    )).toBe('acme/widgets');
  });

  it('a bare PR number preflights against the configured monorepo entry', () => {
    // Host unknown: the entry serving this owner/repo must still be found, or the
    // preflight resolves the identity and misses the repo-scoped token.
    const key = resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: undefined },
      exclusiveMonorepo
    );
    expect(key).toBe('acme/platform');
    expect(resolveHostBinding(key, exclusiveMonorepo, { host: ALT }).token).toBe('alt-tok');
  });

  it('an alt-host URL keeps the key the parser matched', () => {
    expect(resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: ALT, bindingRepository: 'acme/platform' },
      exclusiveMonorepo
    )).toBe('acme/platform');
  });

  it('a directly keyed exclusive repo fails fast, naming the config fix', () => {
    // The CLI passes the parsed host straight into the preflight, so a canonical
    // github.com URL for a repo its own entry declares alt-host-only fails before
    // any network work. Documented in docs/alt-host.md alongside the web
    // surface's warn-and-continue behaviour — the two differ deliberately.
    const directlyKeyedExclusive = {
      github_token: 'gh-tok',
      repos: { 'acme/widgets': { api_host: ALT, token: 'alt-tok' } }
    };
    const key = resolveCliBindingRepository(
      { owner: 'acme', repo: 'widgets', host: null },
      directlyKeyedExclusive
    );
    // Config wins over inference: the entry is kept, not escaped.
    expect(key).toBe('acme/widgets');
    expect(() => resolvePreflightBinding(key, directlyKeyedExclusive, null))
      .toThrow(/exclusive alt-host repo.*"exclusive": false/s);
  });

  it('maps a canonical URL to the github sentinel when an alt entry could claim it', () => {
    // Without the sentinel, setup re-resolves the alt entry and fetches from it.
    expect(setupHostParam(exclusiveMonorepo, 'acme', 'widgets', null)).toBe('github');
  });
});
