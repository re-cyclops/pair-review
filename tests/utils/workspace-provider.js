// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('Deterministic OMP fixture'); process.exit(0); }
const gate = process.env.WORKSPACE_PROVIDER_GATE;
if (!gate) throw new Error('WORKSPACE_PROVIDER_GATE is required; this is not a real provider');
if (process.env.WORKSPACE_PROVIDER_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
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
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(body) }], stopReason: 'stop' } }));
  process.exit(0);
};
console.log(JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }));
watcher = fs.watch(path.dirname(gate), (event, file) => { if (file === path.basename(gate)) finish(); });
finish();
