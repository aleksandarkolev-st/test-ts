import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/continuous-pressure-t';
const bytes=await readFile(`${directory}/interview.json`),journal=JSON.parse(bytes),sha256=createHash('sha256').update(bytes).digest('hex');
const original=JSON.parse(await readFile(`${directory}/pressure-visibility-audit.json`));
const events=JSON.parse(await readFile(`${directory}/pressure-events-audit.json`));
assert.equal(original.journalSha256,sha256);assert.equal(events.journalSha256,sha256);
const jobs=new Map(journal.continuousPressure.nativeJobs.map(job=>[job.question.id,job]));
const bounds=native=>({low:native-events.clockOffsetMs.high,high:native-events.clockOffsetMs.low});
const windows=original.windows.map(window=>{
 const observations=journal.deepObservations.filter(record=>record.jobs.some(job=>job.question.id===window.confirmedQuestionId));
 const before=observations.findLast(record=>record.hostAfterMs<=window.confirmationHostMs.low);
 const after=observations.find(record=>record.hostBeforeMs>=window.confirmationHostMs.high);
 const state=record=>record?{hostBeforeMs:record.hostBeforeMs,hostAfterMs:record.hostAfterMs,
  question:record.jobs.find(job=>job.question.id===window.confirmedQuestionId).question,
  phase:record.jobs.find(job=>job.question.id===window.confirmedQuestionId).phase}:null;
 const job=jobs.get(window.confirmedQuestionId),lastConfirmed=bounds(job.latency.questionConfirmedAt),end=bounds(job.latency.speechStoppedAt);
 const overlapAfter=time=>window.intervals.reduce((sum,interval)=>sum+Math.max(0,interval.endHostMs-Math.max(interval.startHostMs,time)),0);
 return {...window,recognizedQuestion:undefined,finalRecordedQuestion:window.recognizedQuestion,
  nearestObservedQuestionBeforeInitialConfirmation:state(before),nearestObservedQuestionAfterInitialConfirmation:state(after),
  lastRecordedSameJobConfirmationHostMs:lastConfirmed,finalRecordedNativeSpeechEndHostMs:end,
  differentQuestionVisibleAfterLastSameJobConfirmationMs:overlapAfter(lastConfirmed.high),
  differentQuestionVisibleAfterFinalNativeSpeechEndMs:overlapAfter(end.high)};
});
const record={...original,recordedAt:new Date().toISOString(),windows,
 summary:{...original.summary,
  maxDifferentQuestionVisibleAfterLastSameJobConfirmationMs:Math.max(0,...windows.map(w=>w.differentQuestionVisibleAfterLastSameJobConfirmationMs)),
  maxDifferentQuestionVisibleAfterFinalNativeSpeechEndMs:Math.max(0,...windows.map(w=>w.differentQuestionVisibleAfterFinalNativeSpeechEndMs))},
 clarification:'The original window begins at initial distinct-job confirmation and can include continued speech and later same-ID refinements. Its final recorded recognized text is not necessarily the question known at initial confirmation. Adjacent observed question states and final native speech/confirmation timings are provided here. Original audit is preserved; this adds context and does not change recorded timing.',
 scope:original.scope};
await writeFile(`${directory}/pressure-visibility-contextual-audit.json`,JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({...record,windows:undefined}));
