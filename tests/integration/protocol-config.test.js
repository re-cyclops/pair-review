// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let home;
afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); });

const scenario = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.join(process.env.PROTOCOL_APP_ROOT,'package.json'));
// The package-managed overlay is outside this isolated HOME/project boundary
const readFile = fs.promises.readFile;
let forbiddenRead = false;
fs.promises.readFile = (file,...args) => {
  if (file === path.join(process.env.HOME,'must-not-read')) forbiddenRead = true;
  return file === path.join(process.env.PROTOCOL_APP_ROOT,'config.managed.json')
    ? Promise.reject(Object.assign(new Error('No managed fixture'),{code:'ENOENT'})) : readFile(file,...args);
};
const { loadConfig } = require('./src/config');
const { serverReceipt } = require('./src/utils/review-protocol');
if (process.env.PROTOCOL_SCENARIO === 'project-include') {
  try { await loadConfig(); console.log('CONFIG_RESULT '+JSON.stringify({accepted:true})); }
  catch { console.log('CONFIG_RESULT '+JSON.stringify({accepted:false,forbiddenRead})); }
} else {
  const originalConfig = fs.readFileSync(path.join(process.env.HOME,'.pair-review/config.json'),'utf8');
  const loaded = await loadConfig();
  const before = await serverReceipt(loaded.config,loaded.protocolSources);
  const originalInstructions = loaded.config.globalInstructions;
  loaded.config._globalOverrides = {default_model:'fixture-override'};
  loaded.config._finalKeys = ['default_model'];
  loaded.config.default_model = 'fixture-override';
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.pair-review/config.json'),'utf8'));
  const reloaded = await loadConfig();
  const policy = path.join(process.env.HOME,'policy.md');
  fs.writeFileSync(policy,fs.readFileSync(policy,'utf8').replace('Preserve uncertainty','Preserve revised uncertainty'));
  const changed = await serverReceipt(loaded.config,loaded.protocolSources);
  const restarted = await loadConfig();
  console.log('CONFIG_RESULT '+JSON.stringify({before,changed,originalInstructions,reloadedInstructions:reloaded.config.globalInstructions,restartedInstructions:restarted.config.globalInstructions,
    unchangedConfig:fs.readFileSync(path.join(process.env.HOME,'.pair-review/config.json'),'utf8')===originalConfig,reloadedDefault:reloaded.config.default_model,
    derivedSaved:['globalInstructions','_protocol','_globalOverrides','_finalKeys'].filter(key=>Object.hasOwn(saved,key)),
    savedPolicyCopy:JSON.stringify(saved).includes('Preserve uncertainty'),
    retained:{command:saved.providers.omp.command,auth:saved.github_token_command,retention:saved.worktree_retention_days,chat:saved.chat_provider,chatModel:saved.chat_providers.pi.model}}));
}
`;

const runScenario = name => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-config-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(path.join(home, '.pair-review'));
  fs.mkdirSync(path.join(project, '.pair-review'), { recursive: true });
  fs.writeFileSync(path.join(home, 'policy.md'), '# Fixture policy\n\nOnly authored text is in scope\n\n## Review voice\nPreserve uncertainty\n\n## Company-only\nExcluded company rules\n');
  fs.writeFileSync(path.join(home, '.pair-review/global-instructions.md'), 'Global review constraint');
  fs.writeFileSync(path.join(home, '.pair-review/config.json'), JSON.stringify({ default_provider: 'omp', default_model: 'default', comment_format: 'legacy',
    external_comments: false, chat_provider: 'pi', chat_providers: { pi: { model: 'chat-fixture' } }, providers: { omp: { command: 'fixture-omp' } },
    github_token_command: 'fixture-auth', worktree_retention_days: 13,
    instruction_files: [{ path: '~/policy.md', preamble: true, sections: ['Review voice'] }],
    review_prose: { profile: 'Fixture writing', rules: { 'terminal-period': 'advisory' } } }));
  fs.writeFileSync(path.join(home, '.pair-review/config.local.json'), JSON.stringify({ comment_format: 'plain' }));
  fs.writeFileSync(path.join(project, '.pair-review/config.local.json'), JSON.stringify(name === 'project-include'
    ? { instruction_files: [path.join(home, 'must-not-read')] } : { external_comments: true, globalInstructions: 'Unsupported stale serialized instructions' }));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', scenario], { cwd: name === 'home' ? home : project, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: home, PORT: '', PROTOCOL_APP_ROOT: root, PROTOCOL_SCENARIO: name } });
  return JSON.parse(output.split('\n').find(line => line.startsWith('CONFIG_RESULT ')).slice('CONFIG_RESULT '.length));
};

describe('real configuration and canonical excerpts', () => {
  it('preserves unrelated configuration and resolves one excerpt without serializing or silently reloading it', () => {
    const result = runScenario('cycle');
    expect(result.before['Server setting sources']).toMatchObject({
      default_model: { value: 'default', source: 'config' }, comment_format: { value: 'plain', source: 'config.local' }, external_comments: { value: true, source: 'project.local' } });
    expect(result.before['Server defaults']).toMatchObject({ provider: 'omp', model: 'default', commentFormat: 'plain', chatProvider: 'pi', chatModel: 'chat-fixture' });
    expect(result.originalInstructions).toContain('Only authored text is in scope');
    expect(result.originalInstructions).not.toContain('Excluded company rules');
    expect(result.originalInstructions).not.toContain('Unsupported stale');
    expect(result.reloadedInstructions).toBe(result.originalInstructions);
    expect(result.unchangedConfig).toBe(true);
    expect(result.reloadedDefault).toBe('default');
    expect(result.derivedSaved).toEqual([]);
    expect(result.savedPolicyCopy).toBe(false);
    expect(result.retained).toEqual({ command: 'fixture-omp', auth: 'fixture-auth', retention: 13, chat: 'pi', chatModel: 'chat-fixture' });
    expect(result.changed['Configuration sources'].find(source => source.source === 'Instructions: policy.md').restartRequired).toBe(true);
    expect(result.changed['Instruction content loaded']).toEqual(result.before['Instruction content loaded']);
    expect(result.restartedInstructions).toContain('Preserve revised uncertainty');
  });

  it('rejects project-controlled file includes before reading arbitrary local content', () => {
    expect(runScenario('project-include')).toEqual({ accepted: false, forbiddenRead: false });
  });

  it('does not reclassify the trusted user directory as project configuration when launched from HOME', () => {
    const result = runScenario('home');
    expect(result.before['Server setting sources'].default_provider).toEqual({ value: 'omp', source: 'config' });
    expect(result.before['Configuration sources'].some(source => source.restartRequired)).toBe(false);
    expect(result.originalInstructions).toContain('Preserve uncertainty');
    expect(result.reloadedInstructions).toBe(result.originalInstructions);
  });
});
