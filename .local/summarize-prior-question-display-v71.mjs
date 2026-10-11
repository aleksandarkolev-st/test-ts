import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const [journalFile,auditFile,output]=process.argv.slice(2);assert(output);
const hash=value=>createHash('sha256').update(value).digest('hex');
const bytes=await readFile(journalFile),auditBytes=await readFile(auditFile),journal=JSON.parse(bytes),audit=JSON.parse(auditBytes);
assert.equal(audit.journalSha256??audit.journal.sha256,hash(bytes));
const jobs=new Map();
for(const job of journal.continuousPressure?.nativeJobs??[])jobs.set(job.question.id,job);
for(const observation of journal.deepObservations??[])for(const job of observation.jobs??[])jobs.set(job.question.id,job);
const candidates=audit.windows.flatMap(window=>window.intervals.map(interval=>({window,interval})))
 .sort((a,b)=>b.interval.durationMs-a.interval.durationMs);
const selected=candidates[0]??null;
let longest=null;
if(selected){
 const {window,interval}=selected,id=window.confirmedQuestionId??window.responseVersion?.split(':')[0];
 const shown=jobs.get(interval.shownQuestionId),wanted=jobs.get(id);assert(shown&&wanted);
 assert(interval.shownQuestionId!==id);assert(interval.durationMs===interval.endHostMs-interval.startHostMs);
 assert((journal.overlayPaintSamples??[]).some(paint=>paint.questionId===interval.shownQuestionId&&
  paint.revision===interval.shownRevision&&paint.visible&&paint.text.slice(paint.visibleStart,paint.visibleEnd)===interval.visibleText));
 longest={confirmedQuestionId:id,recognizedQuestion:wanted.question.text,confirmationHostMs:window.confirmationHostMs,
  shownRecognizedQuestion:shown.question.text,shownFinalPhase:shown.phase,shownFinalAnswerSha256:hash(shown.answer??''),interval};
}
const collector=fileURLToPath(import.meta.url),record={recordedAt:new Date().toISOString(),
 journal:{file:journalFile,sha256:hash(bytes)},audit:{file:auditFile,sha256:hash(auditBytes)},
 collector:{file:collector,sha256:hash(await readFile(collector))},summary:audit.summary,
 longestSingleRecordedOtherQuestionPaintInterval:longest,
 scope:'Longest individual different-question paint interval selected by duration, without topic or expected-answer filtering. This describes earlier displayed text held until the next observed paint, not new stale-token generation or rendering compute. Semantic appropriateness requires reviewing the recorded questions and text; this observation alone is not a universal failure rate.'};
await writeFile(output,JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({output,summary:audit.summary,longest}));
