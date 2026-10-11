import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>{const bytes=await readFile(file);return {file,sha256:hash(bytes),data:JSON.parse(bytes)};};
const prior=await read('docs/evidence/refinement-queue-analysis-v70.json');
const latest=await read('docs/evidence/systems-slow-turn-snapshot-v70.json');
const snapshot=await read(latest.data.completedRowSnapshot.file);
assert.equal(snapshot.sha256,latest.data.completedRowSnapshot.sha256);
assert.equal(snapshot.data.questionSha256,hash(snapshot.data.row.question));
assert.equal(snapshot.data.answerSha256,hash(snapshot.data.row.answer));
const files=['src-tauri/src/openai/codex.rs','src-tauri/src/runtime.rs','src-tauri/src/openai/client.rs','src-tauri/src/meeting/scheduler.rs'];
const sources={};
for(const file of files){const bytes=await readFile(file);sources[file]={sha256:hash(bytes),text:bytes.toString('utf8')};}
assert.equal(sources[files[0]].sha256,latest.data.codexSourceSha256);
assert.equal(sources[files[0]].sha256,prior.data.source.sha256);
const locate=(file,needle)=>{
 const lines=sources[file].text.split('\n');const index=lines.findIndex(line=>line.includes(needle));assert(index>=0,needle);
 return {file,line:index+1,source:lines[index].trim()};
};
const mechanism=[
 {...locate(files[0],'&& pending_question.is_none() {'),finding:'A changed final question waits until the prior pending question is cleared.'},
 {...locate(files[0],'reuse,false,Some(corrected.context)'),finding:'The only retry disables restart_stalled.'},
 {...locate(files[0],'if restart_stalled&&!terminal_pending&&!consumption_pending=>'),finding:'The final-refinement deadline cannot trigger retirement on that second attempt.'},
 {...locate(files[0],'if let Some(trace)=&trace{trace.input_consumed();}'),finding:'The consumption trace is marked when the stream task processes the matching userMessage completion.'},
 {...locate(files[0],'if let Some(sender)=sender { let _=sender.blocking_send(message); }'),finding:'The one stdout reader waits when a per-thread event channel is full; later transport events can be delayed locally.'},
 {...locate(files[0],'let (tx, mut events) = mpsc::channel(256);'),finding:'Each answer stream has a bounded event channel.'},
 {...locate(files[0],'result=event(emitted)=>result?'),finding:'The stream task awaits delivery of each decoded delta before reading its next event.'},
 {...locate(files[1],'async move{tx.send(event).await.map_err'),finding:'The native answer callback awaits delivery to the runtime work channel.'},
 {...locate(files[1],'let (work_tx, mut work) = mpsc::channel(256);'),finding:'The runtime work channel is also bounded.'},
 {...locate(files[3],'fn latest_semantic_reply_is_visible_while_older_code_is_still_streaming()'),finding:'The existing visibility-policy test explicitly retains an older answer until the new answer has a buffer.'}
];
const normalize=(name,data)=>{
 const s=data.stages;
 const confirm=s.physicalEndpointToFinalConfirmationMs??s.endpointToFinalConfirmationMs;
 const span=data.visibleWord.latencyMs;
 const stages={endpointToFinalConfirmationMs:confirm,confirmationToFinalSendMs:s.finalConfirmationToFinalInputSentMs,
 finalSendToConsumptionEventMs:s.finalInputSentToConsumptionEventMs,consumptionToRetainedDeltaMs:s.consumptionEventToRetainedFirstDeltaMs,
 retainedDeltaToNativeVisibleMs:s.retainedFirstDeltaToNativeVisibleMs};
 return {name,round:data.round,firstRetainedVisibleWordMs:span,stages,
  confirmationAndConsumptionWaitMs:stages.confirmationToFinalSendMs+stages.finalSendToConsumptionEventMs,
  counters:data.counters};
};
const report={recordedAt:new Date().toISOString(),evidence:[{file:prior.file,sha256:prior.sha256},{file:latest.file,sha256:latest.sha256},
 {file:snapshot.file,sha256:snapshot.sha256}],sourceHashes:Object.fromEntries(files.map(file=>[file,sources[file].sha256])),
 observations:[normalize('completed deep-code-memory',prior.data.representativeTrace),normalize('completed response in unfinished systems hour',latest.data)],
 mechanism,
 conclusion:'Two recorded slow responses spend most of their endpoint-to-visible-word latency waiting for the final update to be sent and for its consumption event to be processed. The application serializes updates behind an outstanding input and disables its short refinement restart deadline after one retry. This supports a recurring architecture bottleneck, not a claim that all measured delay is provider reasoning.',
 transportUncertainty:'There is no per-message timestamp for receipt by the stdout reader or measured channel occupancy during these responses. Shared-reader blocking and awaited runtime delivery are possible local contributors supported by source, but their duration in these cases is unmeasured. Provider queue, reasoning and GPU time are also unmeasured.',
 visibilityFinding:'The retained-old-answer policy explains why an unrelated old answer can remain painted after a new topic is confirmed; separately recorded topic-switch and continuous-pressure examples already demonstrate that failure.',
 pending:['Bind the preserved systems response to the final cleanly stopped hour journal.','Run the planned final-prompt and actual playback ChatGPT comparisons after measured recordings finish.','Complete deferred independent accuracy assessment.'],
 model:latest.data.model,effort:latest.data.effort,outputDevice:latest.data.outputDevice,
 productionLogicChanged:false,scope:'Read-only source diagnosis and source-bound recorded timings. No expected answers injected, performance modifications, additional inference during measured playback, or claim of backend superiority.'};
await writeFile('docs/evidence/architecture-tail-replication-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({observations:report.observations,mechanismLines:mechanism.map(({file,line})=>({file,line})),productionLogicChanged:false}));
