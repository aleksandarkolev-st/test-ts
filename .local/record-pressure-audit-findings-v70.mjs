import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/continuous-pressure-t';
const bytes=await readFile(`${directory}/interview.json`),journal=JSON.parse(bytes);
const sha256=createHash('sha256').update(bytes).digest('hex');
const tokens=JSON.parse(await readFile(`${directory}/pressure-token-alignment.json`));
const projection=JSON.parse(await readFile(`${directory}/pressure-review-input.json`));
const lexical=JSON.parse(await readFile(`${directory}/pressure-lexical-alignment.json`));
const drift=JSON.parse(await readFile(`${directory}/pressure-drift-audit.json`));
const visibility=JSON.parse(await readFile(`${directory}/pressure-visibility-contextual-audit.json`));
for(const item of [tokens,lexical,drift,visibility])assert.equal(item.journalSha256,sha256);assert.equal(projection.derivedFrom.journalSha256,sha256);
const covered=new Set();for(const row of projection.rows){const span=row.sourceBinding.recognizedSpan;for(let i=span.start;i<=span.end;i++)covered.add(i);}
const uncovered=tokens.recognized.flatMap((word,index)=>covered.has(index)?[]:[{index,...word}]);
const worst=visibility.windows.reduce((a,b)=>a.differentQuestionVisibleMs>b.differentQuestionVisibleMs?a:b);
const old=journal.continuousPressure.nativeJobs.find(job=>job.question.id===worst.intervals[0].shownQuestionId);
assert(worst.nearestObservedQuestionAfterInitialConfirmation.question.text.includes('sliding window median'));
assert(old.question.text.includes('accelerates'));
const manualStale={currentJobId:worst.confirmedQuestionId,
 confirmedQuestionObservedAt:worst.nearestObservedQuestionAfterInitialConfirmation,
 earlierJobQuestion:old.question,intervals:worst.intervals,
 initialDistinctJobConfirmationHostMs:worst.confirmationHostMs,
 lastSameJobConfirmationHostMs:worst.lastRecordedSameJobConfirmationHostMs,
 finalRecordedNativeJobSpeechEndHostMs:worst.finalRecordedNativeSpeechEndHostMs,
 durationAfterInitialConfirmationMs:worst.differentQuestionVisibleMs,
 durationAfterLastSameJobConfirmationMs:worst.differentQuestionVisibleAfterLastSameJobConfirmationMs,
 durationAfterFinalNativeJobSpeechEndMs:worst.differentQuestionVisibleAfterFinalNativeSpeechEndMs,
 verdict:'observed_stale_answer_display',
 reason:'The newly confirmed question asks for a sliding-window median invariant. The actual visible paragraph still answers the preceding vehicle-acceleration question. Its IDs, observed question state, visible text and held paint interval are recorded. The 51-second initial-confirmation interval includes later continued speech/refinements; the shorter post-native-job-speech interval is separately recorded.',
 scope:'Direct review of this concrete recorded display example. Does not classify all different-ID intervals or establish source utterance endpoint latency.'};
await writeFile('docs/evidence/pressure-stale-display-v70.json',JSON.stringify({recordedAt:new Date().toISOString(),journalSha256:sha256,manualStale},null,2),{flag:'wx'});
const record={recordedAt:new Date().toISOString(),journalSha256:sha256,model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 lexicalAlignment:lexical.summary,
 nativeFrameTokenCoverage:{finalAsrTokens:tokens.recognized.length,coveredByRecordedNativeQuestionSpans:covered.size,
  uncovered,sourceBoundJobRows:projection.rows.length,multiSourceJobs:projection.rows.filter(row=>row.sourceBinding.sourceFragments.length>1).length,
  maxAsrEndpointVsNativeFinalTranscriptDifferenceMs:Math.max(...projection.rows.map(row=>row.sourceBinding.recognizedSpan.distanceMs)),
  scope:'Union of temporally disambiguated exact token spans in all final recorded native question frames, including cancelled/superseded/unfinished jobs. Case and punctuation are ignored. Coverage establishes retained text somewhere in the recording, not per-utterance delivery, current selected context, semantic preservation or correct visible answers.'},
 drift:{firstHalf:drift.firstHalf,secondHalf:drift.secondHalf,resources:drift.resources,scope:drift.scope},
 manualStale,independentJobReviewInput:`${directory}/pressure-review-input.json`,
 remaining:['Independent Sol 6.1 low per-native-job answer assessment.','Source utterance completeness and continuation handling across split/merged jobs.','Semantic review of other different-question visible intervals.'],
 productionLogicChanged:false};
await writeFile('docs/evidence/pressure-audit-findings-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({lexical:lexical.summary,nativeFrameTokenCoverage:record.nativeFrameTokenCoverage,
 staleAfterInitialConfirmationMs:manualStale.durationAfterInitialConfirmationMs,staleAfterNativeJobSpeechEndMs:manualStale.durationAfterFinalNativeJobSpeechEndMs,independentReviewPending:true}));
