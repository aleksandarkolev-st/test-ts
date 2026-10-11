// Sequential native trials: never overlap device playback or inference. Each
// child keeps failures in its journal. Resume skips only completed, clean runs.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),runRoot=path.resolve(process.argv[2]??'artifacts/controller-v72');
assert(runRoot.startsWith(root+path.sep));const relative=x=>path.relative(root,x),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const finalHour=path.join(runRoot,'native/hour-final-codex/interview.json');
// Preserve and wait for the first elapsed-hour capture before rebuilding.
while(true){const journal=JSON.parse(await readFile(finalHour));if(journal.status!=='in_progress')break;await sleep(5000);}
const tasks=[];
const replay=(name,plan,backend)=>tasks.push({name,backend,args:['scripts/controller-session-replay.mjs',relative(plan),'.local/controller-app',relative(path.join(runRoot,'native',name)),backend],journal:path.join(runRoot,'native',name,'interview.json')});
for(const backend of ['codex','chatgpt']){
 replay(`contextual-range-final-${backend}`,path.join(runRoot,'prepared/contextual-session.json'),backend);
 replay(`reasoning-range-${backend}`,path.join(runRoot,'prepared/reasoning-probes.json'),backend);
 replay(`meeting-behavior-range-${backend}`,path.join(runRoot,'prepared/meeting-behavior.json'),backend);
 replay(`hour-display-${backend}`,path.join(runRoot,'prepared/hour-session.json'),backend);
}
// One continuous application/session, with real 60/120/180-minute recall and
// version corrections. Repeating reset sessions cannot satisfy this cell.
replay('marathon-three-hours-codex',path.join(runRoot,'prepared/marathon-session.json'),'codex');
// Interleave adapter pairs. Every history cell uses the same bytes of frozen
// context and question, and one identical waveform. History and process age
// are measured in different cells.
for(let repetition=1;repetition<=2;repetition++)for(const minutes of [0,10,30,60]){
 const order=repetition===1?['codex','chatgpt']:['chatgpt','codex'];
 for(const backend of order)replay(`history-${minutes}-rep${repetition}-${backend}`,path.join(runRoot,`prepared/history-${minutes}.json`),backend);
}
for(const backend of ['codex','chatgpt']){
 replay(`fixed-age-fresh-${backend}`,path.join(runRoot,'prepared/fixed-age-fresh.json'),backend);
 for(const objective of ['brief','detailed'])replay(`objective-${objective}-${backend}`,path.join(runRoot,`prepared/objective-${objective}.json`),backend);
}
// Same Codex/model/effort/context/output objective on the measured c704a75
// baseline and the replacement. Alternate order in the second repetition.
for(let repetition=0;repetition<2;repetition++)for(let index=0;index<6;index++){
 const order=repetition===0?['baseline','controller']:['controller','baseline'];
 for(const variant of order){const name=`case-${index}-rep${repetition+1}-${variant}`,out=path.join(runRoot,'native',name);
  tasks.push({name,backend:'codex',args:['scripts/controller-native-control.mjs',relative(runRoot),variant==='baseline'?'.local/controller-baseline-app':'.local/controller-app',variant==='baseline'?'.local/controller-baseline':'.',relative(out),String(index),String(repetition),variant],journal:path.join(out,'playback.json')});
 }
}
await mkdir(runRoot,{recursive:true});const queue={startedAt:new Date().toISOString(),status:'in_progress',tasks:[]};
const persist=()=>writeFile(path.join(runRoot,'validation-queue.json'),JSON.stringify(queue,null,2));
for(const task of tasks){
 const record={name:task.name,backend:task.backend,startedAt:new Date().toISOString()};queue.tasks.push(record);
 try{const existing=JSON.parse(await readFile(task.journal));if(existing.status==='complete'&&existing.stoppedCleanly){record.status='previously_complete';await persist();continue;}throw Error('Preserved unsuccessful existing trial; use a new explicit trial name for a retry');}catch(error){if(error.code!=='ENOENT'){record.status='preserved_existing_failure';record.reason=String(error);await persist();continue;}}
 await persist();console.log(JSON.stringify({event:'trial_started',name:task.name,backend:task.backend}));
 const result=await new Promise(resolve=>{const child=spawn(process.execPath,task.args,{cwd:root,windowsHide:true,env:{...process.env,COPILOT_CONTROLLER_BACKEND:task.backend},stdio:['ignore','inherit','inherit']});record.processId=child.pid;
  child.once('error',error=>resolve({error:String(error)}));child.once('exit',code=>resolve({code}));});
 record.status=result.code===0?'finished':'failed';Object.assign(record,result);record.completedAt=new Date().toISOString();await persist();
}
queue.status='complete';queue.completedAt=new Date().toISOString();await persist();
