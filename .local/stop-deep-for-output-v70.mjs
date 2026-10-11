import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {connectNativePages} from '../scripts/lib/native-cdp.mjs';
const directory='artifacts/deep-interview-v70/algorithms-smoke-r2',file=`${directory}/interview.json`;
const raw=await readFile(file),journal=JSON.parse(raw);
await copyFile(file,`${directory}/interview-before-output-switch.json`);
const connection=await connectNativePages(9239);
try{
 const invoke=(name)=>connection.main.evaluate(name=>window.__TAURI_INTERNALS__.invoke(name),name);
 const jobs=await invoke('acceptance_jobs');
 const events=await connection.main.evaluate(()=>window.nativeInterviewEvents);
 for(const row of journal.rows){
  const id=row.responseVersion?.split(':')[0],before=row.audio?.clockAnchors?.[0]?.nativeMs;
  const job=id?jobs.jobs.find(j=>j.question.id===id):jobs.jobs.filter(j=>j.confirmed&&j.question.detectedAt>=before).at(-1);
  if(job)Object.assign(row,{answer:job.answer,latency:job.latency,phase:job.phase,cancelled:job.cancelled,error:job.error,
   selectedContext:job.selectedContext,recognizedQuestion:job.question.text,responseVersion:`${job.question.id}:${job.latency.responseRevision??0}`});
 }
 const paint=await connection.overlay.evaluate(()=>window.deepPaintSamples);
 if(Array.isArray(paint))journal.overlayPaintSamples=paint;
 await writeFile(`${directory}/output-switch-stop-audit.json`,JSON.stringify({recordedAt:new Date().toISOString(),
  priorJournalSha256:createHash('sha256').update(raw).digest('hex'),reason:'User requested T24E390 instead of Momentum; owning runner stopped before this read-only capture and native stop.',jobs},null,2),{flag:'wx'});
 await writeFile(`${directory}/event-log.json`,JSON.stringify(events,null,2));
 await invoke('stop_meeting');
 const stopped=await invoke('get_snapshot');
 journal.status='failed';journal.failure='Interrupted to apply user-requested output switch from Momentum to T24E390.';
 journal.stoppedCleanly=!stopped.active&&!stopped.answer&&!stopped.questions.length;
 journal.completedAt=new Date().toISOString();
 await writeFile(file,JSON.stringify(journal,null,2));
 console.log(JSON.stringify({status:journal.status,stoppedCleanly:journal.stoppedCleanly,rows:journal.rows.length}));
}finally{connection.close();}
