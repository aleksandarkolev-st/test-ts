import assert from 'node:assert/strict';

// Source windows are used only to bind observations, not to impose an answer
// deadline. The first waveform in a switch case ends its observation window
// when the next waveform is submitted. Raw later paints remain in the case.
export function projectNativeBackendWave(record,waveIndex){
 const wave=record.waves[waveIndex];assert(wave?.playback);
 const next=record.waves[waveIndex+1];
 const cutoff=next?.playback.submitBeforeHostMs??Math.max(...record.snapshots.map(item=>item.hostAfterMs));
 assert(Number.isFinite(cutoff));
 const snapshots=record.snapshots.filter(item=>item.hostAfterMs<=cutoff).sort((a,b)=>a.hostAfterMs-b.hostAfterMs);
 const events=record.events.filter(event=>Number.isFinite(event.receivedHostMs)&&event.receivedHostMs>=wave.playback.submitBeforeHostMs&&event.receivedHostMs<=cutoff);
 const lastSpeechEnd=events.findLast(event=>event.name==='speech.ended'&&event.payload?.source==='remote');
 const confirmation=lastSpeechEnd?events.findLast(event=>event.name==='question.confirmed'&&event.payload?.timestamp>=lastSpeechEnd.payload.timestamp):null;
 const id=confirmation?.payload.id??null;
 const jobRows=id?snapshots.flatMap(item=>{const row=item.snapshot.questions.find(row=>row.id===id);return row?[{...item,row}]:[];}):[];
 const current=id?snapshots.filter(item=>item.snapshot.question?.id===id):[];
 const captured=current.at(-1),jobRow=jobRows.at(-1)?.row;
 const paint=id?record.paintSamples.filter(sample=>sample.questionId===id&&sample.hostMs<=cutoff).at(-1):null;
 const answer=captured?.snapshot.answer??paint?.text??'';
 const revision=captured?.snapshot.latency?.responseRevision??paint?.revision??null;
 const transcript=events.filter(event=>event.name==='transcript'&&event.payload?.source==='remote'&&event.payload?.final).map(event=>event.payload.text).join(' ');
 return {question:wave.sourceQuestion,recognizedQuestion:jobRow?.text??captured?.snapshot.question?.text??transcript,
  answer,phase:jobRow?.state??(id?'confirmed':'no_job'),error:captured?.snapshot.error??null,
  cancelled:captured?.snapshot.latency?.pipeline?.cancelled??null,
  responseVersion:id&&revision!==null?`${id}:${revision}`:null,
  latency:captured?.snapshot.latency??null,
  audio:{waveFile:wave.file,sha256:wave.sha256,playback:wave.playback},
  observationWindow:{startHostMs:wave.playback.submitBeforeHostMs,endHostMs:cutoff,endsAtFollowingWaveSubmission:Boolean(next)},
  sourceBinding:{nativeQuestionId:id,finalSpeechEndEvent:lastSpeechEnd??null,finalQuestionConfirmationEvent:confirmation??null,
   finalSourceConfirmationObserved:Boolean(confirmation),visibleSnapshotObservation:captured?{hostBeforeMs:captured.hostBeforeMs,hostAfterMs:captured.hostAfterMs,snapshot:captured.snapshot}:null,
   answerCaptureKind:captured?'last_visible_native_snapshot':paint?'last_recorded_paint_only':'no_answer_observed',
   lastObservedNativeQuestionRow:jobRow??null},
  scope:'Source-bound observed response before the next waveform submission, or through the final case snapshot. No imposed response-time target. Normal authentication does not expose hidden scheduler buffers or selected context. An absent final source confirmation is retained as no_job rather than attaching an unrelated older visible answer.'};
}
