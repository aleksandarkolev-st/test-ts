import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {latencyDistribution} from './lib/streamed-word-latency.mjs';
import {retainedStreamTiming} from './lib/retained-stream-timing.mjs';
const [directory]=process.argv.slice(2);assert(directory,'COMPARISON_DIRECTORY');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>{const bytes=await readFile(file);return {value:JSON.parse(bytes),file,sha256:hash(bytes)};};
const complete=await read(path.join(directory,'complete.json'));assert.equal(complete.value.status,'complete');
const rows=[],sources=[{file:complete.file,sha256:complete.sha256}];
for(const backend of ['codex','chatgpt']){
 const projection=await read(path.join(directory,`${backend}-review-input.json`));
 assert.equal(projection.value.backend,backend);assert.equal(projection.value.derivedFrom.completeSha256,complete.sha256);
 sources.push({file:projection.file,sha256:projection.sha256});
 for(const [index,row] of projection.value.rows.entries()){
  const trial=await read(row.sourceBinding.recordedTrial.file);assert.equal(trial.sha256,row.sourceBinding.recordedTrial.sha256);
  assert.equal(trial.value.answer,row.answer);assert.equal(trial.value.error??null,row.error??null);
  assert.equal(row.cancelled,trial.value.observationBudgetExhausted??false);
  const reviewRecord=await read(path.join(directory,`${backend}-independent-model-review-v70`,`trial-${String(index+1).padStart(3,'0')}.json`));
  const assessment=reviewRecord.value;assert.equal(assessment.inputSchemaVersion,3);
  assert.equal(assessment.reviewerContinuity,false);
  assert.equal(assessment.model,projection.value.model);assert.equal(assessment.effort,projection.value.effort);
  const input={answer:row.answer??null,cancelled:row.cancelled??null,error:row.error??null,phase:row.phase??null,
   publicPriorContext:row.selectedContext??null,recognizedQuestion:row.recognizedQuestion??null,
   sourcePriorQuestions:row.recordedSourcePriorQuestions,spokenQuestion:row.question??null};
  assert.equal(assessment.inputSha256,hash(Buffer.from(JSON.stringify(input))));
  const review=assessment.review,phrase=review.usefulPhrase;
  assert(phrase===null||(typeof phrase==='string'&&phrase.length&&row.answer.includes(phrase)));
  const eventCount=trial.value.streamEventsBeforeObservationEnd??trial.value.streamEvents.length;
  assert(Number.isInteger(eventCount)&&eventCount>=0&&eventCount<=trial.value.streamEvents.length);
  const timing=retainedStreamTiming(trial.value.streamEvents.slice(0,eventCount),row.answer,phrase);
  rows.push({backend,case:row.sourceBinding.case,repetition:row.sourceBinding.repetition,inputSha256:row.sourceBinding.inputSha256,
   sourceQuestion:row.question,recognizedQuestion:row.recognizedQuestion,answer:row.answer,error:row.error,
   independentReview:review,independentReviewSha256:reviewRecord.sha256,trialSha256:trial.sha256,
   reportedFirstDecodedDeltaMs:trial.value.firstDecodedDeltaMs,reportedFirstCompleteWordFromRequestMs:trial.value.firstCompleteWordFromRequestMs,
   ...timing,elapsedMs:trial.value.elapsedMs,requestObservationEndMs:trial.value.requestObservationEndMs,
   reportedBackend:trial.value.pipeline?.backend??null,
   reportedActualServiceTier:trial.value.pipeline?.actualServiceTier??null,
   reportedCachedInputTokens:trial.value.pipeline?.cachedInputTokens??null,
   observationBudgetExhausted:trial.value.observationBudgetExhausted??false,
   cleanupBudgetExhausted:trial.value.cleanupBudgetExhausted??false,errorOrigin:trial.value.errorOrigin??null,
   successfulAnswerUsefulPhraseMs:row.error?null:timing.firstRetainedPhraseMs});
  sources.push({file:trial.file,sha256:trial.sha256},{file:reviewRecord.file,sha256:reviewRecord.sha256});
 }
}
const summaries=Object.fromEntries(['codex','chatgpt'].map(backend=>{
 const group=rows.filter(row=>row.backend===backend);
 assert.equal(group.length,complete.value.cases*complete.value.repetitions);
 return [backend,{recordedTrials:group.length,errorTrials:group.filter(row=>row.error).length,
  experimentObservationLimits:group.filter(row=>row.observationBudgetExhausted).length,
  experimentCleanupLimits:group.filter(row=>row.cleanupBudgetExhausted).length,
  backendErrorTrials:group.filter(row=>row.errorOrigin==='backend').length,
  reportedActualServiceTierCounts:Object.fromEntries([...new Set(group.map(row=>row.reportedActualServiceTier??'unreported'))]
   .map(tier=>[tier,group.filter(row=>(row.reportedActualServiceTier??'unreported')===tier).length])),
  modelVerdicts:Object.fromEntries(['correct','incorrect','incomplete','unverified'].map(verdict=>[verdict,group.filter(row=>row.independentReview.verdict===verdict).length])),
  firstRetainedWordFromRequestMs:latencyDistribution(group.map(row=>row.firstRetainedWordMs)),
  missingRetainedWordMeasurements:group.filter(row=>row.firstRetainedWordMs===null).length,
  successfulAnswerUsefulPhraseFromRequestMs:latencyDistribution(group.map(row=>row.successfulAnswerUsefulPhraseMs)),
  missingSuccessfulUsefulPhraseMeasurements:group.filter(row=>row.successfulAnswerUsefulPhraseMs===null).length,
  requestToObservationEndMs:latencyDistribution(group.map(row=>row.requestObservationEndMs)),
  requestToOperationEndIncludingCleanupMs:latencyDistribution(group.map(row=>row.elapsedMs))}];
}));
const pairs=[];
for(const codex of rows.filter(row=>row.backend==='codex')){
 const chatgpt=rows.find(row=>row.backend==='chatgpt'&&row.case===codex.case&&row.repetition===codex.repetition);
 assert(chatgpt);assert.equal(codex.inputSha256,chatgpt.inputSha256);
 const difference=key=>Number.isFinite(chatgpt[key])&&Number.isFinite(codex[key])?chatgpt[key]-codex[key]:null;
 pairs.push({case:codex.case,repetition:codex.repetition,inputSha256:codex.inputSha256,
  codexVerdict:codex.independentReview.verdict,chatgptVerdict:chatgpt.independentReview.verdict,
  codexError:codex.error,chatgptError:chatgpt.error,
  chatgptMinusCodexFirstWordMs:difference('firstRetainedWordMs'),
  chatgptMinusCodexSuccessfulUsefulPhraseMs:difference('successfulAnswerUsefulPhraseMs')});
}
const metric='chatgptMinusCodexFirstWordMs';
const record={recordedAt:new Date().toISOString(),sources,rows,summaries,pairs,
 pairedFirstWordDifferenceMs:latencyDistribution(pairs.map(pair=>pair[metric])),
 pairCounts:{total:pairs.length,chatgptEarlier:pairs.filter(pair=>Number.isFinite(pair[metric])&&pair[metric]<0).length,
  codexEarlier:pairs.filter(pair=>Number.isFinite(pair[metric])&&pair[metric]>0).length,
  tied:pairs.filter(pair=>pair[metric]===0).length,missingEither:pairs.filter(pair=>!Number.isFinite(pair[metric])).length},
 scope:'Paired final recognized question and captured context diagnostics with fresh Codex history. Callback timestamps start at the request, after token retrieval and thread preparation. ASR, live steering and native visible overlay are excluded. Native protocol/intent processing differs by backend. Verdicts are provisional independent model judgments; executable and manual checks remain separate. Repeated cases are dependent observations. All errors and missing measurements remain counted. No fixed performance threshold or production decision is applied.'};
await writeFile(path.join(directory,'independent-comparison-v70.json'),JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({summaries,pairCounts:record.pairCounts,pairedFirstWordDifferenceMs:record.pairedFirstWordDifferenceMs}));
