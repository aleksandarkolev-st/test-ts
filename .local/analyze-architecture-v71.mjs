import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {streamedWordLatency,latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
const [directory]=process.argv.slice(2);assert(directory,'RECORDING_DIRECTORY [--snapshot]');
const root=path.resolve(directory);assert(root.startsWith(process.cwd()+path.sep));
const snapshot=process.argv.includes('--snapshot'),file=path.join(root,'interview.json');
if(snapshot&&(await stat(file)).size>8*1024*1024){console.log(JSON.stringify({deferred:true,reason:'Avoid parsing a large live recorder journal during measured inference',file}));process.exit(0);}
const bytes=await readFile(file),journal=JSON.parse(bytes),hash=x=>createHash('sha256').update(x).digest('hex');
assert(snapshot||(journal.status==='complete'&&journal.stoppedCleanly),'Final architecture analysis requires a clean completed recording');
const sourceFiles=['src-tauri/src/openai/codex.rs','src-tauri/src/openai/timing.rs','src-tauri/src/runtime.rs','src-tauri/src/meeting/scheduler.rs'];
const recorderFiles=['scripts/native-signed-interview.mjs','scripts/lib/deep-audio-interview.mjs'];
const loadedSourceFiles=[...sourceFiles,...recorderFiles.filter(f=>journal.sourceHashes?.[f]||journal.diagnosticSourceHashes?.[f])];
const sources={};for(const sourceFile of loadedSourceFiles){const raw=await readFile(sourceFile);sources[sourceFile]={sha256:hash(raw),text:raw.toString()};assert.equal(sources[sourceFile].sha256,journal.sourceHashes[sourceFile]??journal.diagnosticSourceHashes[sourceFile]);}
const locate=(file,needle,meaning)=>{const lines=sources[file].text.split('\n'),index=lines.findIndex(line=>line.includes(needle));assert(index>=0,needle);return {file,line:index+1,source:lines[index].trim(),meaning};};
const sourceMechanisms=[
 locate(sourceFiles[0],'&& pending_question.is_none() {','A changed final input waits for the outstanding input to clear.'),
 locate(sourceFiles[0],'reuse,false,Some(corrected.context)','The second and last attempt disables the short restart deadline.'),
 locate(sourceFiles[0],'if restart_stalled&&!terminal_pending&&!consumption_pending=>','The refinement deadline cannot retire a stalled second attempt.'),
 locate(sourceFiles[0],'let deadline = tokio::time::sleep(Duration::from_secs(120));','The overall answer timer is created once before the attempt event loop. Question/context updates and follow-up inputs inside that loop do not recreate it; this is not a fresh budget starting at the physical end of the final utterance.'),
 locate(sourceFiles[0],'_=&mut deadline=>return Err("Codex answer timed out".into())','The overall timer returns an answer error when selected. This differs from the short refinement-stall retry outcome; observed long waits are not automatically evidence that either timer expired.'),
 locate(sourceFiles[0],'trace.diagnostic_input_received(&keys)','Reader receipt is recorded only for the expected input hash, before blocking queue delivery.'),
 locate(sourceFiles[0],'let _=sender.blocking_send(message);','The shared stdout reader can block delivering to one thread and postpone all later messages.'),
 locate(sourceFiles[0],'let (tx, mut events) = mpsc::channel(256);','Each thread has a bounded 256-event queue.'),
 locate(sourceFiles[0],'result=event(emitted)=>result?','The stream consumer awaits the runtime callback before processing the next message.'),
 locate(sourceFiles[0],'if intent!=Some(false){return Ok(None);}','The automatic-answer decoder withholds text until a complete answer intent is known. The supplied schema places intent before text; text-first withholding is a counterfactual mechanism, not an observed provider ordering or leading diagnosis.'),
 locate(sourceFiles[0],'let (intent,text)=reply_prefix(&self.raw)?;','Each automatic-answer chunk reparses the accumulated JSON prefix before the timed callback. Decoder execution is not included in callback duration.'),
 locate(sourceFiles[2],'let (work_tx, mut work) = mpsc::channel(256);','The native runtime work queue is also bounded.'),
 locate(sourceFiles[3],'fn latest_semantic_reply_is_visible_while_older_code_is_still_streaming()','Existing display policy retains the previous answer until the new buffer is available.')
];
if(sources[recorderFiles[0]])sourceMechanisms.push(locate(recorderFiles[0],'const snapshot=JSON.stringify(result,null,2);','The recording helper serializes its growing observation history synchronously before writing; this instrumentation adds CPU and memory load.'));
if(sources[recorderFiles[1]])sourceMechanisms.push(locate(recorderFiles[1],'if(Date.now()-lastSave>10000)','The interview recorder periodically saves its full journal during capture; its overhead is part of this measurement regime.'));
const subtract=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)?end-start:null;
const rows=journal.rows.map(row=>{
 const m=streamedWordLatency(journal,row),p=row.latency?.pipeline??{},anchors=row.audio?.clockAnchors??[],endpoint=row.audio?.playback;
 const offsets=anchors.map(a=>[a.nativeMs-a.hostAfterMs,a.nativeMs-a.hostBeforeMs]);
 const low=Math.max(...offsets.map(x=>x[0])),high=Math.min(...offsets.map(x=>x[1]));
 const calibrated=offsets.length>0&&low<=high&&Number.isFinite(low)&&Number.isFinite(high);
 const nativeEnd=calibrated&&endpoint?{low:endpoint.lastVoicedDevicePositionLowerHostMs+low,high:endpoint.lastVoicedDevicePositionUpperHostMs+high}:null;
 const c=row.latency?.questionConfirmedAt??p.questionConfirmed;
 const received=p.latestInputReaderReceived,sent=p.latestInputSent,consumed=p.latestInputConsumed,delta=p.retainedFirstDelta;
 const ordered=[sent,received,consumed,delta].every(Number.isFinite)&&sent<=received&&received<=consumed&&consumed<=delta;
 return {round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,responseVersion:row.responseVersion,
  phase:row.phase,cancelled:row.cancelled,error:row.error,questionId:m.questionId,
  visibleWord:m.firstVisibleStreamedWord,retainedWord:m.firstRetainedVisibleStreamedWord,missingReason:m.missingReason,
  sourceQuestionSha256:hash(row.question),answerSha256:hash(row.answer??''),
  nativePhysicalEndpointMs:nativeEnd,clocksConsistent:calibrated,
  inputTimelineOrdered:ordered,timestamps:{confirmed:c,sent,readerReceived:received,consumerProcessed:consumed,retainedDelta:delta,nativeVisible:p.firstVisible,firstAgentDelta:p.firstAgentDelta},
  stages:{endpointToConfirmationMs:nativeEnd&&Number.isFinite(c)?{low:c-nativeEnd.high,high:c-nativeEnd.low}:null,
   confirmationToFinalSendMs:subtract(sent,c),sentToReaderReceiptMs:subtract(received,sent),
   readerReceiptToConsumerMs:subtract(consumed,received),consumerToRetainedDeltaMs:subtract(delta,consumed),
   retainedDeltaToNativeVisibleMs:subtract(p.firstVisible,delta),foregroundSemaphoreWaitMs:subtract(p.semaphoreAcquired,p.codexStreamEntered),
   preparedThreadWaitMs:subtract(p.warmThreadTaken,p.semaphoreAcquired)},
  counters:{restarts:p.refinementRestartCount,steers:p.steeringCount,followups:p.followupCount,readerQueuePeak:p.readerQueuePeak,
   readerFullQueueCount:p.readerFullQueueCount,readerSendCount:p.readerSendCount,readerSendTotalUs:p.readerSendTotalUs,
   readerSendMaxUs:p.readerSendMaxUs,deltaCallbackCount:p.deltaCallbackCount,deltaCallbackTotalUs:p.deltaCallbackTotalUs,deltaCallbackMaxUs:p.deltaCallbackMaxUs},
  characters:{initialPrompt:p.promptChars,restartPrompt:p.restartPromptChars,refinements:p.refinementChars,answer:(row.answer??'').length},
  caveat:ordered?null:'Latest input and retained answer timestamps are missing or not ordered. Raw fields retained; do not attribute their differences as a sequential first-word delay.'};
});
const distributions={};for(const key of ['confirmationToFinalSendMs','sentToReaderReceiptMs','readerReceiptToConsumerMs','consumerToRetainedDeltaMs','retainedDeltaToNativeVisibleMs','foregroundSemaphoreWaitMs','preparedThreadWaitMs']){
 const samples=rows.filter(r=>r.inputTimelineOrdered).map(r=>r.stages[key]);distributions[key]={...latencyDistribution(samples),missing:rows.length-samples.filter(Number.isFinite).length};
}
const group=predicate=>{const selected=rows.filter(predicate);return {turns:selected.length,visible:latencyDistribution(selected.map(r=>r.visibleWord?.latencyMs.high)),retainedVisible:latencyDistribution(selected.map(r=>r.retainedWord?.latencyMs.high)),missingVisible:selected.filter(r=>!r.visibleWord).length,errors:selected.filter(r=>r.error).length,cancelled:selected.filter(r=>r.cancelled).length};};
const slowest=rows.filter(r=>r.retainedWord).sort((a,b)=>b.retainedWord.latencyMs.high-a.retainedWord.latencyMs.high).slice(0,5);
const tailTrajectories=slowest.map(row=>{
 const observations=(journal.deepObservations??[]).flatMap(record=>{
  const job=record.jobs?.find(j=>j.question.id===row.questionId),p=job?.latency?.pipeline;
  return p?[{nativeNow:record.nativeNow,hostBeforeMs:record.hostBeforeMs,hostAfterMs:record.hostAfterMs,
   sent:p.latestInputSent,readerReceived:p.latestInputReaderReceived,consumerProcessed:p.latestInputConsumed,
   confirmed:p.questionConfirmed,retainedDelta:p.retainedFirstDelta,restarts:p.refinementRestartCount,
   steers:p.steeringCount,followups:p.followupCount,readerSendCount:p.readerSendCount,
   deltaCallbackCount:p.deltaCallbackCount,refinementChars:p.refinementChars,readerQueuePeak:p.readerQueuePeak,
   readerFullQueueCount:p.readerFullQueueCount}]:[];
 });
 const interval=(low,high)=>{
  if(!Number.isFinite(low)||!Number.isFinite(high)||high<low)return null;
  const samples=observations.filter(o=>o.nativeNow>=low&&o.nativeNow<=high),first=samples[0],last=samples.at(-1);
  return {intervalNativeMs:{low,high},observations:samples.length,first,last,
   observedReaderDeliveries:first&&last?subtract(last.readerSendCount,first.readerSendCount):null,
   observedOutputCallbacks:first&&last?subtract(last.deltaCallbackCount,first.deltaCallbackCount):null,
   scope:'Counter differences between recorded in-interval snapshots are lower bounds on activity, not counts for the whole interval. Provider event timestamps and internal compute time are unmeasured.'};
 };
 let previousKey=null;
 const transitions=observations.filter(o=>{const key=JSON.stringify([o.sent,o.readerReceived,o.consumerProcessed,o.confirmed,o.restarts,o.steers,o.followups]);if(key===previousKey)return false;previousKey=key;return true;});
 const prefixEvents=(journal.rows??[]).flatMap(r=>r.events??[]).filter(e=>e.name==='answer.provisional_prefix'&&e.payload?.id===row.questionId);
 const unique=new Map(prefixEvents.map(e=>[JSON.stringify(e),e]));
 const original=journal.rows.find(r=>r.round===row.round),playback=original?.audio?.playback;
 const hostStart=playback?.lastVoicedDevicePositionLowerHostMs,hostEnd=row.retainedWord?.observedHostMs;
 const during=samples=>Number.isFinite(hostStart)&&Number.isFinite(hostEnd)?samples.filter(s=>s.hostMs>=hostStart&&s.hostMs<=hostEnd):[];
 const recorder=during(journal.recorderResources??[]),native=during(journal.nativeResources??[]);
 const pollObservations=(journal.deepObservations??[]).filter(o=>o.hostBeforeMs>=hostStart&&o.hostAfterMs<=hostEnd);
 const pollGaps=pollObservations.slice(1).map((o,i)=>o.hostBeforeMs-pollObservations[i].hostAfterMs);
 const nativeCpuRate=native.length>=2?subtract(native.at(-1).cpuSeconds,native[0].cpuSeconds)/(native.at(-1).hostMs-native[0].hostMs)*1000:null;
 return {round:row.round,questionId:row.questionId,transitions,
  waitingToSend:interval(row.timestamps.confirmed,row.timestamps.sent),
  waitingForReaderReceipt:interval(row.timestamps.sent,row.timestamps.readerReceived),
  waitingForRetainedOutput:interval(row.timestamps.consumerProcessed,row.timestamps.retainedDelta),
  preFinalInputPrefixFrames:[...unique.values()].filter(e=>e.payload.observedAt>=row.timestamps.confirmed&&e.payload.observedAt<row.timestamps.readerReceived).map(e=>({
   observedAt:e.payload.observedAt,question:e.payload.question,contextKey:e.payload.contextKey,revision:e.payload.revision,
   prefix:e.payload.prefix,atCap:e.payload.atCap})),
  decodedPrefixFramesBeforeRetention:[...unique.values()].filter(e=>e.payload.observedAt>=row.timestamps.consumerProcessed&&e.payload.observedAt<row.timestamps.retainedDelta).map(e=>({
   observedAt:e.payload.observedAt,question:e.payload.question,contextKey:e.payload.contextKey,revision:e.payload.revision,
   prefix:e.payload.prefix,atCap:e.payload.atCap})),
  prefixScope:'Acceptance observations expose at most 256 characters per question/context frame. Positive observations establish activity; their absence does not establish that an old response stopped.',
  observedResources:{hostWindow:{start:hostStart,end:hostEnd},recorderSamples:recorder.length,nativeSamples:native.length,
   recorderRssBytes:latencyDistribution(recorder.map(s=>s.rss)),recorderNativeInvokeMs:latencyDistribution(recorder.map(s=>s.pollMs)),
   nativePrivateBytes:latencyDistribution(native.map(s=>s.privateBytes)),nativeCpuSecondsPerWallSecond:nativeCpuRate,
   nativeTreePrivateBytes:latencyDistribution(native.map(s=>s.nativeTree?.nativeTreePrivateBytes)),
   nativeObservationGapMs:latencyDistribution(pollGaps),
   scope:'Samples wholly inside the physical-endpoint to retained-visible-word interval. Sparse windows can miss transient stalls. CPU rate is processor seconds per wall second, with one representing one fully occupied logical core; native-only CPU excludes its children. Invoke duration excludes journal serialization and painting; observation gaps include collector pauses and periods without changed jobs. Working sets, GPU memory, provider resources and sibling loads are not isolated.'}};
});
const report={recordedAt:new Date().toISOString(),source:{file,sha256:hash(bytes),status:journal.status,stoppedCleanly:journal.stoppedCleanly},
 sourceHashes:Object.fromEntries(loadedSourceFiles.map(f=>[f,sources[f].sha256])),model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 nativeBinarySha256:journal.nativeBinarySha256,sourceMechanisms,rows,distributions,tailTrajectories,
 summary:{all:group(()=>true),withRestart:group(r=>r.counters.restarts>0),withoutRestart:group(r=>r.counters.restarts===0),
  readerObservedFull:group(r=>r.counters.readerFullQueueCount>0),noReaderFullObserved:group(r=>r.counters.readerFullQueueCount===0),
  sequentialInputTimelines:rows.filter(r=>r.inputTimelineOrdered).length,missingOrNonsequentialInputTimelines:rows.filter(r=>!r.inputTimelineOrdered).length,
  readerQueuePeak:Math.max(0,...rows.map(r=>r.counters.readerQueuePeak??0)),
  readerSendMaxUs:Math.max(0,...rows.map(r=>r.counters.readerSendMaxUs??0)),
  deltaCallbackMaxUs:Math.max(0,...rows.map(r=>r.counters.deltaCallbackMaxUs??0)),
  slowestRetainedWords:slowest},
 limitations:[
  'Reader receipt is when this app reads the matching userMessage event. Delay before receipt includes provider work, transport, and any earlier shared-reader blockage; provider internal timing is unavailable.',
  'Per-thread queue waits are cumulative across the recorded attempt(s). They do not prove which input interval incurred a wait, and untraced or unobserved other threads can still block the shared reader.',
  'Callback duration measures delivery to the native work queue, not completion of native processing or UI painting.',
  'FirstAgentDelta is the earliest raw agent delta for the attempt(s), potentially for an obsolete question frame; it is not the first raw delta for the final answer. Raw JSON field order and per-frame decoder execution are not recorded, so decoder delay cannot be isolated from these traces.',
  'Marginal stage p95s must not be added. Examine the decomposed same-response tail rows.',
  'Restart strata are observational and differ in question complexity, context and interruptions. They are not a causal intervention.',
  'The recorder serializes a growing full journal during capture. Native process memory and queue diagnostics do not establish absence of recorder, WebView, local ASR or system-wide resource contention.',
  'Synthetic playback, debug instrumentation, adaptive examiner requests, local ASR and recording overhead differ from a human meeting. Accuracy is separate.'
 ],independentAccuracyPending:true,goalComplete:false};
if(snapshot)console.log(JSON.stringify({...report,rows:undefined,sourceMechanisms:undefined,summary:{...report.summary,slowestRetainedWords:report.summary.slowestRetainedWords.map(r=>({round:r.round,retainedWord:r.retainedWord,stages:r.stages,counters:r.counters}))}}));
else{await writeFile(path.join(root,'architecture-audit-v71.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({file:path.join(root,'architecture-audit-v71.json'),summary:report.summary.all,ordered:report.summary.sequentialInputTimelines}));}
