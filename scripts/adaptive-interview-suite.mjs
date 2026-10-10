// Opt-in live, serial interview evaluation using only signed-in Codex.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root=process.cwd();
const suitePath=path.resolve(process.env.COPILOT_INTERVIEW_SUITE||'tests/fixtures/gpu-interview-suite.json');
const raw=await readFile(suitePath);
const suite=JSON.parse(raw);
assert(Array.isArray(suite.cases)&&suite.cases.length>0);
assert.equal(new Set(suite.cases.map(c=>c.name)).size,suite.cases.length);
const requested=process.env.COPILOT_INTERVIEW_CASES?.split(',').filter(Boolean);
const cases=requested?suite.cases.filter(c=>requested.includes(c.name)):suite.cases;
if(requested)assert.equal(cases.length,requested.length,'Every requested case must exist');
const rounds=Number(process.env.COPILOT_INTERVIEW_ROUNDS||suite.roundsPerScenario);
assert(Number.isInteger(rounds)&&rounds>=1&&rounds<=100);
const model=process.env.COPILOT_INTERVIEW_MODEL||'gpt-6.1-sol';
const effort=process.env.COPILOT_INTERVIEW_EFFORT||'low';
const examinerModel=process.env.COPILOT_INTERVIEW_EXAMINER_MODEL||'gpt-6.1-sol';
const examinerEffort=process.env.COPILOT_INTERVIEW_EXAMINER_EFFORT||'low';
const output=path.resolve(process.env.COPILOT_INTERVIEW_OUTPUT||`artifacts/adaptive-interview/${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(output,{recursive:true});
const binary=path.resolve(process.env.COPILOT_INTERVIEW_BINARY||'src-tauri/target/debug/examples/adaptive-interview.exe');
await access(binary);
const manifestPath=path.join(output,'suite.json');
const suiteSha256=createHash('sha256').update(raw).digest('hex');
const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
const configuration={suiteSha256,binarySha256,model,effort,examinerModel,examinerEffort,rounds,cases:cases.map(c=>c.name)};
let manifest={configuration,status:'in_progress',startedAt:new Date().toISOString(),measurement:'Live text-only; excludes speech recognition and rendered visibility. Model-graded correctness requires independent review.',results:[]};
manifest.primaryLatencyMetric='firstWordMs: first alphanumeric answer character received after decoding; no word or sentence completion wait';
if(process.argv.includes('--resume')){
  const previous=JSON.parse(await readFile(manifestPath,'utf8'));
  assert.deepEqual(previous.configuration,configuration,'Resume must use the same suite and settings');
  manifest={...previous,status:'in_progress',resumedAt:new Date().toISOString()};
  delete manifest.completedAt;delete manifest.targetAchieved;delete manifest.availabilityError;
}
const persist=()=>writeFile(manifestPath,JSON.stringify(manifest,null,2));
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;
await persist();
for(const scenario of cases){
  if(manifest.results.some(r=>r.name===scenario.name&&r.status==='complete'))continue;
  console.log(`INTERVIEW ${scenario.name}: ${rounds} adaptive rounds`);
  const startedAt=new Date().toISOString();
  let stderr='';
  const exitCode=await new Promise((resolve,reject)=>{
    const child=spawn(binary,[],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,COPILOT_INTERVIEW_SUITE:suitePath,COPILOT_INTERVIEW_CASE:scenario.name,COPILOT_INTERVIEW_OUTPUT:output,COPILOT_INTERVIEW_MODEL:model,COPILOT_INTERVIEW_EFFORT:effort,COPILOT_INTERVIEW_ROUNDS:String(rounds),COPILOT_INTERVIEW_EXAMINER_MODEL:examinerModel,COPILOT_INTERVIEW_EXAMINER_EFFORT:examinerEffort,COPILOT_INTERVIEW_RESUME:process.argv.includes('--resume')?'true':'false'}});
    child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-16_000);});
    child.once('error',reject);child.once('exit',resolve);
  });
  const resultFile=path.join(output,`${scenario.name}-${model}-${effort}-continuous.json`);
  let data=null;
  try{data=JSON.parse(await readFile(resultFile,'utf8'));}catch{}
  const rows=(data?.rows||[]).filter(r=>!r.error);
  const sentences=rows.map(r=>r.firstSentenceMs).filter(Number.isFinite);
  const words=rows.map(r=>r.firstWordMs).filter(Number.isFinite);
  const row={name:scenario.name,startedAt,completedAt:new Date().toISOString(),exitCode,status:exitCode===0&&rows.length===rounds&&rows.every(r=>r.review)?'complete':'failed',rounds:rows.length,reviewed:rows.filter(r=>r.review).length,correct:rows.filter(r=>r.review?.verdict==='correct').length,incorrect:rows.filter(r=>r.review?.verdict==='incorrect').length,incomplete:rows.filter(r=>r.review?.verdict==='incomplete').length,unsupportedAssumptions:rows.filter(r=>r.review?.unsupportedAssumption===true).length,firstDeltaMedianMs:percentile(rows.map(r=>r.firstDeltaMs).filter(Number.isFinite),0.5),firstSentenceMedianMs:percentile(sentences,0.5),firstSentenceP95Ms:percentile(sentences,0.95),file:path.basename(resultFile)};
  row.firstWordMedianMs=percentile(words,0.5);row.firstWordP95Ms=percentile(words,0.95);
  row.textLatencyTargetPassed=words.length===rounds&&row.firstWordP95Ms<800;
  manifest.results=manifest.results.filter(r=>r.name!==scenario.name);manifest.results.push(row);
  if(/hit your usage limit|rate limit reached|rate.?limited/i.test(stderr)){
    row.status='rate_limited';row.availabilityError=stderr.trim();
    manifest.availabilityError=stderr.trim();manifest.status='rate_limited';
    manifest.targetAchieved=false;await persist();break;
  }
  await persist();
  console.log(`RESULT ${scenario.name}: ${row.correct}/${rounds} model-graded correct, first answer word p95 ${row.firstWordP95Ms} ms`);
}
if(manifest.status!=='rate_limited')manifest.status=manifest.results.length===cases.length&&manifest.results.every(r=>r.status==='complete')?'complete':'failed';
manifest.completedAt=new Date().toISOString();
manifest.textTargetPassed=manifest.status==='complete'&&manifest.results.every(r=>r.correct===rounds&&r.textLatencyTargetPassed);
manifest.targetAchieved=false; // Text-only model grades cannot certify the broad audio/correctness goal.
manifest.pendingCases=cases.map(c=>c.name).filter(name=>!manifest.results.some(r=>r.name===name&&r.status==='complete'));
await persist();
console.log(`Suite ${manifest.status}; target achieved: ${manifest.targetAchieved}. Evidence: ${manifestPath}`);
if(manifest.status!=='complete')process.exitCode=1;
