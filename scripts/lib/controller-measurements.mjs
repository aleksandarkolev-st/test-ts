import assert from 'node:assert/strict';
import {latencyDistribution} from './streamed-word-latency.mjs';
import {jobsAtObservation} from './deep-observations.mjs';

// A reviewed, substantive claim is required. A decoded token, RPC ack or
// ungraded fluent opening cannot satisfy the useful-feedback gate.
export function usefulPaint(journal,row,review){
 if(review?.correctness!=='correct'||!review.usefulPrefix)return null;
 const id=row.responseVersion?.split(':')[0];
 const prefix=review.usefulPrefix;
 const sample=(journal.overlayPaintSamples??[]).find(s=>{
  const start=s.text.indexOf(prefix);
  return s.recorderVersion===2&&s.visible&&s.questionId===id&&
   s.revision===(row.latency?.responseRevision??0)&&start>=0&&
   s.visibleStart<=start&&s.visibleEnd>=start+prefix.length;
 });
 if(!sample)return null;
 const endpoint=row.audio?.playback;
 if(endpoint)return {hostMs:sample.hostMs,low:sample.hostMs-endpoint.lastVoicedDevicePositionUpperHostMs,
  high:sample.hostMs-endpoint.lastVoicedDevicePositionLowerHostMs,origin:'actual synthetic speech end'};
 let anchors=row.clockAnchors??[];
 const accepted=row.latency?.questionConfirmedAt;
 if(!anchors.length&&Number.isFinite(accepted)){
  const nearest=(journal.deepObservations??[]).reduce((best,o)=>Number.isFinite(o.nativeNow)&&(!best||Math.abs(o.nativeNow-accepted)<Math.abs(best.nativeNow-accepted))?o:best,null);
  if(nearest)anchors=[{...nearest,nativeMs:nearest.nativeNow}];
 }
 if(!Number.isFinite(accepted)||!anchors.length)return null;
 const offsets=anchors.map(a=>[a.hostBeforeMs-a.nativeMs,a.hostAfterMs-a.nativeMs]);
 return {hostMs:sample.hostMs,low:sample.hostMs-accepted-Math.min(...offsets.map(o=>o[1])),
  high:sample.hostMs-accepted-Math.max(...offsets.map(o=>o[0])),origin:'typed request acceptance; excludes ASR'};
}

function nativeEventAfterSpeech(row,nativeMs){
 const endpoint=row.audio?.playback,anchors=row.audio?.clockAnchors??[];
 if(!endpoint||!anchors.length||!Number.isFinite(nativeMs))return null;
 const lowOffset=Math.max(...anchors.map(a=>a.hostBeforeMs-a.nativeMs));
 const highOffset=Math.min(...anchors.map(a=>a.hostAfterMs-a.nativeMs));
 return {low:nativeMs+lowOffset-endpoint.lastVoicedDevicePositionUpperHostMs,
  high:nativeMs+highOffset-endpoint.lastVoicedDevicePositionLowerHostMs};
}

export function wordError(source,recognized){
 if(recognized==null)return null;
 const words=s=>s.toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[];
 const expected=words(source),actual=words(recognized);let previous=actual.map((_,i)=>i+1);previous.unshift(0);
 for(let i=1;i<=expected.length;i++){
  const next=[i];for(let k=1;k<=actual.length;k++)next.push(Math.min(next[k-1]+1,previous[k]+1,previous[k-1]+(expected[i-1]!==actual[k-1])));
  previous=next;
 }
 return {distance:previous.at(-1),referenceWords:expected.length,rate:expected.length?previous.at(-1)/expected.length:null,
  scope:'Case-insensitive lexical WER; numerals/identifiers are not normalized. Segmentation, source coverage and semantic/identifier errors need separate review.'};
}

function finalizedSourceText(row){
 const latest=new Map();
 for(const event of row.events??[]){const s=event.payload;
  if(event.name==='transcript'&&s?.final&&s.source==='remote'&&s.startedAt>=row.nativeStartedAt)latest.set(s.source+':'+s.id,s);
 }
 const records=[...latest.values()].sort((a,b)=>a.startedAt-b.startedAt||a.endedAt-b.endedAt);
 return records.length?records.map(s=>s.text).join(' '):null;
}

export function auditPanelTransitions(journal){
 const observations=journal.deepObservations??[],paints=journal.overlayPaintSamples??[];
 const jobs=jobsAtObservation(observations,observations.length-1).filter(j=>j.confirmed&&Number.isFinite(j.latency?.questionConfirmedAt))
  .sort((a,b)=>a.latency.questionConfirmedAt-b.latency.questionConfirmedAt);
 const transitions=[];
 for(const job of jobs){
  const time=job.latency.questionConfirmedAt;
  const anchor=observations.reduce((best,o)=>Number.isFinite(o.nativeNow)&&(!best||Math.abs(o.nativeNow-time)<Math.abs(best.nativeNow-time))?o:best,null);
  if(!anchor)continue;
  const accepted={low:time+anchor.hostBeforeMs-anchor.nativeNow-1,high:time+anchor.hostAfterMs-anchor.nativeNow+1};
  const prior=paints.findLast(p=>p.hostMs<=accepted.low);
  if(!prior?.visible||!prior.text||prior.questionId===job.question.id)continue;
  const clearing=paints.find(p=>p.hostMs>=accepted.low&&(p.questionId===job.question.id||!p.visible));
  const oldPaintAfter=paints.filter(p=>p.hostMs>accepted.high&&(!clearing||p.hostMs<clearing.hostMs)&&p.questionId===prior.questionId&&p.visible);
  transitions.push({generationId:job.question.id,previousGenerationId:prior.questionId,acceptedHostMs:accepted,
   priorPanelClearedHostMs:clearing?.hostMs??null,
   possibleOldPanelDurationMs:clearing?{low:Math.max(0,(oldPaintAfter.at(-1)?.hostMs??accepted.low)-accepted.high),high:Math.max(0,clearing.hostMs-accepted.low)}:null,
   oldPaintChangesAfterAcceptance:oldPaintAfter.length,unclearedInObservation:!clearing});
 }
 return {transitions,maxPossibleCarryHighMs:Math.max(0,...transitions.map(t=>t.possibleOldPanelDurationMs?.high??0)),
  oldPaintChangesAfterAcceptance:transitions.reduce((n,t)=>n+t.oldPaintChangesAfterAcceptance,0),
  uncleared:transitions.filter(t=>t.unclearedInObservation).length,
  scope:'Sampled viewport transitions and native/host clock bounds. Upper bounds allow prior text until the first observed clearing/new-generation paint; an unobserved blank paint may make the actual interval shorter. Lower bounds use only observed old-generation paint after acceptance. Not a universal stale-output certificate.'};
}

export function allRowP95(values){
 const observed=values.filter(Number.isFinite).sort((a,b)=>a-b),rank=Math.ceil(values.length*.95)-1;
 return {all:values.length,observed:observed.length,missingOrUnverified:values.length-observed.length,
  p95:rank>=0&&rank<observed.length?observed[rank]:null,
  gateEvaluable:rank>=0&&rank<observed.length,
  scope:'Missing, incorrect and unverified useful delivery rank after finite correct delivery; missing latency is never replaced with a timeout value.'};
}

export function measureJournal(journal,reviews){
 const verdicts=new Map((reviews?.rows??[]).map(r=>[r.round,r]));
 const measured=journal.rows.map(row=>{
  const review=verdicts.get(row.round),p=row.latency?.pipeline??{};
  if(p.generationId&&row.responseVersion)assert.equal(p.generationId,row.responseVersion.split(':')[0],'Do not mix generations');
  const write=Number.isFinite(p.transportWrittenAt)&&Number.isFinite(row.latency?.questionConfirmedAt)?p.transportWrittenAt-row.latency.questionConfirmedAt:null;
  const useful=usefulPaint(journal,row,review);
  const duration=Number.isFinite(row.latency?.completedAt)&&Number.isFinite(p.firstAgentDelta)?row.latency.completedAt-p.firstAgentDelta:null;
  return {round:row.round,name:row.name,kind:row.audio?'native_audio':'typed',phase:row.phase,error:row.error??null,
   intentionalInterruption:row.settle===false,ordinaryFollowup:row.ordinaryFollowup??review?.ordinaryFollowup??false,completed:row.phase==='complete'&&!row.cancelled&&!row.error,
   requestedWorkComplete:review?.completed??null,
   missing:!row.answer?.trim(),correctness:review?.correctness??'pending',reasoningVerdict:review?.reasoningVerdict??'pending',
   acceptedToActualWriteMs:write,usefulFeedbackMs:useful,firstWordMs:row.firstStreamedWordMeasurement?.firstRetainedVisibleStreamedWord?.latencyMs??null,
   sourceSpeechEndToTranscriptFinalMs:nativeEventAfterSpeech(row,row.latency?.transcriptFinalAt),
   sourceSpeechEndToAcceptedMs:nativeEventAfterSpeech(row,row.latency?.questionConfirmedAt),
   acceptedToRequestAttemptMs:Number.isFinite(p.modelRequestSent)&&Number.isFinite(row.latency?.questionConfirmedAt)?p.modelRequestSent-row.latency.questionConfirmedAt:null,
   acceptedToFirstProviderDeltaMs:Number.isFinite(p.firstAgentDelta)&&Number.isFinite(row.latency?.questionConfirmedAt)?p.firstAgentDelta-row.latency.questionConfirmedAt:null,
   submissionAckMs:Number.isFinite(p.turnStartAck)&&Number.isFinite(p.transportWrittenAt)?p.turnStartAck-p.transportWrittenAt:null,
   submittedToInputReaderReceiptMs:Number.isFinite(p.latestInputReaderReceived)&&Number.isFinite(p.transportWrittenAt)?p.latestInputReaderReceived-p.transportWrittenAt:null,
   acceptanceAfterTranscriptFinalMs:Number.isFinite(row.latency?.transcriptFinalAt)&&Number.isFinite(row.latency?.questionConfirmedAt)?row.latency.questionConfirmedAt-row.latency.transcriptFinalAt:null,
   inputTokens:p.inputTokens??null,cachedInputTokens:p.cachedInputTokens??null,outputTokens:p.outputTokens??null,reasoningTokens:p.reasoningTokens??null,
   outputTokensPerStreamingSecond:duration>0&&Number.isFinite(p.outputTokens)?p.outputTokens/(duration/1000):null,
   refinementChars:p.refinementChars??null,steeringCount:p.steeringCount??null,remoteTerminationConfirmed:p.remoteTerminationConfirmed??null,
   localRetirementHoldMs:Number.isFinite(p.localRetirementReleasedAt)&&Number.isFinite(p.localRetirementStartedAt)?p.localRetirementReleasedAt-p.localRetirementStartedAt:null,
   acceptedGenerationsInSourceWindow:(row.events??[]).filter(e=>e.name==='question.confirmed').length,
   selectedRequestWER:row.audio?wordError(row.question,row.recognizedQuestion):null,
   finalizedSourceWER:row.audio?wordError(row.question,finalizedSourceText(row)):null};
 });
 const expected=measured.filter(r=>journal.rows.find(x=>x.round===r.round)?.expectedReply!==false);
 return {scope:'Observed fixture workload; sample p95 is not a population guarantee. Missing/incorrect/incomplete rows remain in counts and have no successful latency. HTTP actual wire write remains unknown when not instrumented.',
  rows:measured,counts:{all:measured.length,expectedReplies:expected.length,complete:expected.filter(r=>r.completed).length,
   missing:expected.filter(r=>r.missing).length,errors:expected.filter(r=>r.error).length,intentionallyInterrupted:expected.filter(r=>r.intentionalInterruption).length,
   correct:expected.filter(r=>r.correctness==='correct').length,incorrect:expected.filter(r=>r.correctness==='incorrect').length,
   requestedWorkComplete:expected.filter(r=>r.requestedWorkComplete===true).length,requestedWorkIncomplete:expected.filter(r=>r.requestedWorkComplete===false).length,
   requestedCompletionPending:expected.filter(r=>r.requestedWorkComplete==null).length,
   reasoningPass:expected.filter(r=>r.reasoningVerdict==='pass').length,reasoningFail:expected.filter(r=>r.reasoningVerdict==='fail').length,
   correctnessPending:expected.filter(r=>r.correctness==='pending').length},
  acceptedToWriteMs:latencyDistribution(measured.map(r=>r.acceptedToActualWriteMs)),
  usefulNativeFeedbackMs:latencyDistribution(measured.filter(r=>r.kind==='native_audio').map(r=>r.usefulFeedbackMs?.high)),
  usefulTypedFeedbackMs:latencyDistribution(measured.filter(r=>r.kind==='typed').map(r=>r.usefulFeedbackMs?.high)),
  usefulFollowupMs:latencyDistribution(measured.filter(r=>r.ordinaryFollowup).map(r=>r.usefulFeedbackMs?.high)),
  allFollowupUsefulP95Ms:allRowP95(expected.filter(r=>r.ordinaryFollowup).map(r=>r.usefulFeedbackMs?.high)),
  providerComputeIsolated:false,panelTransitions:auditPanelTransitions(journal)};
}
