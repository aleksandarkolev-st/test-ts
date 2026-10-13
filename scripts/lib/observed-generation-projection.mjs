import {jobsAtObservation} from './deep-observations.mjs';
export function observedGenerationProjection(journal){
 const jobs=jobsAtObservation(journal.deepObservations,journal.deepObservations.length-1),changes=[],unverified=[];
 const rows=journal.rows.map(r=>{const id=r.responseVersion?.split(':')[0],a=jobs.find(a=>a.question.id===id);if(!a)return r;
  const original=r.latency?.pipeline??{},later=a.latency?.pipeline??{};
  const fields=['generationId','contextVersion','inputHash'];
  const mismatch=fields.filter(k=>original[k]!=null&&JSON.stringify(original[k])!==JSON.stringify(later[k]));
  if(!id||original.generationId!==id||later.generationId!==id||mismatch.length||r.latency?.questionConfirmedAt!==a.latency?.questionConfirmedAt||r.latency?.responseRevision!==a.latency?.responseRevision){unverified.push({round:r.round,generationId:id??null,mismatch,reason:'Immutable input/revision/acceptance identity unverified; retained original projection'});return r;}
  const changed=JSON.stringify({phase:r.phase,answer:r.answer,cancelled:r.cancelled,error:r.error,latency:r.latency})!==JSON.stringify({phase:a.phase,answer:a.answer,cancelled:a.cancelled,error:a.error,latency:a.latency});
  if(changed)changes.push({round:r.round,generationId:id,identityFields:fields,original:{phase:r.phase,answerChars:r.answer?.length??0,cancelled:r.cancelled??false,firstWordAt:r.latency.firstWordAt,actualWrite:r.latency.pipeline.transportWrittenAt},observed:{phase:a.phase,answerChars:a.answer?.length??0,cancelled:a.cancelled??false,firstWordAt:a.latency.firstWordAt,actualWrite:a.latency.pipeline.transportWrittenAt},scope:'Same immutable selected generation observed later; original source row and timing/audio origin preserved'});
  return {...r,answer:a.answer,phase:a.phase,cancelled:a.cancelled,error:a.error??null,latency:a.latency};
 });return {rows,changes,unverified,scope:'Same-generation final observed lifecycle projection, guarded by generation/context/input hash, response revision and original acceptance time. Uses native events already recorded in the immutable journal. Original canonical question, audio source endpoint, viewport samples and recorder-return rows remain preserved. No different generation chosen, no clock reset, unverified identity remains unchanged.'};
}
