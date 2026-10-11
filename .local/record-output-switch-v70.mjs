import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {jobsAtObservation} from '../scripts/lib/deep-observations.mjs';
const directory='artifacts/deep-interview-v70/algorithms-smoke-r2',original=`${directory}/interview-before-output-switch.json`;
const raw=await readFile(original),journal=JSON.parse(raw),observations=journal.deepObservations??[];
const jobs=jobsAtObservation(observations,observations.length-1);
for(const row of journal.rows){
 const id=row.responseVersion?.split(':')[0],before=row.audio?.clockAnchors?.[0]?.nativeMs;
 const job=id?jobs.find(j=>j.question.id===id):jobs.filter(j=>j.confirmed&&j.question.detectedAt>=before).at(-1);
 if(job)Object.assign(row,{answer:job.answer,latency:job.latency,phase:job.phase,cancelled:job.cancelled,error:job.error,
  recognizedQuestion:job.question.text,selectedContext:job.selectedContext,responseVersion:`${job.question.id}:${job.latency.responseRevision??0}`});
}
journal.status='failed';journal.failure='Interrupted to apply user-requested output switch from Momentum to T24E390.';
journal.stoppedCleanly=null;journal.completedAt=new Date().toISOString();
journal.cleanupFailure='Owning runner and wrapper were stopped; their app and examiner processes and CDP listener are verified absent. Graceful stop acknowledgment is unavailable.';
await writeFile(`${directory}/output-switch-stop-audit.json`,JSON.stringify({recordedAt:new Date().toISOString(),
 originalSha256:createHash('sha256').update(raw).digest('hex'),originalFile:original,
 interruption:journal.failure,cleanup:journal.cleanupFailure,recordedSnapshotCutoff:observations.at(-1)?.hostAfterMs,
 scope:'Rows refreshed only from the last recorded native observations. No later state or clean shutdown inferred.'},null,2),{flag:'wx'});
await writeFile(`${directory}/interview.json`,JSON.stringify(journal,null,2));
console.log(JSON.stringify({rows:journal.rows.length,status:journal.status,last:journal.rows.at(-1)?.phase}));
