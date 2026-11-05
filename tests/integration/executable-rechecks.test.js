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

// Real external process, mapper normalization, analysis orchestration, DB and API.
// Only the paid mapping provider is a fixture, returning each supported envelope.
const tool = String.raw`
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
const instructions=value('--instructions');
fs.writeFileSync(process.env.RECHECK_CAPTURE,JSON.stringify({instructions}));
if(process.env.RECHECK_OUTCOME==='failed') process.exit(1);
const context=JSON.parse(instructions.split('\n').find(line=>line.startsWith('{"prior_summary"')));
const revisionRechecks=context.feedback.map((item,index)=>({id:item.id,relevance:['resolved','still_relevant','changed'][index],
 reason:'Current file.js sets value to 2; reassessed the saved concern.',next_action:'Inspect the current value before choosing a publication anchor.',
 suggested_body:'Suggested wording only.',location:{file:'file.js',line_start:1,line_end:1,side:'RIGHT'}}));
fs.writeFileSync(path.join(value('--output-dir'),'results.json'),JSON.stringify({suggestions:[],summary:'Reassessed saved feedback on current code.',
 ...(process.env.RECHECK_OUTCOME==='missing'?{}:{revisionRechecks}),ignoredExtra:'must not leak'}));
`;

const scenario = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createTestDatabase, closeTestDatabase } from './tests/utils/schema.js';
import express from 'express';
import request from 'supertest';
const require = createRequire(import.meta.url);
const { createExecutableProviderClass } = require('./src/ai/executable-provider');
const { registerProvider } = require('./src/ai/provider');
const { AnalysisRunRepository, CommentRepository, PRMetadataRepository } = require('./src/database');
const { storePRData } = require('./src/setup/pr-setup');
const { runExecutableAnalysis } = require('./src/routes/executable-analysis');
const cwd = path.join(process.env.HOME, 'checkout with spaces');
fs.mkdirSync(cwd);
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {encoding:'utf8'}).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Recheck Fixture');
git('config', 'user.email', 'fixture@example.invalid');
fs.writeFileSync(path.join(cwd, 'file.js'), 'const value = 1;\n');
git('add', '.'); git('commit', '-qm', 'Base');
const base = git('rev-parse', 'HEAD');
fs.writeFileSync(path.join(cwd, 'file.js'), 'const value = 2;\n');
git('add', '.'); git('commit', '-qm', 'Current head');
const head = git('rev-parse', 'HEAD');
const script = path.join(process.env.HOME, 'recheck tool.cjs');
const capture = path.join(process.env.HOME, 'captured.json');
fs.writeFileSync(script, ${JSON.stringify(tool)});
let mappingCalls = 0;
class FixtureMapper {
 static getModels() { return [{id:'fixture',default:true}]; }
 static getDefaultModel() { return 'fixture'; }
 async execute(prompt) {
  mappingCalls++;
  const data=JSON.parse(prompt.split('--- RAW TOOL OUTPUT ---\n')[1]);
  if(process.env.RECHECK_ENVELOPE==='structured') return {success:true,data};
  if(process.env.RECHECK_ENVELOPE==='raw') return {raw:JSON.stringify(data)};
  return data;
 }
}
registerProvider('recheck-mapper', FixtureMapper);
require('./src/config').loadConfig = async () => ({ default_provider: 'recheck-mapper' });
delete process.env.PAIR_REVIEW_RECHECK_EXECUTABLE_CMD;
const Provider=createExecutableProviderClass('recheck-executable',{command:process.execPath,args:[script],
 context_args:{custom_instructions:'--instructions',output_dir:'--output-dir'},env:{RECHECK_CAPTURE:capture}});
registerProvider('recheck-executable',Provider);
const db=createTestDatabase();
const info={owner:'fixture',repo:'repo',number:1};
const data={title:'Fixture',body:'Description',author:'author',head_branch:'main',base_branch:'main',base_sha:base,head_sha:base};
const {reviewId}=await storePRData(db,info,data,'old diff',[],cwd);
const runs=new AnalysisRunRepository(db);
await runs.create({id:'old-run',reviewId,headSha:base,status:'completed',diff:'historical diff'});
await runs.update('old-run',{summary:'Historical conclusion'});
await new CommentRepository(db).bulkInsertAISuggestions(reviewId,'old-run',[{file:'file.js',line_start:1,line_end:1,type:'bug',title:'Saved finding',description:'Old finding body',confidence:0.9}],null);
const app=express(); app.use(express.json()); app.set('db',db); app.set('config',{});
app.use(require('./src/routes/reviews'));
for(const body of ['My authored pending draft.','My second authored draft.']) {
 const response=await request(app).post('/api/reviews/'+reviewId+'/comments').send({file:'file.js',line_start:1,line_end:1,side:'RIGHT',commit_sha:base,body});
 if(response.status!==200) throw new Error(JSON.stringify(response.body));
}
db.prepare('UPDATE reviews SET summary=?,draft_body=? WHERE id=?').run('Historical conclusion','My authored overall review.',reviewId);
const before=db.prepare('SELECT id,body,commit_sha FROM comments ORDER BY id').all();
await storePRData(db,info,{...data,head_sha:head},'current diff',[{file:'file.js'}],cwd);
const metadata=await new PRMetadataRepository(db).getByPR(1,'fixture/repo');
let runId='recheck-run';
if(process.env.RECHECK_MODE==='council') {
 const Analyzer=require('./src/ai/analyzer');
 const {runHeadlessCouncilAnalysis}=require('./src/councils/headless-council');
 try {
  const result=await runHeadlessCouncilAnalysis(db,{analyzer:new Analyzer(db,'council','council'),reviewId,
   council:{id:'fixture-council'},configType:'council',councilConfig:{voices:[{provider:'recheck-executable',model:'default'}],levels:{1:true,2:false,3:false}},
   worktreePath:cwd,prMetadata:metadata,changedFiles:['file.js'],instructions:{requestInstructions:'Fixture request'}});
  runId=result.runId;
 } catch(error) {
  if(process.env.RECHECK_OUTCOME!=='failed') throw error;
  runId=db.prepare("SELECT id FROM analysis_runs WHERE id!='old-run' ORDER BY rowid DESC LIMIT 1").get().id;
 }
} else {
 let finish;
 const terminal=new Promise(resolve=>{finish=resolve;});
 const timer=setTimeout(()=>{throw new Error('Executable recheck did not settle');},10000);
 await runExecutableAnalysis({app},{json(){},status(code){throw new Error('Unexpected initialization status '+code);}},
  {reviewId,review:{id:reviewId},selectedProvider:'recheck-executable',selectedModel:'default',runId,analysisId:runId,
   repository:'fixture/repo',reviewType:'pr',headSha:head},
  {activeAnalyses:new Map(),reviewToAnalysisId:new Map(),broadcastProgress:(_id,value)=>{if(['completed','failed','cancelled'].includes(value.status)) finish(value);},broadcastReviewEvent(){},registerProcessForCancellation(){}},
  {buildContext:()=>({cwd,baseSha:base,headSha:head}),buildHookPayload:()=>({}),onSuccess:async()=>{},logLabel:'Recheck fixture'});
 await terminal; clearTimeout(timer);
}
const comments=(await request(app).get('/api/reviews/'+reviewId+'/comments')).body.comments;
const findings=(await request(app).get('/api/reviews/'+reviewId+'/suggestions?allRuns=true')).body.suggestions;
const after=db.prepare('SELECT id,body,commit_sha FROM comments ORDER BY id').all();
const guidance=[...comments,...findings].sort((a,b)=>a.id-b.id).map(row=>row.revision_recheck);
const draft=comments[0];
const edit=await request(app).put('/api/reviews/'+reviewId+'/comments/'+draft.id).send({body:'Edited since the recheck.',expected_revision:draft.revision,draft_key:draft.draft_key});
if(edit.status!==200) throw new Error(JSON.stringify(edit.body));
const edited=(await request(app).get('/api/reviews/'+reviewId+'/comments')).body.comments.find(row=>row.id===draft.id);
const run=db.prepare('SELECT status,summary FROM analysis_runs WHERE id=?').get(runId);
const old=db.prepare("SELECT summary,diff FROM analysis_runs WHERE id='old-run'").get();
const overall=db.prepare('SELECT draft_body FROM reviews WHERE id=?').get(reviewId).draft_body;
console.log('RECHECK_RESULT '+JSON.stringify({run,before,after,guidance,edited:edited.revision_recheck,mappingCalls,old,overall,
 instructions:JSON.parse(fs.readFileSync(capture,'utf8')).instructions}));
closeTestDatabase(db);
`;

function run(mode, envelope, outcome) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-executable-rechecks-'));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', scenario], {
    cwd: root, encoding: 'utf8', timeout: 25000,
    env: { ...process.env, HOME: home, RECHECK_MODE: mode, RECHECK_ENVELOPE: envelope, RECHECK_OUTCOME: outcome,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  });
  return JSON.parse(output.split('\n').find(line => line.startsWith('RECHECK_RESULT ')).slice('RECHECK_RESULT '.length));
}

describe('executable saved-feedback semantic delivery', () => {
  it.each(['pr', 'council'].flatMap(mode => ['direct', 'structured', 'raw'].map(envelope => [mode, envelope])))
  ('retains real %s process rechecks through the %s mapper envelope and API', (mode, envelope) => {
    const observed = run(mode, envelope, 'checked');
    expect(observed.run).toEqual({ status: 'completed', summary: 'Reassessed saved feedback on current code.' });
    expect(observed.mappingCalls).toBe(1);
    expect(observed.guidance.map(item => item.relevance)).toEqual(['resolved', 'still_relevant', 'changed']);
    for (const item of observed.guidance) expect(item).toMatchObject({ status: 'checked', suggested_body: 'Suggested wording only.',
      location: { file: 'file.js', line_start: 1, line_end: 1, side: 'RIGHT' } });
    expect(observed.after).toEqual(observed.before);
    expect(observed.old).toEqual({ summary: 'Historical conclusion', diff: 'historical diff' });
    expect(observed.overall).toBe('My authored overall review.');
    expect(observed.edited.status).toBe('unverified');
    expect(observed.instructions).toContain('My authored pending draft.');
    expect(observed.instructions).toContain('Historical conclusion');
  });

  it.each(['pr', 'council'].flatMap(mode => ['missing', 'failed'].map(outcome => [mode, outcome])))
  ('keeps %s process %s outcomes unverified without changing saved text or commits', (mode, outcome) => {
    const observed = run(mode, 'structured', outcome);
    expect(observed.run.status).toBe(outcome === 'failed' ? 'failed' : 'completed');
    expect(observed.guidance).toHaveLength(3);
    for (const item of observed.guidance) expect(item).toMatchObject({ status: 'unverified', relevance: 'unverified', suggested_body: null, location: null });
    expect(observed.after).toEqual(observed.before);
    expect(observed.overall).toBe('My authored overall review.');
  });
});
