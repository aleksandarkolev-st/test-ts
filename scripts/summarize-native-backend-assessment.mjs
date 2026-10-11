import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {latencyDistribution,streamedWordLatency} from './lib/streamed-word-latency.mjs';
import {projectNativeBackendWave} from './lib/native-backend-projection.mjs';
const [directory]=process.argv.slice(2);assert(directory,'PLAYBACK_COMPARISON_DIRECTORY');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>{const bytes=await readFile(file);return {file,sha256:hash(bytes),data:JSON.parse(bytes)};};
const recording=await read(path.join(directory,'playback.json'));
assert(recording.data.status==='complete'&&recording.data.stoppedCleanly);
const rows=[],sources=[{file:recording.file,sha256:recording.sha256}];
for(const backend of ['codex','chatgpt']){
 const projection=await read(path.join(directory,`${backend}-review-input.json`));
 assert.equal(projection.data.derivedFrom.sha256,recording.sha256);
 sources.push({file:projection.file,sha256:projection.sha256});
 for(const [index,row] of projection.data.rows.entries()){
  const record=recording.data.cases[row.sourceBinding.recordedCaseIndex];assert.equal(record.backend,backend);
  const fresh=projectNativeBackendWave(record,row.sourceBinding.waveIndex);
  for(const key of ['question','recognizedQuestion','answer','phase','error','cancelled','responseVersion','latency','audio','observationWindow'])assert.deepEqual(row[key],fresh[key],key);
  const reviewed=await read(path.join(directory,`${backend}-independent-model-review-v70`,`trial-${String(index+1).padStart(3,'0')}.json`));
  assert.equal(reviewed.data.inputSchemaVersion,3);assert.equal(reviewed.data.model,recording.data.model);assert.equal(reviewed.data.effort,recording.data.effort);
  assert.equal(reviewed.data.reviewerContinuity,false);
  const input={answer:row.answer??null,cancelled:row.cancelled??null,error:row.error??null,phase:row.phase??null,
   publicPriorContext:row.selectedContext??null,recognizedQuestion:row.recognizedQuestion??null,
   sourcePriorQuestions:row.recordedSourcePriorQuestions,spokenQuestion:row.question??null};
  assert.equal(reviewed.data.inputSha256,hash(Buffer.from(JSON.stringify(input))));
  const paints=record.paintSamples.filter(sample=>sample.hostMs<=row.observationWindow.endHostMs);
  const word=streamedWordLatency({overlayPaintSamples:paints},row);
  const phrase=reviewed.data.review.usefulPhrase??null,start=phrase?row.answer.indexOf(phrase):-1,end=start+(phrase?.length??0);
  assert(phrase===null||(typeof phrase==='string'&&phrase.length&&start>=0));
  const [id,revision]=(row.responseVersion??'').split(':'),retired=['cancelled','superseded'].includes(row.phase);
  const painted=phrase&&!row.error&&!row.cancelled&&!retired?paints.find(sample=>sample.questionId===id&&sample.revision===Number(revision)
   &&sample.recorderVersion===2&&sample.visible&&sample.visibleStart<=start&&sample.visibleEnd>=end
   &&row.answer.startsWith(sample.text)&&sample.text.includes(phrase)):null;
  const endpoint=row.audio.playback;
  const usefulLatency=painted?{low:painted.hostMs-endpoint.lastVoicedDevicePositionUpperHostMs,high:painted.hostMs-endpoint.lastVoicedDevicePositionLowerHostMs}:null;
  rows.push({...row,backend,independentReview:reviewed.data.review,independentReviewSha256:reviewed.sha256,
   firstRetainedVisibleWord:word.firstRetainedVisibleStreamedWord,
   firstVisibleWord:word.firstVisibleStreamedWord,
   firstWordMissingReason:row.sourceBinding.nativeQuestionId&&!row.responseVersion?'confirmed_job_answer_not_observed':word.missingReason,visibleRetainedUsefulPhraseLatencyMs:usefulLatency,
   usefulPhraseMissingReason:usefulLatency?null:row.error?'answer_error':row.cancelled||retired?'retired_answer':!phrase?'no_correct_useful_phrase':'phrase_not_observed_in_retained_visible_viewport'});
  sources.push({file:reviewed.file,sha256:reviewed.sha256});
 }
}
const summaries=Object.fromEntries(['codex','chatgpt'].map(backend=>{
 const group=rows.filter(row=>row.backend===backend);
 return [backend,{sourceWaveforms:group.length,
  modelVerdicts:Object.fromEntries(['correct','incorrect','incomplete','unverified'].map(verdict=>[verdict,group.filter(row=>row.independentReview.verdict===verdict).length])),
  nativePhaseCounts:Object.fromEntries([...new Set(group.map(row=>row.phase))].map(phase=>[phase,group.filter(row=>row.phase===phase).length])),
  errors:group.filter(row=>row.error).length,cancelledFlags:group.filter(row=>row.cancelled).length,
  finalSourceConfirmationMissing:group.filter(row=>!row.sourceBinding.finalSourceConfirmationObserved).length,
  physicalSpeechEndToRetainedVisibleWordMs:latencyDistribution(group.map(row=>row.firstRetainedVisibleWord?.latencyMs.high)),
  missingRetainedVisibleWords:group.filter(row=>!row.firstRetainedVisibleWord).length,
  physicalSpeechEndToUsefulPhraseMs:latencyDistribution(group.map(row=>row.visibleRetainedUsefulPhraseLatencyMs?.high)),
  missingUsefulPhraseMeasurements:group.filter(row=>!row.visibleRetainedUsefulPhraseLatencyMs).length}];
}));
const switchLaunches=recording.data.cases.filter(record=>record.waves.length>1).map(record=>{
 const wave=record.waves[1],start=wave.playback.submitBeforeHostMs;
 const snapshots=record.snapshots.slice().sort((a,b)=>a.hostAfterMs-b.hostAfterMs);
 const before=snapshots.findLast(item=>item.hostAfterMs<=start),after=snapshots.find(item=>item.hostBeforeMs>=wave.playback.submitAfterHostMs);
 const prior=wave.visibleResponseBeforePlaybackRequest;
 const held=record.paintSamples.findLast(sample=>sample.hostMs<=start);
 const nativeStreaming=item=>Boolean(item?.snapshot.question?.id===prior&&item.snapshot.answer&&item.snapshot.latency?.completedAt==null);
 return {backend:record.backend,name:record.name,deviceSubmissionHostMs:start,
  beforePlaybackRequest:wave.visibleSnapshotBeforePlaybackRequest,
  nearestSnapshotBeforeSubmission:before??null,nearestSnapshotAfterSubmission:after??null,
  priorAnswerObservedStreamingOnBothSidesOfSubmission:nativeStreaming(before)&&nativeStreaming(after),
  heldVisibleCaretAtSubmission:Boolean(held?.questionId===prior&&held.visible&&held.streaming),
  heldPaint:held??null,
  scope:'Actual device submission is bounded by recorded polls and held paint samples; the earlier pre-playback-request snapshot alone does not prove streaming at physical submission. No provider-internal running state is inferred.'};
});
const pairs=rows.filter(row=>row.backend==='codex').map(codex=>{
 const chatgpt=rows.find(row=>row.backend==='chatgpt'&&row.sourceBinding.name===codex.sourceBinding.name&&row.sourceBinding.waveIndex===codex.sourceBinding.waveIndex);
 assert(chatgpt);assert.equal(codex.audio.sha256,chatgpt.audio.sha256);assert.equal(codex.question,chatgpt.question);
 const left=codex.firstRetainedVisibleWord?.latencyMs,right=chatgpt.firstRetainedVisibleWord?.latencyMs;
 const difference=left&&right?{low:right.low-left.high,high:right.high-left.low}:null;
 return {name:codex.sourceBinding.name,waveIndex:codex.sourceBinding.waveIndex,waveformSha256:codex.audio.sha256,
  codexVerdict:codex.independentReview.verdict,chatgptVerdict:chatgpt.independentReview.verdict,
  codexError:codex.error,chatgptError:chatgpt.error,chatgptMinusCodexRetainedVisibleWordMs:difference,
  observedOrder:difference?(difference.high<0?'chatgpt_earlier':difference.low>0?'codex_earlier':'measurement_intervals_overlap'):'missing_either_measurement'};
});
const result={recordedAt:new Date().toISOString(),sources,model:recording.data.model,effort:recording.data.effort,
 outputDevice:recording.data.outputDevice,rows,summaries,switchLaunches,pairs,
 scope:'Matched saved waveforms through each existing native backend route, with normal authentication and microphone disabled. Primary latency is physical last-nonzero playback endpoint to actual retained visible complete word; correctness and terminal outcomes remain separate. Case snapshots limit first-wave observations when the next waveform starts, with raw later stale paints preserved. Exact selected context and hidden buffers were not captured. Model verdicts remain provisional; small dependent cases are not population estimates. Route-specific detection, context and steering differ. No fixed latency threshold or automatic production switch is applied.'};
await writeFile(path.join(directory,'independent-native-comparison-v70.json'),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({summaries,switchLaunches:switchLaunches.map(row=>({backend:row.backend,streamingOnBothSidesOfSubmission:row.priorAnswerObservedStreamingOnBothSidesOfSubmission,heldVisibleCaret:row.heldVisibleCaretAtSubmission}))}));
