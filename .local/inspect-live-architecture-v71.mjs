import {connectNativePages} from '../scripts/lib/native-cdp.mjs';
import {appendFile} from 'node:fs/promises';
const connection=await connectNativePages(9239);
try{
 const before=Date.now();
 const state=await connection.main.evaluate(async()=>{
  const s=await window.__TAURI_INTERNALS__.invoke('acceptance_jobs');
  const timings=await window.__TAURI_INTERNALS__.invoke('get_answer_timings');
  return {nativeNow:s.nativeNow,timings,view:{status:s.view.status,active:s.view.active,error:s.view.error},jobs:s.jobs.map(j=>({
   id:j.question.id,question:j.question.text,phase:j.phase,running:j.running,cancelled:j.cancelled,error:j.error,
   answerCharacters:j.answer.length,latency:j.latency}))};
 });
 const observation={hostBeforeMs:before,hostAfterMs:Date.now(),...state,
  scope:'Read-only bounded native job snapshot. Native timestamps and numerical debug diagnostics, no independent accuracy claim; these are partial observations of a live recording.'};
 await appendFile('artifacts/deep-interview-v71/live-architecture-observations.jsonl',JSON.stringify(observation)+'\n');
 console.log(JSON.stringify({...observation,timings:state.timings.filter(([id])=>state.jobs.some(job=>job.id===id)).map(([id,p])=>({id,confirmedToSendMs:p.latestInputSent==null||p.questionConfirmed==null?null:p.latestInputSent-p.questionConfirmed,
  sentToReaderMs:p.latestInputReaderReceived==null?null:p.latestInputReaderReceived-p.latestInputSent,
  readerToConsumerMs:p.latestInputReaderReceived==null||p.latestInputConsumed==null?null:p.latestInputConsumed-p.latestInputReaderReceived,
  consumerToDeltaMs:p.latestInputConsumed==null||p.retainedFirstDelta==null?null:p.retainedFirstDelta-p.latestInputConsumed,
  inputAckWaitMs:p.latestInputAck==null||p.latestInputSent==null?null:p.latestInputAck-p.latestInputSent,
  restarts:p.refinementRestartCount,queuePeak:p.readerQueuePeak,fullQueues:p.readerFullQueueCount,readerTotalUs:p.readerSendTotalUs,readerMaxUs:p.readerSendMaxUs,callbackTotalUs:p.deltaCallbackTotalUs,callbackMaxUs:p.deltaCallbackMaxUs})),jobs:state.jobs.map(j=>({id:j.id,phase:j.phase,running:j.running,
  error:j.error,question:j.question,answerCharacters:j.answerCharacters,pipeline:j.latency?.pipeline}))}));
}finally{connection.close();}
