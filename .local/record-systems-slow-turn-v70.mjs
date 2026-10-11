import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {streamedWordLatency} from '../scripts/lib/streamed-word-latency.mjs';
const file='artifacts/deep-interview-v70/systems-hour-t/interview.json';
const bytes=await readFile(file),journal=JSON.parse(bytes),row=journal.rows.find(row=>row.round===12);
assert(row?.phase==='complete'&&row.latency?.completedAt!=null);
const hash=value=>createHash('sha256').update(value).digest('hex');
const codexFile='src-tauri/src/openai/codex.rs',codexHash=hash(await readFile(codexFile));
assert.equal(journal.sourceHashes[codexFile],codexHash);
const measured=streamedWordLatency(journal,row);assert(measured.firstRetainedVisibleStreamedWord);
const anchors=row.audio.clockAnchors;
const offsetLow=Math.max(...anchors.map(a=>a.nativeMs-a.hostAfterMs));
const offsetHigh=Math.min(...anchors.map(a=>a.nativeMs-a.hostBeforeMs));assert(offsetLow<=offsetHigh);
const physicalEndpoint={low:row.audio.playback.lastVoicedDevicePositionLowerHostMs+offsetLow,
 high:row.audio.playback.lastVoicedDevicePositionUpperHostMs+offsetHigh};
const p=row.latency.pipeline;
const snapshot={recordedAt:new Date().toISOString(),source:{file,sha256:hash(bytes),status:journal.status},row,
 questionSha256:hash(row.question),answerSha256:hash(row.answer),codexSourceSha256:codexHash};
const snapshotFile='artifacts/deep-interview-v70/systems-hour-t/round-12-completed-row-snapshot.json';
const snapshotBytes=Buffer.from(JSON.stringify(snapshot,null,2));await writeFile(snapshotFile,snapshotBytes,{flag:'wx'});
const report={recordedAt:new Date().toISOString(),completedRowSnapshot:{file:snapshotFile,sha256:hash(snapshotBytes)},
 source:snapshot.source,round:row.round,model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 question:row.question,questionSha256:snapshot.questionSha256,answerSha256:snapshot.answerSha256,
 codexSourceSha256:codexHash,visibleWord:measured.firstRetainedVisibleStreamedWord,physicalEndpointNativeMs:physicalEndpoint,
 stages:{physicalEndpointToFinalConfirmationMs:{low:p.questionConfirmed-physicalEndpoint.high,high:p.questionConfirmed-physicalEndpoint.low},
  finalConfirmationToFinalInputSentMs:p.latestInputSent-p.questionConfirmed,
  finalInputRpcAckMs:p.latestInputAck-p.latestInputSent,
  finalInputSentToConsumptionEventMs:p.latestInputConsumed-p.latestInputSent,
  consumptionEventToRetainedFirstDeltaMs:p.retainedFirstDelta-p.latestInputConsumed,
  retainedFirstDeltaToNativeVisibleMs:p.firstVisible-p.retainedFirstDelta,
  foregroundSemaphoreWaitMs:p.semaphoreAcquired-p.codexStreamEntered},
 outcome:{nativePhase:row.phase,error:row.error??null,cancelled:row.cancelled??false,
  successfulAnswerDelivery:row.latency?.completedAt!=null&&!row.error&&!row.cancelled},
 counters:{steers:p.steeringCount,followups:p.followupCount,restarts:p.refinementRestartCount,
  initialPromptChars:p.promptChars,restartPromptChars:p.restartPromptChars,totalRefinementChars:p.refinementChars},
 finalJournalBindingPending:true,
 scope:'A terminal response with separately recorded error/cancellation outcome preserved from the live, unfinished systems-hour recording. Native complete phase is not a delivery-success claim. Exact row, question, answer, audio endpoint and source-code hashes are retained; bind these to the final journal after clean termination. Consumption is an application-observed matching userMessage completion event, not measured provider-internal queue, reasoning or GPU time. This does not certify full-hour duration or overall accuracy. No product logic changed.'};
await writeFile('docs/evidence/systems-slow-turn-snapshot-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({...report,question:undefined}));
