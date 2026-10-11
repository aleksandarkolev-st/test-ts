// Independent judgments remain separate from recorded timing and source coverage.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {latencyDistribution} from './lib/streamed-word-latency.mjs';
const [directory,reviewsDirectory,outputDirectory,mode]=process.argv.slice(2);
assert(directory&&reviewsDirectory&&outputDirectory,'RECORDING_DIRECTORY REVIEWS_DIRECTORY OUTPUT_DIRECTORY');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const load=async file=>{const bytes=await readFile(file);return {file,sha256:hash(bytes),data:JSON.parse(bytes)};};
const recording=await load(path.join(directory,'interview.json'));
const projection=await load(path.join(directory,'pressure-review-input.json'));
const clocks=await load(path.join(directory,'pressure-events-audit.json'));
const timing=await load(path.join(directory,'pressure-audit.json'));
assert(recording.data.stoppedCleanly&&recording.data.status==='complete');
assert.equal(projection.data.derivedFrom.journalSha256,recording.sha256);
assert.equal(clocks.data.journalSha256,recording.sha256);
assert.equal(timing.data.journalSha256,recording.sha256);
assert.equal(clocks.data.clocksValid,true);
const jobs=new Map(recording.data.continuousPressure.nativeJobs.map(job=>[job.question.id,job]));
assert.equal(jobs.size,projection.data.rows.length,'Every native job must remain in the review denominator');
for(const row of projection.data.rows){
 const job=jobs.get(row.sourceBinding.nativeQuestionId);assert(job,'Every projected row must identify an actual native job');
 assert.equal(row.answer,job.answer);assert.equal(row.recognizedQuestion,job.question.text);assert.equal(row.phase,job.phase);
 assert(timing.data.rows.some(measured=>measured.questionId===job.question.id),'Every native job must have a timing-audit entry, including missing measurements');
}
if(mode==='--validate-inputs-only'){
 console.log(JSON.stringify({validatedNativeJobs:jobs.size,recordingSha256:recording.sha256,projectionSha256:projection.sha256,
  timingEndpoint:'native job speech-end signal; not physical per-source playback endpoint',modelReviewExecuted:false}));
 process.exit(0);
}
assert(mode==null,'Unknown summary mode');
const rows=[];
for(const [index,row] of projection.data.rows.entries()){
 const reviewFile=path.join(reviewsDirectory,`trial-${String(index+1).padStart(3,'0')}.json`);
 const assessed=await load(reviewFile),assessment=assessed.data;
 assert.equal(assessment.inputSchemaVersion,3);
 assert.equal(assessment.reviewerContinuity,false);
 const sourcePriorQuestions=projection.data.rows.slice(0,index).map(prior=>({question:prior.question??null,round:prior.round??null}));
 const input={answer:row.answer??null,cancelled:row.cancelled??null,error:row.error??null,phase:row.phase??null,publicPriorContext:row.selectedContext??null,
  recognizedQuestion:row.recognizedQuestion??null,sourcePriorQuestions,spokenQuestion:row.question??null};
 assert.equal(assessment.inputSha256,hash(JSON.stringify(input)),`Review ${index+1} must bind the actual recorded input`);
 assert.equal(assessment.model,recording.data.model);assert.equal(assessment.effort,recording.data.effort);
 const id=row.sourceBinding.nativeQuestionId,job=jobs.get(id);assert(job,`Unknown native job ${id}`);
 assert.equal(row.answer,job.answer);assert.equal(row.recognizedQuestion,job.question.text);assert.equal(row.phase,job.phase);
 const verdict=assessment.review.verdict;assert(['correct','incorrect','incomplete','unverified'].includes(verdict));
 const phrase=assessment.review.usefulPhrase??null;
 assert(phrase===null||(phrase.length>0&&row.answer.includes(phrase)),'Useful phrase must be literal recorded answer text');
 const start=phrase?row.answer.indexOf(phrase):-1,end=start+(phrase?.length??0);
 const revision=job.latency.responseRevision;
 const samples=(recording.data.overlayPaintSamples??[]).filter(sample=>sample.questionId===id&&sample.revision===revision);
 const painted=phrase&&!row.cancelled&&!row.error?samples.find(sample=>sample.recorderVersion===2&&sample.visible
  &&sample.visibleStart<=start&&sample.visibleEnd>=end&&row.answer.startsWith(sample.text)&&sample.text.includes(phrase)):null;
 const speechEnd=job.latency.speechStoppedAt;
 const endpoint=Number.isFinite(speechEnd)?{low:speechEnd-clocks.data.clockOffsetMs.high,high:speechEnd-clocks.data.clockOffsetMs.low}:null;
 const phraseLatency=painted&&endpoint?{low:painted.hostMs-endpoint.high,high:painted.hostMs-endpoint.low}:null;
 const firstWord=timing.data.rows.find(measured=>measured.questionId===id);assert(firstWord);
 rows.push({trial:index+1,nativeQuestionId:id,question:row.question,recognizedQuestion:row.recognizedQuestion,
  answer:row.answer,phase:row.phase,cancelled:row.cancelled,error:row.error,sourceBinding:row.sourceBinding,
  independentReview:assessment.review,independentReviewSha256:assessed.sha256,
  firstVisibleWord:firstWord.firstVisibleWord,visibleUsefulPhraseLatencyFromNativeJobEndMs:phraseLatency,
  usefulPhraseMissingReason:phraseLatency?null:row.cancelled?'cancelled_answer':row.error?'answer_error':!phrase?'no_correct_useful_phrase':
   !endpoint?'native_job_speech_endpoint_missing':'phrase_not_observed_in_retained_visible_viewport'});
}
const summary={nativeJobs:rows.length,modelVerdicts:Object.fromEntries(['correct','incorrect','incomplete','unverified'].map(verdict=>
 [verdict,rows.filter(row=>row.independentReview.verdict===verdict).length])),
 nativePhaseCounts:Object.fromEntries([...new Set(rows.map(row=>row.phase))].map(phase=>[phase,rows.filter(row=>row.phase===phase).length])),
 ignoredNativeJobs:clocks.data.lifecycleEvents.filter(event=>event.name==='question.ignored'&&jobs.has(event.payload?.id)).length,
 ignoredJobsWithCancelledFlagFalse:clocks.data.lifecycleEvents.filter(event=>event.name==='question.ignored'&&jobs.has(event.payload?.id)&&!jobs.get(event.payload.id).cancelled).length,
 cancelled:rows.filter(row=>row.cancelled).length,errors:rows.filter(row=>row.error).length,
 firstVisibleWordFromNativeJobEndMs:latencyDistribution(rows.map(row=>row.firstVisibleWord?.latencyMs.high)),
 missingVisibleWords:rows.filter(row=>!row.firstVisibleWord).length,
 visibleUsefulPhraseFromNativeJobEndMs:latencyDistribution(rows.map(row=>row.visibleUsefulPhraseLatencyFromNativeJobEndMs?.high)),
 missingUsefulPhraseMeasurements:rows.filter(row=>!row.visibleUsefulPhraseLatencyFromNativeJobEndMs).length};
const result={recordedAt:new Date().toISOString(),evidence:[recording,projection,clocks,timing].map(({file,sha256})=>({file,sha256})),
 model:recording.data.model,effort:recording.data.effort,outputDevice:recording.data.outputDevice,rows,summary,
 scope:'Deferred independent per-native-job model reviews of this one completed pressure recording, provisional until substantive checks. Original source fragments and selected public context are retained. First-word and useful-phrase latency use the native job speech-end signal calibrated to host time, not a physical source-utterance endpoint. Merged, split, superseded, cancelled and unfinished jobs remain counted. Full-source clause preservation, stale visibility, resource drift and continuation are separate audits. No fixed latency target or population accuracy certification.'};
await mkdir(outputDirectory,{recursive:true});
await writeFile(path.join(outputDirectory,'assessment.json'),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({output:outputDirectory,summary}));
