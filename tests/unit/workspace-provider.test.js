// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = require.resolve('../utils/workspace-provider.js');

/**
 * Spawn the fixture with an isolated gate directory and resolve on its close
 * event — the deterministic completion signal for a leaf CLI process, so no
 * fixed-duration waits are needed anywhere in this file.
 */
function runFixture(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-provider-fixture-'));
  const gate = path.join(dir, 'provider-result.json');
  const child = spawn(process.execPath, [fixture, '-p'], {
    env: { ...process.env, WORKSPACE_PROVIDER_GATE: gate, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  const ready = () => vi.waitFor(() => expect(fs.existsSync(`${gate}.started.jsonl`)).toBe(true));
  return { child, gate, dir, closed, ready };
}

describe('workspace-provider fixture lifetime', () => {
  it('resolves the gate and exits 0 before the lifetime cap', async () => {
    const run = runFixture({ WORKSPACE_PROVIDER_MAX_LIFE_MS: '60000' });
    try {
      await run.ready();
      fs.writeFileSync(run.gate, JSON.stringify({ provider: 'omp', model: 'default', suggestions: [] }));
      const result = await run.closed;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('"message_end"');
    } finally {
      run.child.kill('SIGKILL');
      fs.rmSync(run.dir, { recursive: true, force: true });
    }
  });

  it('exits 75 when no gate ever arrives, so an abandoned fixture cannot linger (orphan regression)', async () => {
    const run = runFixture({ WORKSPACE_PROVIDER_MAX_LIFE_MS: '200' });
    const result = await run.closed;
    expect(result.code).toBe(75);
    expect(result.stderr).toContain('timed out');
    fs.rmSync(run.dir, { recursive: true, force: true });
  });

  it('still self-retires in the SIGTERM-ignoring variant: SIGTERM does not stop it, the cap does', async () => {
    const run = runFixture({ WORKSPACE_PROVIDER_MAX_LIFE_MS: '200', WORKSPACE_PROVIDER_IGNORE_TERM: '1' });
    try {
      await run.ready();
      run.child.kill('SIGTERM');
      const result = await run.closed;
      expect(result.code).toBe(75);
    } finally {
      run.child.kill('SIGKILL');
      fs.rmSync(run.dir, { recursive: true, force: true });
    }
  });
});
