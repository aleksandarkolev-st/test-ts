// Keep immutable updates, rather than copying every old answer on every poll.
export function changedJobObservation(state,fingerprints,timing){
 const jobs=[];
 for(const job of state.jobs??[]){
  const key=JSON.stringify(job),id=job.question.id;
  const previous=fingerprints.get(id);
  if(previous?.serialized!==key){
   const stored={...job};
   if(previous&&previous.selectedContext===job.selectedContext)delete stored.selectedContext;
   fingerprints.set(id,{serialized:key,selectedContext:job.selectedContext});jobs.push(stored);
  }
 }
 return {...timing,nativeNow:state.nativeNow,jobs,format:'changed_jobs_sparse_context',...(state.speechTransport!=null?{speechTransport:state.speechTransport}:{})};
}

export function deepDeliveryRound(round){return (round-1)%12+1;}

// Evaluation probes refer to the actual visible preceding answer. Preparing
// their short waveform ahead of time avoids waiting for a grading inference.
export function immediateContextProbe(nextRound){
 return {2:'Why?',6:'What if that changes?',11:'And if, uh, that thing changes?'}[deepDeliveryRound(nextRound)]??null;
}

export function jobsAtObservation(observations,index){
 const latest=new Map();
 for(const record of observations.slice(0,index+1)){
  if(!['changed_jobs','changed_jobs_sparse_context'].includes(record.format))latest.clear();
  for(const job of record.jobs??[]){
   latest.set(job.question.id,record.format==='changed_jobs_sparse_context'?{...latest.get(job.question.id),...job}:job);
  }
 }
 return [...latest.values()];
}

// Keep diagnostic evidence for missing requests even when no job changes.
// Legacy captures keep their existing changed-job behavior; numeric transport
// snapshots use a bounded heartbeat rather than recording every poll.
export function shouldRetainDeepObservation(record,previous,intervalMs=1000){
 if(record.jobs.length)return true;
 if(!Object.hasOwn(record,'speechTransport'))return false;
 if(!previous)return true;
 const elapsed=Number.isFinite(record.nativeNow)&&Number.isFinite(previous.nativeNow)
  ?record.nativeNow-previous.nativeNow:record.hostAfterMs-previous.hostAfterMs;
 return elapsed>=intervalMs;
}
