import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='artifacts/deep-interview-v71/live-architecture-observations.jsonl',raw=await readFile(file),observations=raw.toString().trim().split('\n').map(x=>JSON.parse(x));
const observed=observations.findLast(o=>o.timings?.some(([,p])=>p.readerFullQueueCount>0));assert(observed);
const [id,p]=observed.timings.filter(([,p])=>p.readerFullQueueCount>0).sort((a,b)=>b[1].readerFullQueueCount-a[1].readerFullQueueCount)[0];
const difference=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?a-b:null;
const report={recordedAt:new Date().toISOString(),source:{file,snapshotSha256:createHash('sha256').update(raw).digest('hex')},
 observationHostBounds:{before:observed.hostBeforeMs,after:observed.hostAfterMs},nativeNow:observed.nativeNow,
 questionId:id,pipeline:p,
 stages:{confirmationToFinalSendMs:difference(p.latestInputSent,p.questionConfirmed),sentToReaderReceiptMs:difference(p.latestInputReaderReceived,p.latestInputSent),
 readerReceiptToConsumerMs:difference(p.latestInputConsumed,p.latestInputReaderReceived),consumerToRetainedDeltaMs:difference(p.retainedFirstDelta,p.latestInputConsumed),inputAckWaitMs:difference(p.latestInputAck,p.latestInputSent)},
 counters:{readerQueuePeak:p.readerQueuePeak,readerFullQueueCount:p.readerFullQueueCount,readerSendCount:p.readerSendCount,readerSendTotalUs:p.readerSendTotalUs,
 readerSendMaxUs:p.readerSendMaxUs,deltaCallbackCount:p.deltaCallbackCount,deltaCallbackTotalUs:p.deltaCallbackTotalUs,deltaCallbackMaxUs:p.deltaCallbackMaxUs},
 finding:'A real per-thread reader queue reached its full 256-event capacity. Recorded send durations sum to about one tenth of a second, with individual waits measured in milliseconds, while the matching final input event arrived more than twenty seconds after submission. This establishes local backpressure in the live run without supporting an attribution of the entire long tail to it.',
 limitations:['Counters accumulate over the trace, including its restart; they are not durations uniquely assigned to the final-input wait interval.','A blocking call still in progress has no completed duration yet. Other threads and provider internal work are not completely observed.','The first-word response and original question must be bound to this native ID in the final clean journal before treating it as a completed per-turn result.'],
 pending:['Bind native ID and source question to the final clean recording','Audit in-interval output activity and event trajectories','Complete policy controls and deferred accuracy'],goalComplete:false};
await writeFile('docs/evidence/architecture-queue-checkpoint-v71.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/architecture-queue-checkpoint-v71.json',questionId:id,stages:report.stages,counters:report.counters}));
