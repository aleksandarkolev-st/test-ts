import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/continuous-pressure-t';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>{const bytes=await readFile(file);return {file,sha256:hash(bytes),data:JSON.parse(bytes)};};
const recording=await read(`${directory}/interview.json`),projection=await read(`${directory}/pressure-review-input.json`);
const events=await read(`${directory}/pressure-events-audit.json`),visibility=await read(`${directory}/pressure-visibility-contextual-audit.json`);
const coverage=await read(`${directory}/pressure-source-coverage-audit.json`);
for(const item of [events,visibility])assert.equal(item.data.journalSha256,recording.sha256);
assert.equal(projection.data.derivedFrom.journalSha256,recording.sha256);
const rows=projection.data.rows,bind=row=>({trial:row.trial,nativeQuestionId:row.sourceBinding.nativeQuestionId,
 sourceFragments:row.sourceBinding.sourceFragments,recognizedQuestion:row.recognizedQuestion,
 answer:row.answer,answerSha256:hash(Buffer.from(row.answer)),phase:row.phase,cancelledFlag:row.cancelled,error:row.error});
// These are explicit manual observations of the supplied source clips, not
// new routing heuristics or grading logic in the application.
const tails=rows.filter(row=>row.sourceBinding.sourceFragments.some(fragment=>fragment.clipId===5&&fragment.startCharacter===311));
assert.equal(tails.length,6);
const background=rows.filter(row=>row.sourceBinding.sourceFragments.some(fragment=>fragment.clipId===22));
assert.equal(background.length,5);
const backgroundFindings=background.map(row=>{
 const id=row.sourceBinding.nativeQuestionId;
 assert.equal(row.answer,'');assert.equal(row.phase,'cancelled');assert.equal(row.cancelled,false);
 const observed=recording.data.deepObservations.flatMap(observation=>{
  const job=observation.jobs?.find(job=>job.question.id===id);
  return job?[{hostBeforeMs:observation.hostBeforeMs,hostAfterMs:observation.hostAfterMs,job}]:[];
 });
 assert(observed.length);assert(observed.every(item=>!item.job.answer));
 const lifecycle=events.data.lifecycleEvents.filter(event=>event.payload?.id===id);
 assert.equal(lifecycle.filter(event=>event.name==='question.ignored').length,1);
 const visible=recording.data.overlayPaintSamples.filter(sample=>sample.questionId===id&&sample.recorderVersion===2&&sample.visible&&sample.visibleEnd>sample.visibleStart);
 assert.equal(visible.length,0);
 assert(row.sourceBinding.sourceFragments.some(fragment=>fragment.clipId===21));
 return {...bind(row),lifecycle,observations:observed.length,maximumObservedAnswerChars:0,
  visibleAnswerPaints:0,lastObservedQuestion:observed.at(-1).job.question.text,
  finding:'The legitimate nineteen-lane CUDA request and the background instruction to keep it available share one native job. Its ignore event cancels the merged request; no answer was observed before or after in this recording. This is a request-scope/background-handling failure despite retained recognized clauses.'};
});
const atomicRow=rows.find(row=>row.trial===8),atomicWindow=visibility.data.windows.find(window=>window.confirmedQuestionId===atomicRow.sourceBinding.nativeQuestionId);
assert(atomicWindow.nearestObservedQuestionAfterInitialConfirmation.question.text.includes('no atomics are allowed'));
const obsoleteAtomicIntervals=atomicWindow.intervals.filter(interval=>interval.shownQuestionId===rows.find(row=>row.trial===6).sourceBinding.nativeQuestionId);
assert.equal(obsoleteAtomicIntervals.length,1);assert(obsoleteAtomicIntervals[0].visibleText.startsWith('Use one atomic increment per key'));
const sourceFiles=['src-tauri/src/runtime.rs','src-tauri/src/openai/codex.rs','src-tauri/src/openai/prompts.rs'];
const sourceHashes=[];for(const file of sourceFiles)sourceHashes.push({file,sha256:hash(await readFile(file))});
const record={recordedAt:new Date().toISOString(),evidence:[recording,projection,events,visibility,coverage].map(({file,sha256})=>({file,sha256})),
 productionSourceHashes:sourceHashes,productionLogicChanged:false,sourceCoverage:coverage.data.summary,
 essentialFinalCondition:{occurrences:tails.map(bind),manualAssessment:'All six retained complete tail answers require signed 64-bit final output, exact accumulation, checking only the final sum, and rejection rather than wrapping or partial output. Intermediate cancellation is preserved. ASR variants sign/sines/signs/finition are visible in the raw questions. Prefix answers and tail answers are separate native jobs, and earlier repetitions can supply prior context; these are dependent observations, not six novel held-out trials.'},
 backgroundSuppression:{recordedIgnoredMergedRequests:backgroundFindings.length,findings:backgroundFindings,
  sourceBehavior:'The automatic reply protocol has one answer/ignore intent for the entire current question. Runtime Work::NoReply clears that job buffer, sets its phase to Cancelled and confirmed=false, and emits question.ignored. Source matches the observed effect; provider-internal intent reasoning was not captured.',
  outcomeFlags:'All five jobs have phase cancelled while cancelled=false. The latter flag is not a complete count of ignored terminal requests; both recorded fields remain preserved.'},
 obsoleteHistogramVisibility:{currentQuestion:bind(atomicRow),confirmedNoAtomicQuestion:atomicWindow.nearestObservedQuestionAfterInitialConfirmation,
  confirmationHostMs:atomicWindow.confirmationHostMs,obsoleteAtomicIntervals,
  unrelatedEarlierAnswerAfterLastSameJobConfirmationMs:atomicWindow.differentQuestionVisibleAfterLastSameJobConfirmationMs,
  finding:'An earlier atomic-increment proposal remains in the sampled visible display across the no-atomics confirmation boundary, then an unrelated experiment answer is shown. The sample-held atomic interval is 10 ms; it is not continuous pixel-level timing. The old experiment answer also persists 4525 ms after the last same-job confirmation. The revised histogram job is later superseded with a partial ownership answer.'},
 scope:'Concrete manual continuation, background and conflicting stale-display findings bound to the completed pressure recording. No source text, runtime logic, answer or timing is repaired. These do not certify all 158 utterances as semantically correct; deferred per-job model reviews and substantive checks remain separate.'};
await writeFile('docs/evidence/pressure-continuation-and-background-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({sourceUtterances:coverage.data.summary.sourceUtterances,completeLateConditionAnswers:tails.length,
 ignoredMergedCudaRequests:backgroundFindings.length,obsoleteAtomicSampleHeldMs:obsoleteAtomicIntervals[0].durationMs,
 unrelatedAnswerAfterFinalConfirmationMs:atomicWindow.differentQuestionVisibleAfterLastSameJobConfirmationMs}));
