// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

// Both transports must reconstruct the same branch stack, not just the focal PR.

const graphqlStack = require('../../../../src/github/impl/graphql/stack-walker');
const restStack = require('../../../../src/github/impl/rest/stack-walker');

function gqlOctokit(handler) {
  return { graphql: vi.fn(handler) };
}

function restOctokit(handlers) {
  return {
    rest: {
      pulls: {
        get: vi.fn(handlers.get || (async () => ({ data: null }))),
        list: vi.fn(handlers.list || (async () => ({ data: [] })))
      }
    },
    paginate: vi.fn(async (method, opts) => {
      const { data } = await method(opts);
      return data || [];
    })
  };
}

describe('parity: GraphQL vs REST', () => {
  describe('stack_walker', () => {
    it('walkPRStack returns the same stack shape from both transports', async () => {
      const sharedNodes = {
        prA: { number: 1, title: 'A', baseRefName: 'main', headRefName: 'feat-a', state: 'MERGED', url: 'https://althost.example/o/r/pull/1', headRefOid: 'sha-1' },
        prB: { number: 2, title: 'B', baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN', url: 'https://althost.example/o/r/pull/2', headRefOid: 'sha-2' },
        prC: { number: 3, title: 'C', baseRefName: 'feat-b', headRefName: 'feat-c', state: 'OPEN', url: 'https://althost.example/o/r/pull/3', headRefOid: 'sha-3' }
      };

      // --- GraphQL ---
      const gqlStack = await graphqlStack.walkPRStack(
        gqlOctokit(async (query, vars) => {
          if (vars.number === 2) return { repository: { pullRequest: sharedNodes.prB } };
          if (vars.branch === 'feat-a' && query.includes('headRefName')) {
            return { repository: { pullRequests: { nodes: [sharedNodes.prA] } } };
          }
          if (vars.branch === 'feat-b' && query.includes('baseRefName')) {
            return { repository: { pullRequests: { nodes: [sharedNodes.prC] } } };
          }
          return { repository: { pullRequests: { nodes: [] } } };
        }),
        'o', 'r', 2
      );

      // --- REST ---
      const restPRForNumber = {
        1: { number: 1, title: 'A', base: { ref: 'main' }, head: { ref: 'feat-a', sha: 'sha-1' }, state: 'closed', merged_at: '2026-01-01', html_url: 'https://althost.example/o/r/pull/1' },
        2: { number: 2, title: 'B', base: { ref: 'feat-a' }, head: { ref: 'feat-b', sha: 'sha-2' }, state: 'open', merged_at: null, html_url: 'https://althost.example/o/r/pull/2' },
        3: { number: 3, title: 'C', base: { ref: 'feat-b' }, head: { ref: 'feat-c', sha: 'sha-3' }, state: 'open', merged_at: null, html_url: 'https://althost.example/o/r/pull/3' }
      };
      const restStackResult = await restStack.walkPRStack(
        restOctokit({
          get: async ({ pull_number }) => ({ data: restPRForNumber[pull_number] || null }),
          list: async ({ head, base }) => {
            if (head === 'o:feat-a') return { data: [restPRForNumber[1]] };
            if (base === 'feat-b') return { data: [restPRForNumber[3]] };
            return { data: [] };
          }
        }),
        'o', 'r', 2
      );

      expect(restStackResult).toEqual(gqlStack);
    });
  });
});
