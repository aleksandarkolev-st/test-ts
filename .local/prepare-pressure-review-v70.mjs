import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/continuous-pressure-t';
const journalBytes=await readFile(`${directory}/interview.json`),journal=JSON.parse(journalBytes);
const tokenBytes=await readFile(`${directory}/pressure-token-alignment.json`),tokens=JSON.parse(tokenBytes);
const events=JSON.parse(await readFile(`${directory}/pressure-events-audit.json`));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(tokens.journalSha256,hash(journalBytes));assert.equal(events.journalSha256,tokens.journalSha256);
const normalize=text=>text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
const offset=(events.clockOffsetMs.low+events.clockOffsetMs.high)/2;
const mappedSource=new Map(tokens.alignment.filter(item=>item.recognizedIndex!=null&&item.sourceIndex!=null).map(item=>[item.recognizedIndex,item.sourceIndex]));
const rows=journal.continuousPressure.nativeJobs.slice().sort((a,b)=>a.question.detectedAt-b.question.detectedAt).map((job,index)=>{
 const questionWords=normalize(job.question.text),matches=[];
 for(let start=0;start+questionWords.length<=tokens.recognized.length;start++){
  if(questionWords.every((word,i)=>word===tokens.recognized[start+i].word)){
   const end=start+questionWords.length-1,endpoint=tokens.recognized[end].endedHostMs;
   const targetNative=job.latency.transcriptFinalAt||job.latency.speechStoppedAt||job.question.detectedAt;
   matches.push({start,end,lastAsrEndedHostMs:endpoint,distanceMs:Math.abs((endpoint.low+endpoint.high)/2-(targetNative-offset))});
  }
 }
 assert(matches.length,`No exact recognized source span for ${job.question.id}`);matches.sort((a,b)=>a.distanceMs-b.distanceMs);
 const match=matches[0];assert(matches.length===1||match.distanceMs<matches[1].distanceMs,'Temporally ambiguous source occurrence');
 const sourceIndices=Array.from({length:match.end-match.start+1},(_,i)=>mappedSource.get(match.start+i)).filter(Number.isFinite);
 assert(sourceIndices.length,'No source tokens mapped to recognized job');
 const low=Math.min(...sourceIndices),high=Math.max(...sourceIndices),fragments=[];
 for(const segment of journal.continuousPressure.segments){
  const selected=tokens.source.slice(low,high+1).filter(word=>word.sequence===segment.sequence);
  if(!selected.length)continue;
  const last=selected.at(-1),all=tokens.source.filter(word=>word.sequence===segment.sequence);
  const next=all.find(word=>word.characterOffset>last.characterOffset);
  const startOffset=selected[0].characterOffset,endOffset=next?.characterOffset??segment.text.length;
  fragments.push({sequence:segment.sequence,clipId:segment.clipId,kind:segment.kind,startCharacter:startOffset,endCharacter:endOffset,
   text:segment.text.slice(startOffset,endOffset).trim(),completeSourceUtterance:startOffset===0&&endOffset===segment.text.length});
 }
 return {round:index+1,trial:index+1,question:fragments.map(fragment=>fragment.text).join('\n'),recognizedQuestion:job.question.text,
  answer:job.answer,phase:job.phase,cancelled:job.cancelled,error:job.error,selectedContext:job.selectedContext,
  responseVersion:`${job.question.id}:${job.latency.responseRevision??0}`,
  sourceBinding:{nativeQuestionId:job.question.id,sourceFragments:fragments,recognizedSpan:match,exactRepeatedSpanCandidates:matches.length,
   nextClosestCandidateDistanceMs:matches[1]?.distanceMs??null,
   scope:'Exact token match to final ASR, disambiguated by the native final-transcript/speech-end clock. Source wording comes from the globally aligned original spoken tokens. Partial source utterances remain partial, so future spoken constraints are not injected into this job review. Per-source completeness and continuation handling require separate assessment.'}};
});
const projection={status:journal.status,stoppedCleanly:journal.stoppedCleanly,model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 derivedFrom:{file:`${directory}/interview.json`,journalSha256:tokens.journalSha256,eventsSha256:tokens.eventsSha256,tokenAlignmentSha256:hash(tokenBytes)},
 measurementKind:'offline_source_bound_native_job_review_projection',rows,
 scope:'Deferred independent per-native-job assessment of recorded answers, using source fragments and actual selected public context. This is an offline projection of the completed recording, not new executions. Cancelled, ignored, split and unfinished jobs remain present. Original raw recordings and source utterances are preserved. Per-source completeness, inappropriate stale visibility and pause continuation are not replaced by per-job grades.'};
await writeFile(`${directory}/pressure-review-input.json`,JSON.stringify(projection,null,2),{flag:'wx'});
console.log(JSON.stringify({rows:rows.length,exactSpanMatched:rows.length,multiSourceJobs:rows.filter(row=>row.sourceBinding.sourceFragments.length>1).length,
 partialSourceFragments:rows.flatMap(row=>row.sourceBinding.sourceFragments).filter(fragment=>!fragment.completeSourceUtterance).length,
 maxEndpointDistanceMs:Math.max(...rows.map(row=>row.sourceBinding.recognizedSpan.distanceMs)),independentReviewPending:true}));
