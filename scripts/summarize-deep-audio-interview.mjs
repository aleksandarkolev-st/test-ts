// Recorded execution assessment; finite latency never hides failed/wrong turns.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [journalFile,reviewsDirectory,outputDirectory]=process.argv.slice(2);
assert(journalFile&&reviewsDirectory&&outputDirectory,'JOURNAL REVIEWS_DIRECTORY OUTPUT_DIRECTORY');
const raw=await readFile(journalFile),journal=JSON.parse(raw);
assert(['complete','failed'].includes(journal.status)&&journal.stoppedCleanly,'Require clean terminal recording');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const words=text=>(text??'').toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[];
function editDistance(left,right){
 let old=Array.from({length:right.length+1},(_,i)=>i);
 for(let i=0;i<left.length;i++){
  const current=[i+1];
  for(let j=0;j<right.length;j++)current.push(Math.min(current[j]+1,old[j+1]+1,old[j]+(left[i]===right[j]?0:1)));
  old=current;
 }
 return old.at(-1);
}
function offsetInterval(anchors){
 const bounds=anchors.filter(a=>Number.isFinite(a.nativeMs)).map(a=>[a.nativeMs-a.hostAfterMs,a.nativeMs-a.hostBeforeMs]);
 assert(bounds.length,'Missing clock calibration');
 const low=Math.max(...bounds.map(b=>b[0])),high=Math.min(...bounds.map(b=>b[1]));
 return low<=high?{low,high,consistent:true}:{low:Math.min(...bounds.map(b=>b[0])),high:Math.max(...bounds.map(b=>b[1])),consistent:false};
}
const rows=[];
for(const [index,row] of journal.rows.entries()){
 let assessment=null,assessmentHash=null;
 try{const bytes=await readFile(path.join(reviewsDirectory,`trial-${String(index+1).padStart(3,'0')}.json`));assessment=JSON.parse(bytes);assessmentHash=hash(bytes);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(assessment){
  const input={answer:row.answer??null,phase:row.phase??null,publicPriorContext:row.selectedContext??null,
   recognizedQuestion:row.recognizedQuestion??null,spokenQuestion:row.question??null};
  assert.equal(assessment.inputSha256,hash(Buffer.from(JSON.stringify(input))),`Trial ${index+1} assessment does not match recorded input`);
 }
 const review=assessment?.review,phrase=review?.usefulPhrase??null,start=phrase?(row.answer??'').indexOf(phrase):-1,end=start+(phrase?.length??0);
 const [id,revisionText]=(row.responseVersion??'').split(':'),revision=Number(revisionText);
 const samples=(journal.overlayPaintSamples??[]).filter(s=>s.questionId===id&&s.revision===revision);
 const exact=(row.answer??'');
 const retained=s=>exact.startsWith(s.text);
 const known=samples.filter(s=>s.recorderVersion===2&&s.visible&&retained(s));
 const rendered=phrase&&start>=0&&!row.cancelled&&!row.error?known.find(s=>s.visibleStart<=start&&s.visibleEnd>=end&&s.text.includes(phrase)):null;
 const t=row.audio?.playback,anchors=row.audio?.clockAnchors??[],offset=t?offsetInterval(anchors):null;
 const speechNative=t&&offset?{low:t.lastVoicedDevicePositionLowerHostMs+offset.low,high:t.lastVoicedDevicePositionUpperHostMs+offset.high}:null;
 const visibleLatency=rendered&&t?{low:rendered.hostMs-t.lastVoicedDevicePositionUpperHostMs,high:rendered.hostMs-t.lastVoicedDevicePositionLowerHostMs}:null;
 const stage=stamp=>Number.isFinite(stamp)&&speechNative?{low:stamp-speechNative.high,high:stamp-speechNative.low}:null;
 const l=row.latency??{},p=l.pipeline??{};
 const diff=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?a-b:null;
 const referenceWords=words(row.question),recognizedWords=words(row.recognizedQuestion),errors=editDistance(referenceWords,recognizedWords);
 let missingReason=null;
 if(!rendered){missingReason=row.error?'answer_error':row.cancelled?'cancelled_answer':!review?'independent_review_missing':!phrase?'no_correct_useful_phrase':!samples.some(s=>s.recorderVersion===2)?'viewport_visibility_unverified':!known.length?'answer_not_observed_in_visible_viewport':'selected_phrase_not_observed_as_visible_retained_text';}
 const counts=(name)=>(row.events??[]).filter(e=>e.name===name).length;
 const retainedPaintTimes=known.map(s=>s.hostMs);
 const gaps=retainedPaintTimes.slice(1).map((at,i)=>at-retainedPaintTimes[i]);
 rows.push({trial:index+1,round:row.round,policy:row.policy,question:row.question,recognizedQuestion:row.recognizedQuestion,
  answer:row.answer,phase:row.phase,cancelled:row.cancelled??false,error:row.error??null,
  examinerGrade:row.review??row.provisionalReview?.review??null,examinerGradeUsesPartialAnswer:Boolean(row.provisionalReview&&!row.review),
  independentReview:review??null,independentReviewModel:assessment?.model??null,independentReviewSha256:assessmentHash,
  gradeScope:'Model reviews are provisional. Substantive executable/manual checks must be linked separately; unresolved claims remain unverified.',
  firstCorrectUsefulPhrase:phrase,phraseCharacterRange:start>=0?[start,end]:null,visibleRetainedPhraseLatencyMs:visibleLatency,
  visiblePhraseMissingReason:missingReason,lastVoicedSourceSample:row.audio?.playback??null,nativeSpeechEndIntervalMs:speechNative,
  clockOffsetIntervalMs:offset,firstRetainedCharacterAfterVoicedEndMs:stage(l.firstWordAt),
  asrFinalizationAfterVoicedEndMs:stage(l.transcriptFinalAt),questionConfirmationAfterVoicedEndMs:stage(l.questionConfirmedAt),
  latestRequestAfterVoicedEndMs:stage(p.latestInputSent),firstRenderAcknowledgmentAfterVoicedEndMs:stage(p.firstVisible),completionAfterVoicedEndMs:stage(l.completedAt),
  confirmationAfterAsrMs:diff(l.questionConfirmedAt,l.transcriptFinalAt),latestInputConsumptionMs:diff(p.latestInputConsumed,p.latestInputSent),
  firstCharacterAfterConsumptionMs:diff(l.firstWordAt,p.latestInputConsumed),foregroundSlotWaitMs:diff(p.semaphoreAcquired,p.codexStreamEntered),
  nativeRenderAfterCharacterMs:diff(p.firstVisible,l.firstWordAt),restarts:p.refinementRestartCount??null,steers:p.steeringCount??null,
  followups:p.followupCount??null,answerStartedEvents:counts('answer.started'),cancellationEvents:counts('answer.cancelled'),
  maximumObservedRetainedPaintGapMs:gaps.length?Math.max(...gaps):null,
  asrSourceTextComparison:{referenceWords:referenceWords.length,recognizedWords:recognizedWords.length,editDistance:errors,
   orthographicWordErrorRate:referenceWords.length?errors/referenceWords.length:null,
   scope:'Comparison with TTS source text. Digit-versus-spelled-number formatting and spoken code symbols count as differences; this is not a phonetic transcription ground truth or a semantic constraint check.'},
  lateConditionRecognized:review?.lateConditionRecognized??null,lateConditionAnswered:review?.lateConditionAnswered??null,
  priorContextSha256:typeof row.selectedContext==='string'?hash(Buffer.from(row.selectedContext)):null,frozenContextMatches:row.contextMatches??null,
  otherAnswersStreamingAtPlaybackLaunch:row.audio?.runningAtPlaybackLaunch??[],selfPlayback:row.selfPlayback??null,
  observedSelfSpeechMarkers:(row.events??[]).filter(e=>['speech.started','speech.ended'].includes(e.name)&&e.payload?.source==='self'),
  waveformSha256:row.audio?.sha256??null,usage:{cachedInputTokens:p.cachedInputTokens??null,
   scope:'Token usage unavailable unless provided by the actual backend trace. Subscription snapshots are separate.'},
  under800MsJointProvisionalSuccess:Boolean(visibleLatency&&visibleLatency.high<=800&&review?.verdict==='correct')});
}
const distribution=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return {count:sorted.length,median:sorted.length?sorted[Math.floor(sorted.length/2)]:null,sampleP95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,max:sorted.at(-1)??null};};
function wilson(successes,n){if(!n)return null;const z=1.95996398454,p=successes/n,denom=1+z*z/n,center=(p+z*z/(2*n))/denom,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/denom;return {low:Math.max(0,center-half),high:Math.min(1,center+half),scope:'Descriptive binomial interval only; repeated questions and adaptive within-interview dependence violate independent population sampling.'};}
const policies=[...new Set(rows.map(r=>r.policy))];
const summary=Object.fromEntries(policies.map(policy=>{
 const group=rows.filter(r=>r.policy===policy),successes=group.filter(r=>r.under800MsJointProvisionalSuccess).length;
 return [policy,{evaluatedTurns:group.length,finitePhraseLatency:distribution(group.map(r=>r.visibleRetainedPhraseLatencyMs?.high)),
  missingPhraseMeasurements:group.filter(r=>!r.visibleRetainedPhraseLatencyMs).length,
  modelVerdicts:Object.fromEntries(['correct','incorrect','incomplete','unverified','missing'].map(v=>[v,group.filter(r=>(r.independentReview?.verdict??'missing')===v).length])),
  wrongOrMissingTurnsRemainInDenominator:true,under800MsJointProvisionalSuccesses:successes,successFraction:successes/group.length,
  descriptiveWilson95: wilson(successes,group.length),p95WithMissingOrIncorrectAsFailure:successes/group.length>=.95?'requires_order_statistic_audit':'fails_95_percent_success_requirement'}];
}));
const record={recordedAt:new Date().toISOString(),journal:{file:journalFile,sha256:hash(raw),status:journal.status},
 evaluationKind:journal.evaluationKind,model:journal.model,effort:journal.effort,tier:journal.tier,outputDevice:journal.outputDevice,
 speechConfiguration:journal.speechConfiguration,rows,summary,
 targetCertified:false,samplingScope:'Three answer-adaptive topic pilots and paired fixed replays are reported separately. Replays share source questions and are clustered by question and interview; 100 evaluated executions are not 100 independent draws and do not automatically certify population p95.',
 measurementScope:journal.endpointDefinition,sourceHashes:journal.sourceHashes,diagnosticSourceHashes:journal.diagnosticSourceHashes,nativeBinarySha256:journal.nativeBinarySha256};
await mkdir(outputDirectory,{recursive:true});
await writeFile(path.join(outputDirectory,'assessment.json'),JSON.stringify(record,null,2),{flag:'wx'});
const columns=['trial','round','policy','phase','question','recognizedQuestion','answer','independentVerdict','phraseLatencyLowMs','phraseLatencyHighMs','visiblePhraseMissingReason','error'];
const csv=values=>values.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',');
await writeFile(path.join(outputDirectory,'turns.csv'),[csv(columns),...rows.map(r=>csv([r.trial,r.round,r.policy,r.phase,r.question,r.recognizedQuestion,r.answer,r.independentReview?.verdict,r.visibleRetainedPhraseLatencyMs?.low,r.visibleRetainedPhraseLatencyMs?.high,r.visiblePhraseMissingReason,r.error]))].join('\r\n'),{flag:'wx'});
console.log(JSON.stringify({output:outputDirectory,turns:rows.length,summary}));
