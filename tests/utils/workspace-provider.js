// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('Deterministic OMP fixture'); process.exit(0); }
const gate = process.env.WORKSPACE_PROVIDER_GATE;
if (!gate) throw new Error('WORKSPACE_PROVIDER_GATE is required; this is not a real provider');
if (process.env.WORKSPACE_PROVIDER_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
// Only a live test run signals the gate. When the harness dies first (crash,
// SIGKILL, interrupted runner) nothing ever writes it, and this process would
// watch forever — observed as day-old orphans. Providers spawn this fixture
// detached in its own process group, so even the e2e group-kill of the
// workspace server cannot reach it. A live test resolves the gate in seconds;
// this cap retires only abandoned fixtures, including the SIGTERM-ignoring
// variant above. Exit 75 (EX_TEMPFAIL) makes a legitimately too-slow test
// fail visibly instead of hanging.
const maxLifeMs = Number(process.env.WORKSPACE_PROVIDER_MAX_LIFE_MS || 10 * 60 * 1000);
setTimeout(() => {
  console.error(`Workspace provider fixture timed out after ${maxLifeMs}ms waiting for its gate; exiting`);
  process.exit(75);
}, maxLifeMs);
let watcher;
const finish = () => {
  if (!fs.existsSync(gate)) return;
  const result = JSON.parse(fs.readFileSync(gate, 'utf8'));
  watcher?.close();
  if (result.capture) {
    const args = process.argv.slice(2);
    const prompts = args.filter(arg => arg.startsWith('@')).map(arg => fs.readFileSync(arg.slice(1), 'utf8'));
    fs.appendFileSync(`${gate}.requests.jsonl`, JSON.stringify({ cwd: process.cwd(), args, prompts }) + '\n');
  }
  if (result.fail) { console.error('Synthetic provider failure'); process.exit(1); }
  const body = { suggestions: result.suggestions || [], summary: 'Synthetic fixture review completed.' };
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: result.provider, model: result.model,
    content: [{ type: 'text', text: JSON.stringify(body) }], stopReason: 'stop' } }));
  process.exit(0);
};
console.log(JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }));
// External-provider readiness: the process has opened its actual checkout and
// can now wait for a result without racing application diff preparation.
fs.appendFileSync(`${gate}.started.jsonl`, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }) + '\n');
watcher = fs.watch(path.dirname(gate), (event, file) => { if (file === path.basename(gate)) finish(); });
finish();
