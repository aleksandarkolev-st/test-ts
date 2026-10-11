import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
const files=['docs/evidence/architecture-queue-checkpoint-v71.json','docs/evidence/architecture-general-r22-final-row-v71.json','artifacts/deep-interview-v71/general-hour-t/duration-audit.json'];
const hash=x=>createHash('sha256').update(x).digest('hex'),evidence=[];
for(const file of files){const raw=await readFile(file);evidence.push({file,sha256:hash(raw),data:JSON.parse(raw)});}
const [checkpoint,finalRow,audit]=evidence.map(x=>x.data);
assert.equal(audit.status,'complete');assert(audit.stoppedCleanly&&audit.durationVerified);
assert.equal(finalRow.responseVersion.split(':')[0],checkpoint.questionId);
const measured=audit.rows.find(row=>row.responseVersion===finalRow.responseVersion);assert(measured);assert.equal(measured.round,finalRow.round);assert.equal(measured.question,finalRow.question);
assert.deepEqual(measured.firstRetainedVisibleStreamedWord,finalRow.firstStreamedWordMeasurement.firstRetainedVisibleStreamedWord);
for(const field of ['readerQueuePeak','readerFullQueueCount','readerSendCount','readerSendTotalUs','readerSendMaxUs','deltaCallbackCount','deltaCallbackTotalUs','deltaCallbackMaxUs','latestInputSent','latestInputReaderReceived','latestInputConsumed'])assert.equal(finalRow.pipeline[field],checkpoint.pipeline[field]);
const journalFile='artifacts/deep-interview-v71/general-hour-t/interview.json',journalHash=createHash('sha256');
for await(const bytes of createReadStream(journalFile))journalHash.update(bytes);
assert.equal(journalHash.digest('hex'),audit.journalSha256);
const p=finalRow.pipeline;
const report={recordedAt:new Date().toISOString(),journal:{file:journalFile,sha256:audit.journalSha256,status:audit.status,stoppedCleanly:audit.stoppedCleanly},
 evidence:evidence.map(({data,...rest})=>rest),round:finalRow.round,responseVersion:finalRow.responseVersion,question:finalRow.question,
 phase:finalRow.phase,cancelled:finalRow.cancelled,error:finalRow.error,firstRetainedVisibleStreamedWord:measured.firstRetainedVisibleStreamedWord,
 stagesMs:{confirmedToSend:p.latestInputSent-p.questionConfirmed,sentToMatchingReader:p.latestInputReaderReceived-p.latestInputSent,readerToConsumer:p.latestInputConsumed-p.latestInputReaderReceived,consumerToRetainedDelta:p.retainedFirstDelta-p.latestInputConsumed,retainedDeltaToRender:p.firstVisible-p.retainedFirstDelta},
 readerQueue:{peak:p.readerQueuePeak,fullSendCount:p.readerFullQueueCount,completedSendWaitTotalMs:p.readerSendTotalUs/1000,maximumCompletedSendWaitMs:p.readerSendMaxUs/1000},
 callback:{count:p.deltaCallbackCount,totalCompletedWaitMs:p.deltaCallbackTotalUs/1000,maximumCompletedWaitMs:p.deltaCallbackMaxUs/1000},
 scope:'The earlier live full-queue observation matches the final retained response in the completed, SHA-verified general interview. The cancelled, truncated code answer remains a recorded outcome. Completed queue waits are cumulative across this thread/attempts; they do not isolate a causal interval or exclude in-progress waits and other threads blocking the shared reader. These counters are not a provider compute measurement. Accuracy remains pending independent review.',goalComplete:false};
const file='docs/evidence/general-full-queue-final-binding-v71.json';await writeFile(file,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file,round:report.round,phase:report.phase,wordLatencyMs:report.firstRetainedVisibleStreamedWord.latencyMs,stagesMs:report.stagesMs,readerQueue:report.readerQueue}));
