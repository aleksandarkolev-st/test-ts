// Primary user-requested metric: playback speech end to the first visible
// streamed word. It never waits for completion or independent grading.
const wordPattern=/[\p{L}\p{N}_]+(?:['’_-][\p{L}\p{N}_]+)*/u;
import {jobsAtObservation} from './deep-observations.mjs';

function firstCompletedWord(text){
 const match=text.match(wordPattern);
 if(!match)return null;
 const end=match.index+match[0].length;
 // A boundary proves this is a word rather than a still-growing fragment.
 if(end===text.length||/[\p{L}\p{N}_'’\-]/u.test(text[end]))return null;
 return {word:match[0],start:match.index,end};
}

export function streamedWordLatency(journal,row){
 const before=row.audio?.clockAnchors?.[0]?.nativeMs;
 let id=row.responseVersion?.split(':')[0];
 if(!id&&row.phase!=='no_job'){
  const records=journal.deepObservations??[];
  id=jobsAtObservation(records,records.length-1).filter(j=>j.confirmed&&j.question.detectedAt>=before)
   .sort((a,b)=>a.question.detectedAt-b.question.detectedAt).at(-1)?.question.id;
 }
 const observed=journal.deepObservations?.findLast(o=>o.jobs?.some(j=>j.question.id===id))?.jobs.find(j=>j.question.id===id);
 const answer=observed?.answer??row.answer??'';
 const finalRevision=observed?.latency?.responseRevision??Number(row.responseVersion?.split(':')[1]);
 const completedAt=observed?.latency?.completedAt??row.latency?.completedAt;
 const anchors=row.audio?.clockAnchors??[];
 const offsetHigh=anchors.length?Math.min(...anchors.map(a=>a.nativeMs-a.hostBeforeMs)):null;
 const completedHostLower=Number.isFinite(completedAt)&&Number.isFinite(offsetHigh)?completedAt-offsetHigh:null;
 const endpoint=row.audio?.playback;
 const samples=(journal.overlayPaintSamples??[]).filter(s=>s.questionId===id);
 const visible=samples.filter(s=>s.recorderVersion===2&&s.visible).sort((a,b)=>a.hostMs-b.hostMs);
 const measurements=visible.flatMap(sample=>{
  const word=firstCompletedWord(sample.text);
  if(!word||sample.visibleStart>word.start||sample.visibleEnd<word.end||!endpoint)return [];
  return [{word:word.word,characterRange:[word.start,word.end],observedHostMs:sample.hostMs,
   latencyMs:{low:sample.hostMs-endpoint.lastVoicedDevicePositionUpperHostMs,
    high:sample.hostMs-endpoint.lastVoicedDevicePositionLowerHostMs},responseRevision:sample.revision,
   observedDuringStreaming:typeof sample.streaming==='boolean'?sample.streaming:
    completedHostLower!=null?sample.hostMs<completedHostLower:Boolean(observed?.running&&sample.hostMs<=(journal.deepObservations?.at(-1)?.hostBeforeMs??0)),
   retainedInCurrentRecordedAnswer:sample.revision===finalRevision&&answer.startsWith(sample.text.slice(0,word.end))}];
 });
 const streaming=measurements.filter(m=>m.observedDuringStreaming);
 return {questionId:id??null,firstVisibleStreamedWord:measurements[0]??null,
  firstRetainedVisibleStreamedWord:measurements.find(m=>m.retainedInCurrentRecordedAnswer)??null,
  firstWordVisibleWhileStillStreaming:streaming[0]??null,
  firstWordHiddenUntilAfterStreaming:Boolean(measurements.length&&!measurements[0].observedDuringStreaming),
  phase:observed?.phase??row.phase,error:observed?.error??row.error??null,
  missingReason:measurements.length?null:!id?(row.phase==='no_job'?'no_native_question_assigned':'question_not_yet_confirmed'):
   !samples.some(s=>s.recorderVersion===2)?'viewport_visibility_unverified':
   !visible.length?'no_answer_observed_in_visible_viewport':'no_complete_first_word_observed_as_visible',
  scope:'First complete streamed word observed in the actual overlay, measured against the synthetic playback last-nonzero PCM endpoint. Correctness is assessed separately; completion is not required. Paint and device-position observations bound timing resolution.'};
}

export function latencyDistribution(values){
 const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),n=sorted.length;
 return {count:n,min:sorted[0]??null,median:n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:null,
  sampleP95:n?sorted[Math.ceil(n*.95)-1]:null,max:sorted.at(-1)??null};
}
