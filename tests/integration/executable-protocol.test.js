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

// An isolated process keeps provider registration, HOME and configuration out of
// the test worker; only the optional semantic output mapper is substituted
const scenario = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createTestDatabase } from './tests/utils/schema.js';
const require = createRequire(import.meta.url);
const { createExecutableProviderClass } = require('./src/ai/executable-provider');
const { registerProvider } = require('./src/ai/provider');
const { runExecutableAnalysis } = require('./src/routes/executable-analysis');
const cwd = path.join(process.env.HOME, 'checkout with spaces');
fs.mkdirSync(cwd);
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {encoding:'utf8'}).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Protocol Fixture');
git('config', 'user.email', 'fixture@example.invalid');
fs.writeFileSync(path.join(cwd, 'file.js'), 'const value = 1;\n');
git('add', 'file.js'); git('commit', '-qm', 'Fixture base');
const base = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(cwd, 'file.js'), 'const value = 2;\n');
if (process.env.PROTOCOL_MODE !== 'local') { git('add', 'file.js'); git('commit', '-qm', 'Fixture head'); }
const head = git('rev-parse', 'HEAD');
const script = path.join(process.env.HOME, 'record provider.cjs');
fs.writeFileSync(script, 'const fs=require("node:fs"),path=require("node:path");const args=process.argv.slice(2);const value=flag=>args[args.indexOf(flag)+1];fs.writeFileSync(process.env.PROTOCOL_CAPTURE,JSON.stringify({instructions:value("--instructions")}));fs.writeFileSync(path.join(value("--output-dir"),"results.json"),JSON.stringify({suggestions:[],summary:"Fixture result"}));');
const capture = path.join(process.env.HOME, 'captured.json');
delete process.env.PAIR_REVIEW_PROTOCOL_EXECUTABLE_CMD;
const Provider = createExecutableProviderClass('protocol-executable', {command:process.execPath,args:[script],context_args:{custom_instructions:'--instructions',output_dir:'--output-dir'},env:{PROTOCOL_CAPTURE:capture}});
Provider.prototype.mapOutputToSchema = async raw => JSON.parse(raw);
registerProvider('protocol-executable', Provider);
const db = createTestDatabase();
db.prepare('INSERT INTO reviews(id,repository,review_type) VALUES(1,?,?)').run('fixture/repo',process.env.PROTOCOL_MODE === 'local' ? 'local' : 'pr');
const config = {globalInstructions:'Global safety rule'};
let runId = 'protocol-run';
if (process.env.PROTOCOL_MODE === 'council') {
  const Analyzer = require('./src/ai/analyzer');
  const result = await new Analyzer(db,'council','council').runReviewerCentricCouncil(
    {reviewId:1,worktreePath:cwd,prMetadata:{base_sha:base,head_sha:head},changedFiles:['file.js'],instructions:{globalInstructions:config.globalInstructions,repoInstructions:'Repository scope',requestInstructions:'Request focus'}},
    {voices:[{provider:'protocol-executable',model:'default',customInstructions:'Voice lens'}],levels:{1:true,2:false,3:false}});
  runId = result.runId;
} else {
let finish;
const terminal = new Promise(resolve => { finish=resolve; });
const timer = setTimeout(() => { throw new Error('Executable lifecycle did not settle'); },10000);
await runExecutableAnalysis({app:{get:key=>key==='db'?db:key==='config'?config:null}},{json(){}},
 {reviewId:1,review:{id:1},selectedProvider:'protocol-executable',selectedModel:'default',repoInstructions:'Repository scope',requestInstructions:'Request focus',runId:'protocol-run',analysisId:'protocol-run',repository:'fixture/repo',reviewType:process.env.PROTOCOL_MODE,headSha:head},
 {activeAnalyses:new Map(),reviewToAnalysisId:new Map(),broadcastProgress:(_id,value)=>{if(['completed','failed','cancelled'].includes(value.status)) finish(value);},broadcastReviewEvent(){},registerProcessForCancellation(){}},
 {buildContext:()=>({cwd,baseSha:base,headSha:head,scopeStart:process.env.PROTOCOL_MODE==='local'?'unstaged':undefined,scopeEnd:'untracked'}),buildHookPayload:()=>({}),onSuccess:async()=>{},logLabel:'Protocol fixture'});
await terminal;
clearTimeout(timer);
}
const row=db.prepare('SELECT status,global_instructions,repo_instructions,request_instructions FROM analysis_runs WHERE id=?').get(runId);
const captured=JSON.parse(fs.readFileSync(capture,'utf8'));
console.log('PROTOCOL_RESULT '+JSON.stringify({...row,...captured}));
`;

describe('real executable instruction transport', () => {
  it.each(['pr', 'local', 'council'])('delivers all captured instruction layers once in %s mode', mode => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-protocol-'));
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', scenario], { cwd: root, encoding: 'utf8', timeout: 25000,
      env: { ...process.env, HOME: home, PROTOCOL_MODE: mode, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    const observed = JSON.parse(output.split('\n').find(line => line.startsWith('PROTOCOL_RESULT ')).slice('PROTOCOL_RESULT '.length));
    expect(observed.status).toBe('completed');
    for (const text of ['Global safety rule', 'Repository scope', 'Request focus']) expect(observed.instructions.split(text)).toHaveLength(2);
    if (mode === 'council') expect(observed.instructions.split('Voice lens')).toHaveLength(2);
    expect(observed).toMatchObject({ global_instructions: 'Global safety rule', repo_instructions: 'Repository scope', request_instructions: 'Request focus' });
  });
});
