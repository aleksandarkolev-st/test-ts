import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/continuous-pressure-t';
const bytes=await readFile(`${directory}/interview.json`),journal=JSON.parse(bytes);
const sha256=createHash('sha256').update(bytes).digest('hex');
const audit=JSON.parse(await readFile(`${directory}/pressure-audit.json`));
const events=JSON.parse(await readFile(`${directory}/pressure-events-audit.json`));
const visibility=JSON.parse(await readFile(`${directory}/pressure-visibility-audit.json`));
for(const item of [audit,events,visibility])assert.equal(item.journalSha256,sha256);
assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
const pressure=journal.continuousPressure;
const playbackMs=pressure.playback.completedHostMs-pressure.playback.submitBeforeHostMs;
assert(playbackMs>=1800000);assert.equal(pressure.playback.frameMarkers.length,pressure.segments.length);
const memory=field=>({first:journal.nativeResources.at(0)[field],last:journal.nativeResources.at(-1)[field],max:Math.max(...journal.nativeResources.map(r=>r[field]))});
const record={recordedAt:new Date().toISOString(),source:{file:`${directory}/interview.json`,sha256},
 model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,microphoneUsed:journal.speechConfiguration.selfCapture.physicalMicrophoneUsed,
 status:journal.status,stoppedCleanly:journal.stoppedCleanly,playbackMs,sourceDurationMs:pressure.sourceDurationMs,
 sourceSegments:pressure.segments.length,uniqueSourceClips:new Set(pressure.segments.map(s=>s.clipId)).size,repeatedSourceCycles:pressure.repeatedSourceCycles,
 endpointMarkers:pressure.playback.frameMarkers.length,clockAnchors:pressure.clockAnchors,
 nativeJobMeasurements:audit.summary,
 differentQuestionVisibility:{...visibility.summary,scope:visibility.scope,semanticAssessmentPending:true},
 eventRecording:{file:`${directory}/native-events-observer.jsonl`,sha256:events.eventsSha256,counts:events.eventCounts,coverage:events.coverage,instrumentation:events.instrumentation},
 resources:{nativeSamples:journal.nativeResources.length,nativeWorkingSetBytes:memory('workingSetBytes'),nativePrivateBytes:memory('privateBytes'),
  nativeTreePrivateBytes:{first:journal.nativeResources.at(0).nativeTree?.nativeTreePrivateBytes,last:journal.nativeResources.at(-1).nativeTree?.nativeTreePrivateBytes},
  recorder:{first:journal.recorderResources.at(0),last:journal.recorderResources.at(-1)},pollErrors:journal.pollErrors.length,
  scope:'Native process, current descendants and Node recorder are separate measurements. Descendant working-set sums can double count shared pages. GPU allocations, sibling playback/examiner processes and the additional event observer are excluded.'},
 independentAccuracyPending:true,sourceClauseMatchingPending:true,latencyDriftAssessmentPending:true,
 scope:'Completed uninterrupted synthetic audio pressure recording. Native jobs and source clips have separate denominators. Missing, cancelled and unfinished answers remain recorded. Event tail coverage and zero polling errors do not establish semantic correctness or absence of clause loss. No product logic changed.'};
await writeFile('docs/evidence/continuous-pressure-recording-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
const progress=JSON.parse(await readFile('artifacts/deep-interview-v70/requirements-progress-after-memory.json'));
progress.recordedAt=new Date().toISOString();progress.goalComplete=false;
progress.completedPressure={file:'docs/evidence/continuous-pressure-recording-v70.json',journalSha256:sha256,playbackMs,independentAccuracyPending:true};
progress.additionalArchitectureEvidence='docs/evidence/refinement-queue-analysis-v70.json';
progress.backendComparisonPreparation={finalPromptHelper:'src-tauri/examples/compare-answer-backends.rs',nativePlaybackHelper:'.local/record-backend-playback-v70.mjs',serialLauncher:'.local/run-chatgpt-comparison-v70.ps1',executionPending:true};
progress.currentRecording={domain:'systems',file:'artifacts/deep-interview-v70/systems-hour-t/interview.json'};
for(const requirement of progress.requirements??[])if(requirement.id===10){requirement.state='recorded_pending_semantic_and_drift_assessment';requirement.evidence=[...(requirement.evidence??[]),'docs/evidence/continuous-pressure-recording-v70.json'];}
await writeFile('artifacts/deep-interview-v70/requirements-progress-after-pressure.json',JSON.stringify(progress,null,2),{flag:'wx'});
console.log(JSON.stringify({playbackMs,sourceSegments:record.sourceSegments,nativeJobs:audit.summary.nativeJobs,accuracyPending:true}));
