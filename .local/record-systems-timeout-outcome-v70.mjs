import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const load=async file=>{const bytes=await readFile(file);return {file,sha256:hash(bytes),data:JSON.parse(bytes)};};
const preserved=await load('artifacts/deep-interview-v70/systems-hour-t/round-12-completed-row-snapshot.json');
const timing=await load('docs/evidence/systems-slow-turn-snapshot-v70.json');
assert.equal(timing.data.completedRowSnapshot.sha256,preserved.sha256);
const live=await load('artifacts/deep-interview-v70/systems-hour-t/interview.json');
const saved=preserved.data.row,current=live.data.rows.find(row=>row.round===saved.round);
assert.equal(current.answer,saved.answer);assert.equal(current.error,saved.error);assert.equal(current.phase,saved.phase);
assert(saved.error,'This clarification requires an actual recorded failure');
const id=saved.responseVersion.split(':')[0];
const history=live.data.deepObservations.flatMap(observation=>{
 const job=observation.jobs.find(job=>job.question.id===id);
 return job?[{hostBeforeMs:observation.hostBeforeMs,hostAfterMs:observation.hostAfterMs,nativeNow:observation.nativeNow,
  restartCount:job.latency.pipeline.refinementRestartCount,error:job.error??null,phase:job.phase,confirmed:job.confirmed,
  recognizedQuestion:job.question.text}]:[];
});
const firstRestartIndex=history.findIndex(item=>item.restartCount>0);assert(firstRestartIndex>0);
const after=history[firstRestartIndex],before=history[firstRestartIndex-1];assert(!before.restartCount);
const endpoint=saved.audio.playback;
assert(after.hostAfterMs<endpoint.lastVoicedDevicePositionLowerHostMs);
const reviewerFiles=['src-tauri/examples/assess-recorded-interview.rs','scripts/summarize-deep-audio-interview.mjs',
 'scripts/summarize-pressure-assessment.mjs','scripts/tests/deep-audio-assessment.test.mjs'];
const reviewerSources=[];
for(const file of reviewerFiles)reviewerSources.push({file,sha256:hash(await readFile(file))});
const report={recordedAt:new Date().toISOString(),evidence:[preserved,timing,live].map(({file,sha256})=>({file,sha256})),
 round:saved.round,questionSha256:preserved.data.questionSha256,answerSha256:preserved.data.answerSha256,
 outcome:{nativePhase:saved.phase,error:saved.error,cancelled:saved.cancelled??false,
  successfulAnswerDelivery:false,answerChars:saved.answer.length,answerTail:saved.answer.slice(-200),
  codeFenceLines:saved.answer.match(/^```.*$/gm),
  finding:'The retained CUDA listing stops inside main, in the thread-creation catch block, without its closing code fence or remaining program. The native complete phase follows cleanup of a timed-out answer and is not proof of a complete executable answer.'},
 firstVisibleRetainedWord:timing.data.visibleWord,stages:timing.data.stages,
 restartObservation:{lastNoRestart:before,firstRestart:after,
  hostOccurrenceBoundsMs:{low:before.hostBeforeMs,high:after.hostAfterMs},
  occurredBeforePhysicalSourceEndByAtLeastMs:endpoint.lastVoicedDevicePositionLowerHostMs-after.hostAfterMs,
  finding:'The single permitted refinement restart was already spent while the source question was still playing, before its essential executable-code and failure-handling tail finished. The second attempt subsequently had no further short-budget restart available.'},
 reviewerOutcomeBinding:{inputSchemaVersion:3,sources:reviewerSources,
  qualitativeErrorAndCancellationPassedToReviewer:true,examinerGradesAndNumericalTimingPassedToReviewer:false,
  nodeBindingTestPassed:true,modelReviewExecutionPending:true,buildDeferredUntilMeasuredPlaybackStops:true},
 clarifies:['docs/evidence/systems-slow-turn-snapshot-v70.json','docs/evidence/architecture-tail-replication-v70.json'],
 finalJournalBindingPending:true,model:live.data.model,effort:live.data.effort,outputDevice:live.data.outputDevice,
 productionLogicChanged:false,
 scope:'Corrects any implication that the previously described completed systems response was successful. Original immutable row already records its timeout; no measured latency or raw answer is replaced. Live journal is unfinished. Restart timing is bounded by actual sparse observations, not an exact provider-internal timestamp.'};
await writeFile('docs/evidence/systems-slow-turn-outcome-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/systems-slow-turn-outcome-v70.json',round:saved.round,outcome:report.outcome,
  restartBeforeSpeechEndAtLeastMs:report.restartObservation.occurredBeforePhysicalSourceEndByAtLeastMs,
  reviewerSchemaVersion:3,modelReviewExecutionPending:true}));
