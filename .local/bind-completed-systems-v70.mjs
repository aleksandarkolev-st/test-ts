import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>{const bytes=await readFile(file);return {file,sha256:hash(bytes),value:JSON.parse(bytes)};};
const base='artifacts/deep-interview-v70/systems-hour-t';
const journal=await read(`${base}/interview.json`),snapshot=await read(`${base}/round-12-completed-row-snapshot.json`);
const outcome=await read('docs/evidence/systems-slow-turn-outcome-v70.json'),duration=await read(`${base}/duration-audit.json`);
const delivery=await read(`${base}/delivery-coverage-audit.json`),states=await read(`${base}/observed-turn-state-audit.json`);
const j=journal.value;assert.equal(j.status,'complete');assert(j.stoppedCleanly);
assert.equal(duration.value.journalSha256,journal.sha256);assert.equal(delivery.value.journal.sha256,journal.sha256);
assert.equal(states.value.journalSha256,journal.sha256);
const saved=snapshot.value.row,current=j.rows.find(row=>row.round===saved.round);
for(const key of ['question','recognizedQuestion','answer','error','phase','cancelled','responseVersion'])assert.deepEqual(current[key],saved[key],key);
assert.deepEqual(current.latency,saved.latency);assert.deepEqual(current.audio.playback,saved.audio.playback);
assert.equal(hash(Buffer.from(current.question)),outcome.value.questionSha256);
assert.equal(hash(Buffer.from(current.answer)),outcome.value.answerSha256);
assert.equal(current.error,'Codex answer timed out');
const report={recordedAt:new Date().toISOString(),evidence:[journal,snapshot,outcome,duration,delivery,states].map(({file,sha256})=>({file,sha256})),
 model:j.model,effort:j.effort,examinerModel:j.examinerModel,examinerEffort:j.examinerEffort,outputDevice:j.outputDevice,
 actualInterviewDurationMs:j.actualInterviewDurationMs,requestedDurationMs:j.requestedDurationMs,
 turns:j.rows.length,primaryMetric:duration.value.summary.firstRetainedVisibleWordMs,
 missingVisibleWordMeasurements:duration.value.summary.turnsWithoutVisibleWord,
 cancelledTurns:duration.value.summary.cancelled,errorTurns:duration.value.summary.errors,
 finalSlowTurnBinding:{round:12,recordedQuestionAnswerErrorPhaseCancellationVersionLatencyAndPlaybackUnchanged:true,
  successfulAnswerDelivery:false,firstRetainedVisibleWordMs:outcome.value.firstVisibleRetainedWord.latencyMs,
  stages:outcome.value.stages,error:current.error},
 observedTurnStateSummary:states.value.summary,deliverySummary:delivery.value.summary,
 resourceSummary:{native:duration.value.summary.nativeProcessResources,recorder:duration.value.summary.recordingProcessResources,
  nativeTree:duration.value.summary.nativeProcessTreeResources},
 independentAccuracyPending:true,
 scope:'Binds the earlier sparse slow-turn analysis to the final clean systems-hour journal. Its raw answer and measured timing remain unchanged. The timeout is not counted as successful delivery. All turn rows, cancelled answers and absent visible words remain in the recording; independent accuracy and substantive checks are separate.'};
await writeFile('docs/evidence/completed-systems-recording-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({turns:report.turns,durationMinutes:report.actualInterviewDurationMs/60000,primaryMetric:report.primaryMetric,
 missing:report.missingVisibleWordMeasurements,cancelled:report.cancelledTurns,errors:report.errorTurns,slowTurnFinalBinding:true}));
