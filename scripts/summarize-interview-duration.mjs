// Offline descriptive evidence. Does not classify or answer live questions.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {distribution,difference,transcriptWordError,qualitySummary,counterSummary,verifiedReviewFindings,interviewCoverage,exactTranscriptAvailability} from './lib/interview-metrics.mjs';

const directory=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&directory.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));
const raw=await readFile(path.join(directory,'interview.json')),report=JSON.parse(raw);
let independentReview=null;
try {
  const reviewRaw=await readFile(path.join(directory,'independent-review.json'));
  independentReview={...verifiedReviewFindings(report,JSON.parse(reviewRaw)),sha256:createHash('sha256').update(reviewRaw).digest('hex')};
} catch(error) { if(error.code!=='ENOENT')throw error; }
const snapshot=process.argv.includes('--snapshot');
assert(snapshot||['complete','failed'].includes(report.status),'Require a terminal interview or explicit live snapshot');
const elapsed=report.actualInterviewDurationMs??null;
const durationVerified=report.status==='complete'&&report.stopReason==='duration_reached'
  &&Number.isFinite(report.requestedDurationMs)&&Number.isFinite(elapsed)&&elapsed>=report.requestedDurationMs;
if(report.status==='complete'&&report.requestedDurationMs!=null)assert(durationVerified,'Completed timed interview must reach its elapsed duration');
const rows=report.rows.map(row=>{
  const l=row.latency,p=l?.pipeline;
  const lexical=report.realAudio?transcriptWordError(row.question,row.inputTranscript):null;
  if(!row.ignored){
    assert(Number.isFinite(l?.firstWordAt)&&Number.isFinite(row.speechEndNativeMs));
    assert.equal(row.firstWordFromSpeechEndMs,l.firstWordAt-row.speechEndNativeMs);
    assert.equal(row.firstWordFromLatestInputMs,l.firstWordAt-p.latestInputSent);
  }
  return {round:row.round,ignored:row.ignored,preservesRecognizedClauses:row.preservesAllRecognizedClauses,
    firstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,firstWordFromLatestInputMs:row.firstWordFromLatestInputMs,
    firstRenderedFromSpeechEndMs:row.firstRenderedFromSpeechEndMs??null,...exactTranscriptAvailability(row),
    asrFinalizationFromSpeechEndMs:difference(l?.transcriptFinalAt,row.speechEndNativeMs),
    confirmationAfterAsrMs:difference(l?.questionConfirmedAt,l?.transcriptFinalAt),
    latestInputConsumptionWaitMs:difference(p?.latestInputConsumed,p?.latestInputSent),
    firstWordAfterLatestInputConsumptionMs:difference(l?.firstWordAt,p?.latestInputConsumed),
    renderAfterFirstWordMs:difference(p?.firstVisible,l?.firstWordAt),
    completedFromSpeechEndMs:difference(l?.completedAt,row.speechEndNativeMs),
    promptChars:p?.promptChars??null,restarts:p?.refinementRestartCount??null,steers:p?.steeringCount??null,
    followups:p?.followupCount??null,completedDraftReplacements:p?.completedDraftReplacementCount??null,
    cancelled:typeof p?.cancelled==='boolean'?p.cancelled:null,
    transcriptWordError:lexical,asrReferenceWords:lexical?.referenceWords??null,
    asrWordEdits:lexical?.edits??null,asrNormalizedWordErrorRate:lexical?.rate??null,
    constraintTracking:row.review?.constraintTracking??null,
    missingInformationHandled:row.review?.missingInformationHandled??null,
    unsupportedAssumption:row.review?.unsupportedAssumption??null,
    modelGrade:row.review?.verdict??null,examinerAttempts:row.examinerAttempts??[]};
});
const mid=Math.ceil(rows.length/2),words=list=>distribution(list.map(row=>row.firstWordFromSpeechEndMs));
const value={status:report.status,durationVerified,requestedDurationMs:report.requestedDurationMs,
  actualInterviewDurationMs:elapsed,stopReason:report.stopReason??null,recordedRounds:rows.length,
  stoppedCleanly:report.stoppedCleanly??null,failure:report.failure??null,
  identity:{file:path.relative(process.cwd(),path.join(directory,'interview.json')),sha256:createHash('sha256').update(raw).digest('hex'),
    binarySha256:report.nativeBinarySha256,sourceHashes:report.sourceHashes},
  scope:'Real elapsed interview duration includes spoken questions, candidate generation and separate examiner grading; startup and scenario preparation are excluded. Latency is client receipt of the first retained alphanumeric answer character after speech end, including ASR. Rendering and completion are separate. Percentiles describe this correlated synthetic interview sample, not a population guarantee. Model grades are not independent correctness certification. Lexical ASR word error ignores punctuation/case and may count harmless spoken numerals or code spellings as differences. Preserved recognized clauses do not prove intended speech was recognized correctly. Missing counters remain unknown. Stage intervals can overlap and must not be summed.',
  model:report.model,effort:report.effort,tier:report.tier,intentMode:report.intentMode,
  outputDevice:report.outputDevice,speechConfiguration:report.speechConfiguration,independentReview,
  summary:{firstWordFromSpeechEndMs:words(rows),firstWordFromLatestInputMs:distribution(rows.map(row=>row.firstWordFromLatestInputMs)),
    firstHalfFirstWordMs:words(rows.slice(0,mid)),secondHalfFirstWordMs:words(rows.slice(mid)),
    ignored:rows.filter(row=>row.ignored).length,
    ...qualitySummary(rows),coverage:interviewCoverage(report.rows),
    exactTranscriptAvailability:{
      firstExactTextFromSpeechEndMs:distribution(rows.map(row=>row.firstExactTextFromSpeechEndMs)),
      lastStableExactTextFromSpeechEndMs:distribution(rows.map(row=>row.lastStableExactTextFromSpeechEndMs)),
      stableExactTextToRequestMs:distribution(rows.map(row=>row.stableExactTextToRequestMs)),
      scope:'Equality with the eventual recognized question after whitespace normalization only. This is retrospective text availability, not semantic completeness, intended-speech fidelity, classifier confidence, or a counterfactual latency improvement. The last matching suffix excludes earlier exact text subsequently revised.'},
    stages:Object.fromEntries(['asrFinalizationFromSpeechEndMs','confirmationAfterAsrMs','latestInputConsumptionWaitMs',
      'firstWordAfterLatestInputConsumptionMs','renderAfterFirstWordMs','completedFromSpeechEndMs'].map(key=>[key,distribution(rows.map(row=>row[key]))])),
    counters:Object.fromEntries(['restarts','steers','followups','completedDraftReplacements'].map(key=>[key,counterSummary(rows,key)])),
    cancellation:{assessed:rows.filter(row=>row.cancelled!==null).length,retainedPipelineCancelled:rows.filter(row=>row.cancelled===true).length},
    interruptionCoverage:{realMicrophone:report.measurement?.includes('does not test real microphone interruptions')?false:null,
      pauseProbe:report.pauseProbe?{hiddenDuringPause:report.pauseProbe.hiddenDuringPause}:null,
      scope:'Retained pipeline cancellation is not a count of all discarded speculative turns. Sequential questions alone do not exercise human interruption handling.'}},rows};
if(!snapshot){
  await writeFile(path.join(directory,'duration-audit.json'),JSON.stringify(value,null,2));
  const fields=['round','ignored','firstWordFromSpeechEndMs','firstWordFromLatestInputMs','firstRenderedFromSpeechEndMs',
    'asrFinalizationFromSpeechEndMs','confirmationAfterAsrMs','latestInputConsumptionWaitMs','firstWordAfterLatestInputConsumptionMs',
    'renderAfterFirstWordMs','completedFromSpeechEndMs','promptChars','restarts','steers','followups','completedDraftReplacements',
    'cancelled','modelGrade','constraintTracking','missingInformationHandled','unsupportedAssumption','preservesRecognizedClauses',
    'asrReferenceWords','asrWordEdits','asrNormalizedWordErrorRate',
    'candidateObservations','firstExactTextFromSpeechEndMs','lastStableExactTextFromSpeechEndMs','stableExactTextToRequestMs'];
  const csv=[fields.join(','),...rows.map(row=>fields.map(key=>row[key]??'').join(','))].join('\n')+'\n';
  await writeFile(path.join(directory,'round-metrics.csv'),csv);
}
console.log(JSON.stringify({status:value.status,durationVerified,actualInterviewDurationMs:elapsed,recordedRounds:rows.length,...value.summary},null,2));
