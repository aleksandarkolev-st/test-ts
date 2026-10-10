// Prepare new public questions for a paired isolated-session experiment.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const root=process.cwd(),destination=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&destination.toLowerCase().startsWith(root.toLowerCase()+path.sep));
try{await access(destination);throw Error('Refusing to overwrite a generated plan');}catch(error){if(error.code!=='ENOENT')throw error;}
const count=Number(process.env.COPILOT_NATIVE_RAPID_QUESTIONS??3),bursts=Number(process.env.COPILOT_NATIVE_RAPID_BURSTS??2);
assert(Number.isInteger(count)&&count>=2&&count<=12&&Number.isInteger(bursts)&&bursts>=1&&bursts<=100);
const model=process.env.COPILOT_INTERVIEW_EXAMINER_MODEL??'gpt-6.1-sol',effort=process.env.COPILOT_INTERVIEW_EXAMINER_EFFORT??'low';
const binary=path.join(root,'src-tauri/target/debug/examples/adaptive-interview.exe');
const directory=destination.replace(/\.json$/u,'')+'-generation';await mkdir(directory,{recursive:true});
const plan={status:'in_progress',runId:randomUUID(),createdAt:new Date().toISOString(),model,effort,tier:'fast',
 brief:process.env.COPILOT_NATIVE_INTERVIEW_BRIEF??'Very hard rapid-fire interviews across GPU programming, ROCm, performance engineering, Linux, Windows, InfiniBand/RDMA, algorithms and distributed systems. Include vague symptoms, exact code reasoning, changed constraints and progressively deeper questions. Vary topics and order, never a question bank or canned answers.',
 scope:'Fresh generated public questions for matched isolated-model comparisons. Prepared before candidate responses; later questions use prior public premises, not presumed candidate answers. This paired control is not an answer-adaptive hour-long interview.',
 binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),bursts:[]};
let history='Technical interview: reason about hypothetical challenges and clarify missing facts.';
for(let index=1;index<=bursts;index++){
 const request=path.join(directory,`burst-${index}.json`);await writeFile(request,JSON.stringify({runId:plan.runId,brief:plan.brief,count,history},null,2));
 await new Promise((resolve,reject)=>{
  const child=spawn(binary,['--generate-burst',request],{cwd:root,windowsHide:true,env:{...process.env,COPILOT_INTERVIEW_EXAMINER_MODEL:model,COPILOT_INTERVIEW_EXAMINER_EFFORT:effort},stdio:['ignore','ignore','pipe']});let error='';
  child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4000);});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Burst generation failed ${code}: ${error}`)));
 });
 const raw=await readFile(request.replace(/\.json$/,'.burst.json')),generated=JSON.parse(raw);
 plan.bursts.push({index,questions:generated.questions,generationSha256:createHash('sha256').update(raw).digest('hex')});
 history+=generated.questions.map(question=>`\nINTERVIEWER: ${question}`).join('');
 await writeFile(destination,JSON.stringify(plan,null,2));
}
plan.status='complete';plan.completedAt=new Date().toISOString();await writeFile(destination,JSON.stringify(plan,null,2));console.log(JSON.stringify({destination,runId:plan.runId,bursts,count}));
