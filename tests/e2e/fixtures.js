// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Playwright fixtures for per-worker test server isolation.
 *
 * Each worker gets its own Express server on a unique port with its own
 * in-memory SQLite database, enabling safe parallel execution.
 */

import { test as base, expect } from '@playwright/test';
import { startTestServer } from './test-server.js';

const test = base.extend({
  testServer: [async ({}, use, workerInfo) => {
    const port = 4000 + workerInfo.workerIndex;
    const result = await startTestServer(port);
    try { await use(result); }
    finally { await result.close(); }
  }, { scope: 'worker' }],

  baseURL: async ({ testServer }, use) => {
    await use(`http://localhost:${testServer.port}`);
  },

  // Inject CSS to disable all animations/transitions for faster test execution
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; animation-delay: 0s !important; transition-delay: 0s !important; }';
      (document.head || document.documentElement).appendChild(style);
    });
    await use(page);
  },
});

// Publication/conflict cases get a fresh database and host for every test.
const publicationTest = base.extend({
  testServer: async ({}, use) => {
    const result = await startTestServer(0);
    try { await use(result); }
    finally { await result.close(); }
  },
  baseURL: async ({ testServer }, use) => {
    await use(`http://127.0.0.1:${testServer.server.address().port}`);
  },
});

export { test, publicationTest, expect };
