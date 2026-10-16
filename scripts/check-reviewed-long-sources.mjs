// PREPARED ONLY: serialize actual-source checks after BOTH measured queues stop.
// Contracts are explicit external review data; this file never enters the app.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {observedGenerationProjection} from './lib/observed-generation-projection.mjs';
const [reviewFile,planFile,out]=process.argv.slice(2);
assert(reviewFile&&planFile&&out,'FINAL_REVIEW EXTERNAL_CONTRACT_PLAN NEW_OUTPUT');
const sha=x=>createHash('sha256').update(x).digest('hex');
const root=process.cwd(),absoluteOut=path.resolve(out);
assert(absoluteOut.startsWith(root+path.sep),'Output must stay in workspace');
const captures=[];
for(const file of ['artifacts/controller-v73/reliability-live-r1/verification.json','artifacts/controller-v73/reliability-controls-r1/verification.json']){
 const b=await readFile(file),q=JSON.parse(b);
 assert.equal(q.status,'complete_pending_manual_review','No compiler, fixture or model execution during either measured queue');
 for(const t of q.tasks){const jb=await readFile(t.journalFile),j=JSON.parse(jb);assert.equal(sha(jb),t.journalSha256);assert(j.status==='complete'&&j.stoppedCleanly);}
 captures.push({file,sha256:sha(b)});
}
const probe="$ErrorActionPreference='Stop'; $ownedMatches=@(Get-CimInstance Win32_Process -Filter \"Name = 'wavesSvc64.exe' OR Name = 'nemo-speech.exe'\" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\controller-',[System.StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\nemotron\\',[System.StringComparison]::OrdinalIgnoreCase)) } | Select-Object ProcessId,Name); ConvertTo-Json -InputObject $ownedMatches -Compress; exit 0";
assert.equal(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',probe],{windowsHide:true,encoding:'utf8'}).trim(),'[]','Owned measured native/ASR still active');
const rb=await readFile(reviewFile),review=JSON.parse(rb),pb=await readFile(planFile),plan=JSON.parse(pb);
assert.equal(plan.reviewSha256,sha(rb),'Pin the actual complete manual review');
const jb=await readFile(review.journal.file),j=JSON.parse(jb);
assert.equal(sha(jb),review.journal.sha256);assert(j.status==='complete'&&j.stoppedCleanly);
assert(j.actualInterviewDurationMs>=10800000);assert.equal(j.rows.length,113);assert.equal(review.reviewedRows,113);assert.equal(review.rows.length,113);
const projection=observedGenerationProjection(j);assert.equal(projection.unverified.length,0);
for(const n of review.rows){const actual=projection.rows.find(r=>r.round===n.round);assert(actual);assert.equal(sha(actual.answer),n.answerSha256);}
const allowed=new Map([
 ['scripts/check-controller-answer-code.mjs',process.execPath],
 ['scripts/check-controller-answer-python.py','python'],
 ['scripts/check-controller-route-diagnostic.py','python'],
 ['scripts/check-controller-answer-sql.mjs',process.execPath],
 ['scripts/compile-controller-answer-cuda.mjs',process.execPath],
 ['scripts/check-reviewed-warp-sources.mjs',process.execPath],
 ['scripts/check-sql-declared-actor.mjs',process.execPath],
 ['scripts/check-reviewed-extra-cuda.mjs',process.execPath]
]);
assert(Array.isArray(plan.steps)&&plan.steps.length);
for(const s of plan.steps){assert(allowed.has(s.script));assert(/^[a-z0-9-]+$/.test(s.name));assert(Array.isArray(s.checks)&&s.checks.length);for(const c of s.checks)assert(review.rows.some(r=>r.round===c.round),'Every source requires actual manual review');}
assert.equal(new Set(plan.steps.map(s=>s.name)).size,plan.steps.length);
await mkdir(absoluteOut);
const projectionFile=path.join(absoluteOut,'observed-same-generation-journal.json');
const projectedBytes=Buffer.from(JSON.stringify({...j,rows:projection.rows},null,2)+'\n');await writeFile(projectionFile,projectedBytes,{flag:'wx'});
const report={status:'verifying',startedAt:new Date().toISOString(),captures,review:{file:reviewFile,sha256:sha(rb)},plan:{file:planFile,sha256:sha(pb)},originalJournal:review.journal,projection:{file:path.relative(root,projectionFile),sha256:sha(projectedBytes),changes:projection.changes,utilitySha256:sha(await readFile('scripts/lib/observed-generation-projection.mjs')),scope:projection.scope},steps:[],scope:'Actual reviewed 113-turn source bytes; later output/lifecycle resolved only for the identical original generation, input, context, revision and acceptance. Original immutable journal remains untouched. External original-interface contracts and separately labelled emitted-interface diagnostics never enter production. Finite execution, printed universal reasoning and NVIDIA hardware are separate outcomes.'};
const persist=()=>writeFile(path.join(absoluteOut,'verification.json'),JSON.stringify(report,null,2)+'\n');await persist();
async function run(step){
 const sf=path.join(absoluteOut,step.name+'-spec.json'),target=path.join(absoluteOut,step.name);
 const spec={...(step.options??{}),journalSha256:sha(projectedBytes),checks:step.checks};
 if(step.script==='scripts/compile-controller-answer-cuda.mjs'){
  spec.rows=step.checks.map(c=>({round:c.round,answerSha256:review.rows.find(n=>n.round===c.round).answerSha256}));delete spec.checks;spec.scope=step.scope;
 }
 await writeFile(sf,JSON.stringify(spec,null,2)+'\n',{flag:'wx'});
 const args=step.script==='scripts/compile-controller-answer-cuda.mjs'?[step.script,projectionFile,step.toolchainFile,target,sf]:[step.script,projectionFile,sf,target];
 const actual={name:step.name,script:step.script,args,startedAt:new Date().toISOString()};report.steps.push(actual);await persist();
 let log='';const code=await new Promise(resolve=>{
  const child=spawn(allowed.get(step.script),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});actual.processId=child.pid;
  child.stdout.on('data',d=>{log+=d;process.stdout.write(d);});child.stderr.on('data',d=>log+=d);
  child.once('error',e=>{actual.infrastructureFailure=String(e);log+=String(e);resolve(-1);});child.once('exit',resolve);
 });
 await writeFile(path.join(absoluteOut,step.name+'.log'),log,{flag:'wx'});Object.assign(actual,{code,completedAt:new Date().toISOString()});await persist();
 assert.equal(code,0,'Checker infrastructure failed; preserve this attempt, do not infer model failure');
 if(step.script!=='scripts/compile-controller-answer-cuda.mjs'){
  const resultBytes=await readFile(path.join(target,'results.json')),results=JSON.parse(resultBytes);
  const infrastructure=(results.results??[]).find(r=>r.compile?.error||r.execution?.error);
  if(infrastructure){actual.infrastructureFailure=infrastructure.compile?.error??infrastructure.execution.error;await persist();throw Error('Recorded checker spawn failed; no model verdict: '+actual.infrastructureFailure);}
  actual.resultsSha256=sha(resultBytes);await persist();
 }
}
try{for(const step of plan.steps)await run(step);report.status='complete_pending_manual_review';}
catch(e){report.status='failed';report.failure=String(e);process.exitCode=1;}
report.completedAt=new Date().toISOString();await persist();console.log(JSON.stringify({status:report.status,steps:report.steps.length,failure:report.failure??null}));
