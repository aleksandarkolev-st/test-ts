import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {jobsAtObservation} from '../scripts/lib/deep-observations.mjs';
const file=process.argv[2];assert(file);
const raw=await readFile(file),journal=JSON.parse(raw),records=journal.deepObservations??[];
assert(['complete','failed'].includes(journal.status)&&journal.stoppedCleanly);
const hash=value=>createHash('sha256').update(value).digest('hex');
const latest=new Map(jobsAtObservation(records,records.length-1).map(job=>[job.question.id,job]));
const rows=journal.rows.map(row=>{
 const id=row.responseVersion?.split(':')[0],job=latest.get(id);
 return {round:row.round,questionId:id??null,sourceQuestionSha256:hash(row.question),
  captured:{phase:row.phase,cancelled:row.cancelled??false,responseVersion:row.responseVersion,
   answerChars:row.answer?.length??0,answerSha256:hash(row.answer??''),completedAt:row.latency?.completedAt??null},
  lastObserved:job?{phase:job.phase,cancelled:job.cancelled,responseVersion:`${id}:${job.latency?.responseRevision??0}`,
   answerChars:job.answer.length,answerSha256:hash(job.answer),completedAt:job.latency?.completedAt??null,
   recognizedQuestion:job.question.text}:null,
  capturedAnswerEqualsLastObserved:job?row.answer===job.answer:null,
  capturedCancellationEqualsLastObserved:job?(row.cancelled??false)===job.cancelled:null};
});
const report={recordedAt:new Date().toISOString(),sourceJournal:file,journalSha256:hash(raw),rows,
 summary:{capturedTurns:rows.length,capturedComplete:rows.filter(r=>r.captured.completedAt!=null).length,
  lastObservedComplete:rows.filter(r=>r.lastObserved?.completedAt!=null).length,
  changedAnswers:rows.filter(r=>r.capturedAnswerEqualsLastObserved===false).length,
  changedCancellationStates:rows.filter(r=>r.capturedCancellationEqualsLastObserved===false).length,
  capturedCancelled:rows.filter(r=>r.captured.cancelled).length,lastObservedCancelled:rows.filter(r=>r.lastObserved?.cancelled).length},
 lastObservationHostMs:records.at(-1)?.hostAfterMs,
 scope:'Captured turn-end responses and the last observed native job states remain distinct. The latter can include later completion, refinement or cancellation; they are not automatically the answer observed when a rapid follow-up was launched. Observations end before clean shutdown, so shutdown-induced cancellation is not reconstructed. No original recording or assessment is changed.'};
await writeFile(file.replace(/interview\.json$/u,'observed-turn-state-audit.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({source:file,summary:report.summary}));
