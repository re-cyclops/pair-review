// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
const express = require('express');
const request = require('supertest');
const { rejectUnsafeRequest, allowedUpgrade } = require('../../src/utils/loopback-security');
const app = express();
app.use(rejectUnsafeRequest);
app.all('/bootstrap', (req, res) => res.json({ reached: true }));

describe('loopback transport boundary', () => {
  it('allows native clients and the local browser without permitting a foreign origin', async () => {
    expect((await request(app).post('/bootstrap')).status).toBe(200);
    expect((await request(app).post('/bootstrap').set('Origin', 'http://localhost:7247')).status).toBe(200);
    expect((await request(app).post('/bootstrap').set('Origin', 'https://foreign.invalid')).status).toBe(403);
  });
  it('also rejects cross-site GET bootstraps and rebinding Host headers', async () => {
    expect((await request(app).get('/bootstrap').set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await request(app).get('/bootstrap').set('Origin', 'https://foreign.invalid')).status).toBe(403);
    expect((await request(app).get('/bootstrap').set('Host', 'foreign.invalid')).status).toBe(403);
  });
  it('rejects malformed ports and deceptive origins before the websocket URL parser', () => {
    for (const headers of [
      { host: 'localhost:999999' },
      { host: 'localhost.evil.invalid' },
      { host: '127.0.0.1:7247', origin: 'https://localhost@foreign.invalid' },
      { host: '127.0.0.1:7247', origin: 'null' }
    ]) expect(allowedUpgrade({ headers })).toBe(false);
    expect(allowedUpgrade({ headers: { host: '127.0.0.1:7247', origin: 'http://127.0.0.1:7247' } })).toBe(true);
  });
});
