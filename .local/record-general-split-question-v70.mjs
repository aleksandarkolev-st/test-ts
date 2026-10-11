// Explain a source question split across native jobs without treating its
// final job's shorter recognized text as proof that earlier clauses vanished.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {jobsAtObservation} from '../scripts/lib/deep-observations.mjs';
import {transcriptWordError} from '../scripts/lib/interview-metrics.mjs';
const file='artifacts/deep-interview-v70/general-hour-t/interview.json';
const bytes=await readFile(file),journal=JSON.parse(bytes);
assert(journal.status==='complete'&&journal.stoppedCleanly,'Wait for the clean completed general recording');
const row=journal.rows.find(row=>row.round===8);assert(row);
const ids=[...new Set(row.events.filter(event=>event.name==='question.confirmed').map(event=>event.payload.id))];
const latest=new Map(jobsAtObservation(journal.deepObservations,journal.deepObservations.length-1).map(job=>[job.question.id,job]));
const jobs=ids.map(id=>latest.get(id));assert(jobs.every(Boolean));
const hash=value=>createHash('sha256').update(value).digest('hex');
const normalized=value=>value.replace(/^REMOTE:\s*/gmu,'').replace(/\s+/gu,' ').trim().toLowerCase();
const finalId=row.responseVersion.split(':')[0],prior=jobs.filter(job=>job.question.id!==finalId);
const report={recordedAt:new Date().toISOString(),journal:{file,sha256:hash(bytes)},round:row.round,
 sourceQuestion:row.question,finalJobRecognizedQuestion:row.recognizedQuestion,
 selectedContextSha256:hash(row.selectedContext),capturedAnswerSha256:hash(row.answer),
 nativeJobs:jobs.map(job=>({id:job.question.id,recognizedQuestion:job.question.text,
  phase:job.phase,cancelled:job.cancelled,answerSha256:hash(job.answer),answerChars:job.answer.length,
  includedInCapturedContext:job.question.id===finalId?null:normalized(row.selectedContext).includes(normalized(job.question.text))})),
 priorJobCount:prior.length,
 rowOnlyLexicalDisagreement:transcriptWordError(row.question,row.recognizedQuestion),
 orderedNativeJobUnionLexicalDisagreement:transcriptWordError(row.question,jobs.map(job=>job.question.text).join(' ')),
 finalNativeJobMatchesCapturedAnswer:latest.get(finalId)?.answer===row.answer,
 scope:'Offline source-bound audit of one long source question. The row stores the last native job selected for its waveform; its shorter recognized text alone is not evidence of ASR clause deletion. Earlier recognized clauses and partial answer are checked against the actual supplied selected context. Lexical comparisons include spoken-code and numeral spelling differences and do not establish semantic accuracy. No captured text, answer, job or measurement is changed.'};
await writeFile('docs/evidence/general-split-question-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({round:row.round,nativeJobs:jobs.length,priorContextCoverage:report.nativeJobs.filter(job=>job.includedInCapturedContext!==null).map(job=>job.includedInCapturedContext),rowOnlyLexicalDisagreement:report.rowOnlyLexicalDisagreement,orderedNativeJobUnionLexicalDisagreement:report.orderedNativeJobUnionLexicalDisagreement}));
