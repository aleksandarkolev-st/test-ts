import assert from 'node:assert/strict';
import {jobsAtObservation} from './deep-observations.mjs';

const introduction='REMOTE: This is a technical interview. I will present hypothetical systems problems, ask you to analyze them, and keep drilling into your reasoning. Some challenges will be intentionally vague; ask for missing information rather than inventing it.';

export function publicContextCheckpoint(state,cutoff){
 const jobs=(state.jobs??[]).filter(job=>job.confirmed&&!job.cancelled)
  .sort((a,b)=>a.question.detectedAt-b.question.detectedAt);
 const newest=jobs.findLast(job=>typeof job.selectedContext==='string');
 let text=newest?.selectedContext??introduction;
 for(const job of jobs){
  // Only bytes already present in the pre-playback native observation are used.
  // Later completions and the current question's fragments are never copied.
  text+=`\n\nPUBLIC EARLIER QUESTION: ${job.question.text}\nCOPILOT SUGGESTION AVAILABLE AT CHECKPOINT (may be unfinished or wrong): ${job.answer??''}`;
 }
 return {text,provenance:{kind:'public_native_state_before_question_playback',...cutoff,
  responseVersions:jobs.map(job=>`${job.question.id}:${job.latency?.responseRevision??0}`)}};
}

export function replayContextCheckpoint(journal,row){
 if(row.audio?.publicPriorContext)return row.audio.publicPriorContext;
 const cutoff=row.audio?.clockAnchors?.[0];
 assert(cutoff&&Number.isFinite(cutoff.hostBeforeMs)&&Number.isFinite(cutoff.nativeMs),'Missing pre-playback clock checkpoint');
 const observation=(journal.deepObservations??[]).findLast(o=>
  o.hostAfterMs<=cutoff.hostBeforeMs&&o.nativeNow<=cutoff.nativeMs);
 assert(observation,'No authoritative native observation before playback');
 const states=journal.deepObservations??[];
 const checkpoint=publicContextCheckpoint({...observation,jobs:jobsAtObservation(states,states.indexOf(observation))},
  {hostMs:observation.hostAfterMs,nativeMs:observation.nativeNow});
 checkpoint.provenance.reconstructedFromRecordedPrePlaybackObservation=true;
 checkpoint.provenance.playbackCutoff=cutoff;
 return checkpoint;
}
