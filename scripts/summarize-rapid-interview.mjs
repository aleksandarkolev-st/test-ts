// Read-only offline evidence. Does not modify measured journals or runtime.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {describeRapidAttribution} from './lib/rapid-interview.mjs';
const [destination,...files]=process.argv.slice(2);
assert(destination&&files.length,'Usage: node scripts/summarize-rapid-interview.mjs OUTPUT JOURNAL...');
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const cases=[];
for(const file of files){
 const raw=await readFile(file),journal=JSON.parse(raw);
 assert(journal.status==='complete'&&journal.stoppedCleanly,'Require completed clean measured session');
 const bursts=[];
 for(const burst of journal.rapidBursts){
  const attribution=describeRapidAttribution(burst.nativeJobs,burst.questions);
  const reviews=[];
  for(const [index,job] of burst.nativeJobs.entries()){
   const reviewFile=path.join(path.dirname(file),'model-review',`burst-${burst.index}-job-${index+1}.review.json`);
   try{const reviewRaw=await readFile(reviewFile),review=JSON.parse(reviewRaw);reviews.push({jobId:job.question.id,file:reviewFile,sha256:digest(reviewRaw),model:review.model,effort:review.effort,review:review.review});}
   catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const durations=burst.observations.map(row=>row.pollMs).filter(Number.isFinite).sort((a,b)=>a-b);
  bursts.push({index:burst.index,questions:burst.questions,actualOverlappingInputStarts:burst.actualOverlappingInputStarts,
   attribution,reviews,pollErrors:burst.pollErrors,changedObservationPollMs:{count:durations.length,median:durations.length?durations[Math.floor(durations.length/2)]:null,max:durations.at(-1)??null},
   scope:'Polling durations cover retained changed observations, not every poll. Shared composite answers do not prove each task was addressed. Native merged-turn timing does not assign independent source-request latency.'});
 }
 cases.push({source:{file,sha256:digest(raw)},model:journal.model,effort:journal.effort,tier:journal.tier,startedAt:journal.startedAt,
  status:journal.status,stoppedCleanly:journal.stoppedCleanly,realAudio:journal.realAudio,intentMode:journal.intentMode,
  primaryLatencyMetric:journal.primaryLatencyMetric,rapidConfiguration:journal.rapidConfiguration,rapidSharedPlan:journal.rapidSharedPlan,
  sourceHashes:journal.sourceHashes,diagnosticSourceHashes:journal.diagnosticSourceHashes,nativeBinarySha256:journal.nativeBinarySha256,examinerBinarySha256:journal.examinerBinarySha256,bursts});
}
const result={recordedAt:new Date().toISOString(),scope:'Completed native rapid-fire evidence, post-run reporting only. First retained alphanumeric answer character, not sentence completion. Model grades are synthetic examiner judgments, not certified accuracy. Simulated transcripts exclude capture, ASR and acoustic finalization. Tiny serial samples do not establish model-population p95 or general superiority. Fresh shared public prompts are paired controls prepared before answers, not answer-adaptive hour-long interviews.',
 limitations:['Review sessions run after measured candidates stop; no grading calls during measurement.','Exact merged identity proves text retention only.','Hidden job buffers are diagnostic; displaying speculative or cancelled content remains unauthorized.','The recorded pair predates diagnostic module-hash recording; it contains native/other source hashes but does not freeze rapid module hashes.','No classifier gate, audio rapid-fire, human interruption, or hour-long Sol certification is established.'],cases,targetAchieved:false};
await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({output:destination,models:cases.map(row=>row.model)}));
