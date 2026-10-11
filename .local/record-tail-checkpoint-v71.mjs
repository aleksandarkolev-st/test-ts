import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {streamedWordLatency} from '../scripts/lib/streamed-word-latency.mjs';
const directory='artifacts/deep-interview-v71/general-hour-t';
const file=directory+'/interview.json';assert((await stat(file)).size<32*1024*1024,'Defer large live journal parsing');
const raw=await readFile(file),journal=JSON.parse(raw),hash=x=>createHash('sha256').update(x).digest('hex');
const observerRaw=await readFile('artifacts/deep-interview-v71/live-architecture-observations.jsonl');
const observations=observerRaw.toString().trim().split('\n').map(line=>JSON.parse(line));
const measured=journal.rows.map(row=>({row,measurement:streamedWordLatency(journal,row)}))
 .filter(item=>item.measurement.firstRetainedVisibleStreamedWord).sort((a,b)=>b.measurement.firstRetainedVisibleStreamedWord.latencyMs.high-a.measurement.firstRetainedVisibleStreamedWord.latencyMs.high);
assert(measured.length);const {row,measurement}=measured[0],id=measurement.questionId;
const observed=observations.findLast(o=>o.timings?.some(([jobId,p])=>jobId===id&&p.latestInputReaderReceived!=null&&p.latestInputConsumed!=null));
assert(observed,'Missing matched reader timing snapshot');const p=observed.timings.find(([jobId])=>jobId===id)[1];
assert(p.latestInputSent<=p.latestInputReaderReceived&&p.latestInputReaderReceived<=p.latestInputConsumed&&p.latestInputConsumed<=p.retainedFirstDelta);
const report={recordedAt:new Date().toISOString(),journalSnapshot:{file,sha256:hash(raw),status:journal.status,bytes:raw.length},
 observerSnapshotSha256:hash(observerRaw),observerHostBounds:{before:observed.hostBeforeMs,after:observed.hostAfterMs},
 nativeBinarySha256:journal.nativeBinarySha256,sourceHashes:journal.sourceHashes,diagnosticSourceHashes:journal.diagnosticSourceHashes,
 round:row.round,questionId:id,question:row.question,recognizedQuestion:row.recognizedQuestion,answerAtCheckpoint:row.answer,
 responseVersion:row.responseVersion,word:measurement.firstRetainedVisibleStreamedWord,pipeline:p,
 stages:{confirmationToFinalSendMs:p.latestInputSent-p.questionConfirmed,sentToReaderReceiptMs:p.latestInputReaderReceived-p.latestInputSent,
 readerReceiptToConsumerMs:p.latestInputConsumed-p.latestInputReaderReceived,consumerToRetainedDeltaMs:p.retainedFirstDelta-p.latestInputConsumed,
 retainedDeltaToNativeVisibleMs:p.firstVisible-p.retainedFirstDelta},
 finding:'The slowest currently observed retained word spends most of its post-confirmation delay before final input transmission and before the matching input event reaches the stdout reader. Reader receipt and async consumption coincide to millisecond resolution; this trace has no observed full output queue. Per-thread reader/callback waits are recorded separately. This narrows this response beyond the old combined consumption interval; it is not an explanation of all p95 tails or proof of provider-internal time.',
 pending:['Bind this question/version/word and timing to the final clean hour journal','Finish all fresh recordings and independent accuracy assessment','Compare complete tail distributions and resource/recorder overhead'],goalComplete:false};
await writeFile('docs/evidence/architecture-tail-checkpoint-v71.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/architecture-tail-checkpoint-v71.json',round:row.round,word:report.word,stages:report.stages,readerFullQueueCount:p.readerFullQueueCount,readerSendMaxUs:p.readerSendMaxUs,deltaCallbackMaxUs:p.deltaCallbackMaxUs}));
