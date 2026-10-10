// Post-run model review only. Never concurrent with measured generation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),directory=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&directory.toLowerCase().startsWith(root.toLowerCase()+path.sep));
const journal=JSON.parse(await readFile(path.join(directory,'interview.json'),'utf8'));
assert(journal.status==='complete'&&journal.stoppedCleanly);
const output=path.join(directory,'model-review');await mkdir(output,{recursive:true});
let history='INTERVIEWER: This is a technical interview. Analyze the public hypothetical challenges and clarify missing facts.';
for(const burst of journal.rapidBursts){
 for(const [i,job] of burst.nativeJobs.entries()){
  if(!job.confirmed||job.cancelled||job.latency.completedAt==null||job.error)continue;
  history+=`\nINTERVIEWER: ${job.question.text}\nSUGGESTED ANSWER (not necessarily spoken or correct): ${job.answer}\n`;
  const request=path.join(output,`burst-${burst.index}-job-${i+1}.json`);
  await writeFile(request,JSON.stringify({scenario:{rubric:'Assess all explicit current requests, exact assumptions, code and quantitative proofs. Do not add hidden requirements.',examinerOnly:'There are no private facts or expected answers. The current question contains several coequal requests that must all be assessed; earlier requests were not withdrawn.'},round:burst.index,history},null,2));
  await new Promise((resolve,reject)=>{
   const child=spawn(path.join(root,'src-tauri/target/debug/examples/adaptive-interview.exe'),['--grade-request',request],{cwd:root,windowsHide:true,env:{...process.env,COPILOT_INTERVIEW_EXAMINER_MODEL:process.env.COPILOT_INTERVIEW_EXAMINER_MODEL??'gpt-6.1-sol',COPILOT_INTERVIEW_EXAMINER_EFFORT:process.env.COPILOT_INTERVIEW_EXAMINER_EFFORT??'low'},stdio:['ignore','ignore','pipe']});let error='';
   child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4000);});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Review failed ${code}: ${error}`)));
  });
  const review=JSON.parse(await readFile(request.replace(/\.json$/,'.review.json'),'utf8'));
  console.log(JSON.stringify({burst:burst.index,id:job.question.id,modelAssessedVerdict:review.review.verdict,omissions:review.review.omissions.length}));
 }
}
