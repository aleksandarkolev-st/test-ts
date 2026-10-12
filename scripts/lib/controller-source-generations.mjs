// Offline evidence attribution only. Never changes an accepted request,
// production focus, journal, model prompt or generation text.
const finite = Number.isFinite;
const acceptedTime=job=>finite(job.latency?.questionConfirmedAt)
 &&(job.latency.questionConfirmedAt!==0||job.confirmed===true)?job.latency.questionConfirmedAt:null;

export function playbackNativeBounds(row) {
 const p=row.audio?.playback;
 const anchors=row.audio?.clockAnchors??row.clockAnchors??[];
 if(!p||![p.submitBeforeHostMs,p.submitAfterHostMs,p.completedHostMs].every(finite)
  ||p.submitAfterHostMs<p.submitBeforeHostMs||p.completedHostMs<p.submitAfterHostMs)return null;
 const usable=anchors.filter(a=>[a.hostBeforeMs,a.hostAfterMs,a.nativeMs].every(finite)
  &&a.hostBeforeMs<=a.hostAfterMs);
 if(!usable.length)return null;
 // Envelope, rather than intersect, observed offsets to retain clock drift
 // and sampling uncertainty. A boundary observation stays ambiguous.
 const offsetLow=Math.min(...usable.map(a=>a.nativeMs-a.hostAfterMs));
 const offsetHigh=Math.max(...usable.map(a=>a.nativeMs-a.hostBeforeMs));
 return {start:{low:p.submitBeforeHostMs+offsetLow,high:p.submitAfterHostMs+offsetHigh},
  end:{low:p.completedHostMs+offsetLow,high:p.completedHostMs+offsetHigh},
  scope:'Observed playback/clock envelope; not provider word-time alignment or proof of acoustic provenance.'};
}

export function sourceGenerationAudit(row,jobs,nextNativeStartedAt=Infinity) {
 const bounds=playbackNativeBounds(row),originalId=row.responseVersion?.split(':')[0]??null;
 const horizonStart=row.nativeStartedAt;
 const all=jobs.filter(job=>{
  const accepted=acceptedTime(job);
  const detected=job.question?.detectedAt;
  return [accepted,detected].some(t=>finite(t)&&finite(horizonStart)&&t>=horizonStart&&t<nextNativeStartedAt)
   ||job.question?.id===originalId;
 }).map(job=>{
  const floor=job.latency?.remoteSpeechStartedAt;
  let association='unknown';
  if(bounds&&finite(floor)){
   association=floor<bounds.start.low||floor>bounds.end.high?'outside_playback':
    floor>=bounds.start.high&&floor<=bounds.end.low?'within_playback':'boundary_uncertain';
  }
  return {generationId:job.question.id,utteranceStartedAt:floor??null,
   detectedAt:job.question.detectedAt,acceptedAt:acceptedTime(job),
   association,phase:job.phase,cancelled:job.cancelled??null,
   completedAt:job.latency?.completedAt??null,error:job.error??null};
 }).sort((a,b)=>(a.acceptedAt??a.detectedAt)-(b.acceptedAt??b.detectedAt)
  ||a.detectedAt-b.detectedAt||a.generationId.localeCompare(b.generationId));
 // Select by input timing, never by success, nonempty text, confirmed flag or
 // cancellation. A newer cancelled request is still a requested outcome.
 const associated=all.filter(g=>g.association==='within_playback'&&finite(g.acceptedAt));
 const latest=associated.at(-1);
 const boundary=all.some(g=>finite(g.acceptedAt)&&(g.association==='boundary_uncertain'
  ||g.association==='unknown'&&(!latest||g.acceptedAt>=latest.acceptedAt)));
 const target=boundary?null:latest?.generationId??null;
 return {originalGenerationId:originalId,playbackNativeBounds:bounds,generations:all,
  targetGenerationId:target,selectionChanged:target==null?null:target!==originalId,
  ambiguous:boundary||!target,
  scope:'Separate source-timing audit. Keep every generation and the unchanged original row. Timing association does not establish transcription origin, correctness, completed work or semantic acceptance.'};
}
