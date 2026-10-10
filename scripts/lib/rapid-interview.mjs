// Evaluation only. Fresh public prompts drive the real scheduler. No routing
// rules or response examples are installed in the assistant.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {continueInterview,interviewStopReason} from './interview-duration.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exact=text=>text.trim().replace(/\s+/gu,' ');
export function describeRapidJobs(jobs,questions) {
 return questions.map(question=>{
  const matches=jobs.filter(job=>exact(job.question.text)===exact(question));
  const job=matches.findLast(job=>job.confirmed&&!job.cancelled)??matches.at(-1);
  if(!job)return {question,matched:false,answer:'',outcome:'no_exact_question_job_observed'};
  const l=job.latency;
  return {question,matched:true,id:job.question.id,answer:job.answer,phase:job.phase,confirmed:job.confirmed,
   cancelled:job.cancelled,error:job.error,latency:l,
   firstWordFromNativeSpeechEndMs:l.firstWordAt==null?null:l.firstWordAt-l.speechStoppedAt,
   firstWordFromLatestInputMs:l.firstWordAt==null||l.pipeline?.latestInputSent==null?null:l.firstWordAt-l.pipeline.latestInputSent,
   outcome:job.cancelled?'cancelled':job.error?'error':!job.confirmed?'unconfirmed':l.completedAt==null?'unfinished_at_observation_end':'completed'};
 });
}

// Exact composite identity can establish that the scheduler retained several
// inputs in one job. It cannot establish a separate answer or latency for each.
export function describeRapidAttribution(jobs,questions) {
 const mergedJobs=[];
 for(let start=0;start<questions.length;start++)for(let end=start+2;end<=questions.length;end++){
  const composite=questions.slice(start,end).join(' ');
  const matching=jobs.filter(job=>exact(job.question.text)===exact(composite));
  for(const job of matching){
   const outcome=describeRapidJobs([job],[composite])[0];
   mergedJobs.push({...outcome,sourcePositions:Array.from({length:end-start},(_,i)=>start+i+1),
    scope:'One exact composite native job; latency applies to the merged turn, not to each source request. Task coverage and accuracy require review.'});
  }
 }
 const sourceOutcomes=describeRapidJobs(jobs,questions).map((row,index)=>{
  if(row.matched)return row;
  const shared=mergedJobs.filter(job=>job.sourcePositions.includes(index+1));
  return shared.length?{...row,outcome:'retained_in_exact_merged_job',sharedMergedJobIds:shared.map(job=>job.id),
   firstWordFromNativeSpeechEndMs:null,firstWordFromLatestInputMs:null}:row;
 });
 return {sourceOutcomes,mergedJobs};
}

export async function runRapidInterview(ctx) {
 const {root,output,result,budget,examiner,invoke,connection,event,events,eventCount,runChild,persist,realAudio,playbackName,examinerModel,examinerEffort}=ctx;
 const count=Number(process.env.COPILOT_NATIVE_RAPID_QUESTIONS??3);
 const gapMs=Number(process.env.COPILOT_NATIVE_RAPID_GAP_MS??250);
 const wordMs=Number(process.env.COPILOT_NATIVE_RAPID_WORD_MS??90);
 const drainMs=Number(process.env.COPILOT_NATIVE_RAPID_DRAIN_MS??45000);
 assert(Number.isInteger(count)&&count>=2&&count<=12);
 assert(Number.isFinite(gapMs)&&gapMs>=0&&gapMs<=5000);
 assert(Number.isFinite(wordMs)&&wordMs>=10&&wordMs<=500);
 assert(Number.isFinite(drainMs)&&drainMs>=1000&&drainMs<=120000);
 const planFile=process.env.COPILOT_NATIVE_RAPID_PLAN?path.resolve(process.env.COPILOT_NATIVE_RAPID_PLAN):null;
 let plan=null;
 if(planFile){
  assert(planFile.toLowerCase().startsWith(root.toLowerCase()+path.sep));
  const raw=await readFile(planFile);plan=JSON.parse(raw);
  assert(plan.status==='complete'&&typeof plan.runId==='string'&&typeof plan.createdAt==='string'&&Array.isArray(plan.bursts)&&plan.bursts.length);
  result.rapidSharedPlan={file:path.relative(root,planFile),sha256:createHash('sha256').update(raw).digest('hex'),runId:plan.runId,createdAt:plan.createdAt,
   scope:'Fresh generated public prompts shared by isolated candidate sessions for a paired comparison. Within-plan questions may depend on earlier public premises. No candidate answers or examiner solutions in this plan.'};
 }
 result.rapidConfiguration={count,gapMs,wordMs,drainMs,delivery:realAudio?'continuous synthesized audio':'simulated transcript fragments',pollMs:40};
 result.rapidBursts=[];
 result.measurement+=' Rapid-fire: input timing does not wait for answer completion. Exact source/job attribution is available for injected transcripts; audio source questions can merge or differ under ASR and remain unassigned unless exact identity holds. Hidden retained buffers are diagnostic evidence only.';
 let history='INTERVIEWER INTRODUCTION: This is a technical interview; analyze hypothetical challenges and request missing facts.';
 const clock=performance.now();result.interviewSessionStartedAt=new Date().toISOString();
 const latestJobs=new Map();
 for(let index=1;continueInterview(budget,index,performance.now()-clock);index++){
  let questions;
  if(plan){questions=plan.bursts[index-1]?.questions;if(!questions)break;}
  else {
   const request=path.join(output,`burst-${index}.request.json`);
   await writeFile(request,JSON.stringify({runId:randomUUID(),count,history,brief:result.interviewPlan.brief??'Very hard broad technical interviews: exact algorithms, concurrency, GPU programming and debugging, with vague symptoms, late constraints and corrections.'},null,2));
   await runChild(examiner,['--generate-burst',request],{...process.env,COPILOT_INTERVIEW_EXAMINER_MODEL:examinerModel,COPILOT_INTERVIEW_EXAMINER_EFFORT:examinerEffort});
   questions=JSON.parse(await readFile(request.replace(/\.json$/,'.burst.json'),'utf8')).questions;
  }
  assert(Array.isArray(questions)&&questions.length>=2&&questions.length<=12);
  for(const question of questions)assert(typeof question==='string'&&question.trim()&&question.length<=4000);
  const offset=await eventCount(),burst={index,questions,inputs:[],observations:[],overlayObservations:[],pollErrors:[]};
  result.rapidBursts.push(burst);await persist();
  let sampling=true;
  const poll=async()=>{
   const before=performance.now(),state=await invoke('acceptance_jobs');
   assert(state.nativeNow!=null,'Active native clock required');
   for(const job of state.jobs)latestJobs.set(job.question.id,job);
   const previous=burst.observations.at(-1);
   const data={nativeNow:state.nativeNow,hostAt:Date.now(),pollMs:performance.now()-before,view:state.view,jobs:state.jobs};
   // Preserve changed response buffers/identities and final timings; don't
   // inflate evidence with identical full answers every poll.
   if(!previous||JSON.stringify(previous.jobs)!==JSON.stringify(data.jobs)||previous.view.revision!==data.view.revision)burst.observations.push(data);
   const overlay=await connection.overlay.evaluate(()=>{
    const el=document.querySelector('.answer-content'),p=document.querySelector('.answer p[aria-live="polite"]');
    if(!el||!p)return null;
    const r=p.getBoundingClientRect(),s=getComputedStyle(p);
    return {id:el.dataset.questionId??null,revision:Number(el.dataset.responseRevision??0),text:p.textContent??'',visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
   });
   if(overlay&&JSON.stringify(overlay)!==JSON.stringify(burst.overlayObservations.at(-1)?.overlay))burst.overlayObservations.push({nativeSampleAt:state.nativeNow,hostAt:Date.now(),overlay});
   return state;
  };
  const sampler=(async()=>{while(sampling){try{await poll();}catch(error){burst.pollErrors.push(String(error));}await sleep(40);}})();
  try {
   if(realAudio){
    const {prepareBurstAudio}=await import('./rapid-wave.mjs');
    const audio=await prepareBurstAudio({root,output,index,questions,gapMs,runChild});
    // The source timeline is sample exact; host launch/queue time is not a
    // hardware speech clock. Native VAD timing is reported separately.
    const anchor=await invoke('acceptance_jobs');
    burst.audio={...audio,nativeBeforeLaunch:anchor.nativeNow,hostBeforeLaunch:Date.now(),sourceEndUncertainty:'Includes PowerShell startup, device queue and device/capture offset; not a per-question end-to-end latency anchor.'};
    await runChild('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/play-fixture.ps1'),'-InputPath',audio.waveFile,'-OutputName',playbackName],process.env);
   } else {
    for(const [position,question] of questions.entries()){
     const before=await invoke('acceptance_jobs');
     const startedAt=await event('started');
     const input={position:position+1,question,startedAt,runningAtInputStart:before.jobs.filter(job=>job.running&&!job.cancelled).map(job=>job.question.id)};
     burst.inputs.push(input);
     const words=question.split(/\s+/u),parts=[Math.ceil(words.length/3),Math.ceil(words.length*2/3),words.length];let spoken=0;
     for(const size of new Set(parts)){await sleep((size-spoken)*wordMs);await event('transcript',words.slice(0,size).join(' '),false);spoken=size;}
     input.speechEndAt=await event('ended');await sleep(50);input.finalSentAt=await event('transcript',question,true);
     await sleep(gapMs);
    }
   }
   const deadline=Date.now()+drainMs;
   while(Date.now()<deadline){
    const state=await invoke('acceptance_jobs');
    // Drain after all inputs, never between questions. Include pending jobs,
    // because a newer request can still be queued before starting inference.
    if(!state.jobs.some(job=>!job.cancelled&&(job.running||['confirmed','speculative'].includes(job.phase))))break;
    await sleep(100);
   }
   await poll();
  }finally{sampling=false;await sampler;}
  burst.events=await events(offset);
  const jobs=[...latestJobs.values()],attribution=describeRapidAttribution(jobs,questions);
  burst.outcomes=attribution.sourceOutcomes;burst.mergedJobs=attribution.mergedJobs;
  burst.nativeJobs=jobs.filter(job=>job.question.detectedAt>=(burst.observations[0]?.nativeNow??Infinity));
  burst.actualOverlappingInputStarts=burst.inputs.filter(input=>input.runningAtInputStart.length).length;
  burst.exactSourceJobAttribution=burst.outcomes.filter(row=>row.matched).length;
  burst.scope=realAudio?'Native job latency uses actual VAD speech end. Unmatched ASR/merged source questions are not silently counted as individually answered or inaccurate.':'Injected-input stress test excludes capture/ASR and real acoustic endpointing.';
  for(const question of questions)history+=`\nINTERVIEWER: ${question}`;
  // Keep the real composite response once. Unmatched source identities must
  // not erase the candidate's answer from later adaptive examiner context.
  for(const job of burst.nativeJobs)history+=`\nNATIVE RETAINED QUESTION: ${job.question.text}\nRETAINED ANSWER (not necessarily visible, spoken or correct; ${job.phase}, cancelled=${job.cancelled}): ${job.answer}`;
  result.actualInterviewDurationMs=performance.now()-clock;await persist();
  console.log(`Rapid burst ${index}: ${questions.length} inputs, ${burst.actualOverlappingInputStarts} input starts overlapping generation, ${burst.exactSourceJobAttribution} individual matches, ${burst.mergedJobs.length} exact merged jobs`);
 }
 result.actualInterviewDurationMs=performance.now()-clock;
 result.stopReason=plan?'shared_plan_exhausted':interviewStopReason(budget,result.rapidBursts.length,result.actualInterviewDurationMs);
 assert(result.stopReason!=='round_cap_before_duration');
 result.status='complete';result.targetAchieved=false;
}
