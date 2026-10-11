// Supplement the preserved isolated-auth failures with explicit normal-auth
// replays. Never overlap the original continuous native capture or queue.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),dir=path.resolve(process.argv[2]??'artifacts/controller-v72'),app=process.argv[3];
assert(app&&dir.startsWith(root+path.sep)&&path.resolve(app).startsWith(root+path.sep));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),relative=x=>path.relative(root,x);
const queue={status:'waiting_for_original_queue',startedAt:new Date().toISOString(),authMode:'saved-plan',tasks:[]};
const persist=()=>writeFile(path.join(dir,'plan-validation-queue.json'),JSON.stringify(queue,null,2));await persist();
while(JSON.parse(await readFile(path.join(dir,'validation-queue.json'))).status!=='complete')await sleep(5000);
const tasks=[];
// Validate Codex on this exact auth-enabled binary first. Its conversation
// implementation is unchanged; the same binary then exercises plan HTTP.
for(const backend of ['codex','chatgpt']){
 for(const [name,plan]of [['contextual','contextual-session'],['reasoning','reasoning-probes'],['meeting-behavior','meeting-behavior']])tasks.push([`${name}-plan-auth-${backend}`,plan,backend]);
 if(backend==='chatgpt')tasks.push(['hour-plan-auth-chatgpt','hour-session',backend]);
}
for(let repetition=1;repetition<=2;repetition++)for(const minutes of [0,10,30,60])for(const backend of repetition===1?['codex','chatgpt']:['chatgpt','codex'])tasks.push([`history-${minutes}-rep${repetition}-plan-auth-${backend}`,`history-${minutes}`,backend]);
for(const backend of ['codex','chatgpt'])tasks.push([`fixed-age-fresh-plan-auth-${backend}`,'fixed-age-fresh',backend]);
for(const objective of ['brief','detailed'])for(const backend of objective==='brief'?['codex','chatgpt']:['chatgpt','codex'])tasks.push([`objective-${objective}-plan-auth-${backend}`,`objective-${objective}`,backend]);
queue.status='in_progress';
for(const [name,plan,backend]of tasks){
 const record={name,backend,startedAt:new Date().toISOString()};queue.tasks.push(record);const out=path.join(dir,'native',name);
 try{const old=JSON.parse(await readFile(path.join(out,'interview.json')));record.status=old.status==='complete'&&old.stoppedCleanly?'previously_complete':'preserved_existing_failure';await persist();continue;}catch(e){if(e.code!=='ENOENT')throw e;}
 await persist();console.log(JSON.stringify({event:'authenticated_plan_trial_started',name}));
 const result=await new Promise(resolve=>{const child=spawn(process.execPath,['scripts/controller-session-replay.mjs',relative(path.join(dir,'prepared',plan+'.json')),app,relative(out),backend,backend==='chatgpt'?'saved-plan':'isolated'],{cwd:root,windowsHide:true,stdio:['ignore','inherit','inherit']});record.processId=child.pid;child.once('error',e=>resolve({error:String(e)}));child.once('exit',code=>resolve({code}));});
 record.status=result.code===0?'finished':'failed';Object.assign(record,result);record.completedAt=new Date().toISOString();await persist();
 // A failed authentication preflight cannot be repaired by repeating every
 // workload. Preserve the failure and stop this queue until reauthentication.
 if(result.code!==0){const journal=JSON.parse(await readFile(path.join(out,'interview.json')));if(/access expired|revoked|saved authorized|sign in/i.test(journal.failure??'')){queue.status='authentication_required';await persist();process.exitCode=1;break;}}
}
if(queue.status==='in_progress')queue.status='complete';queue.completedAt=new Date().toISOString();await persist();
