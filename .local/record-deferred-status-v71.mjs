import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='artifacts/deep-interview-v71',hash=x=>createHash('sha256').update(x).digest('hex');
const readQueue=async name=>{const raw=await readFile(root+'/'+name);return {file:root+'/'+name,sha256AtSnapshot:hash(raw),entries:raw.toString().replace(/^\uFEFF/,'').trim().split('\n').map(line=>JSON.parse(line.replace(/^\uFEFF/,'')))};};
const recording=await readQueue('recording-queue.jsonl'),deferred=await readQueue('deferred-queue.jsonl');
assert.equal(recording.entries[0].event,'started');assert.equal(deferred.entries[0].event,'waiting_for_recordings');
assert.equal(deferred.entries[0].recordingOwner,recording.entries[0].ownerPid);
const files=['.local/run-deferred-v71.ps1','.local/run-policy-controls-v71.ps1','.local/prepare-policy-controls-v71.mjs','.local/record-policy-playback-v71.mjs','.local/run-assessments-v71.ps1','.local/analyze-architecture-v71.mjs','.local/inspect-row-v71.mjs'];
const helpers=[];for(const file of files){const raw=await readFile(file);helpers.push({file,sha256:hash(raw)});}
const checkpointFile='docs/evidence/architecture-r34-checkpoint-v71.json',raw=await readFile(checkpointFile),checkpoint=JSON.parse(raw),p=checkpoint.pipeline;
const report={recordedAt:new Date().toISOString(),recording,deferred,helperRevisions:helpers,
 ordering:['Finish all three full hours, hard probes and continuous pressure','Run 24 fresh-meeting matched policy controls','Build and run isolated independent assessments','Complete substantive checks, final source audit and consolidated report'],
 currentCapture:{domain:'general',status:'in_progress_at_snapshot',lastStdoutTurnObserved:39},
 newTail:{checkpointFile,sha256:hash(raw),round:checkpoint.round,responseVersion:checkpoint.responseVersion,
  physicalEndpointToVisibleWordMs:checkpoint.firstStreamedWordMeasurement.firstVisibleStreamedWord.latencyMs,
  confirmationToSendMs:p.latestInputSent-p.questionConfirmed,sentToReaderReceiptMs:p.latestInputReaderReceived-p.latestInputSent,
  readerToConsumerMs:p.latestInputConsumed-p.latestInputReaderReceived,consumerToRetainedDeltaMs:p.retainedFirstDelta-p.latestInputConsumed,
  retainedDeltaToNativeVisibleMs:p.firstVisible-p.retainedFirstDelta,readerFullQueueCount:p.readerFullQueueCount,
  interpretation:'This live row differs from earlier submission/receipt tails: most waiting happens after matching final-input consumption and before the final decoded prefix. Provider compute, raw output arrival/field order, and decoding are not isolated by this trace. Final word retention and answer correctness require the clean journal and deferred reviewer.'},
 limits:['Queue files are historical snapshots, not independent proof of current liveness. Owner process identity was verified when the waiting job launched; final terminal records and source hashes are still required.','Helper changes affect measurement/audit orchestration. Production prompts, routing, timing policies and answer logic are unchanged.','No final hour p95 or independent accuracy reported before recording and assessment finish.'],
 goalComplete:false};
const output='docs/evidence/deferred-architecture-status-v71.json';await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({output,helpers:helpers.length,newTail:report.newTail}));
