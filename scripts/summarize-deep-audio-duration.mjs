import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {streamedWordLatency,latencyDistribution} from './lib/streamed-word-latency.mjs';
import {transcriptWordError,verifiedReviewFindings} from './lib/interview-metrics.mjs';

const directory=path.resolve(process.argv[2]??''),snapshot=process.argv.includes('--snapshot');
const revision=process.argv.find(arg=>arg.startsWith('--revision='))?.slice('--revision='.length)??null;
assert(revision===null||/^[a-z0-9-]+$/u.test(revision),'Revision must be a plain artifact suffix');
assert(process.argv[2]&&directory.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));
const raw=await readFile(path.join(directory,'interview.json')),journal=JSON.parse(raw);
let processTreeEvidence=null;
try{
 const treeRaw=await readFile(path.join(directory,'process-tree-resources.jsonl'),'utf8');
 const samples=treeRaw.replace(/^\uFEFF/u,'').trim().split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line.replace(/^\uFEFF/u,'')));
 processTreeEvidence={sha256:createHash('sha256').update(treeRaw).digest('hex'),samples};
}catch(error){if(error.code!=='ENOENT')throw error;}
if(!processTreeEvidence){
 const samples=(journal.nativeResources??[]).map(record=>record.nativeTree).filter(Boolean);
 if(samples.length)processTreeEvidence={sha256:createHash('sha256').update(raw).digest('hex'),source:'interview.json nativeResources[].nativeTree',samples};
}
let independentReview=null;
try{
 const review=await readFile(path.join(directory,'independent-review.json'));
 independentReview={...verifiedReviewFindings(journal,JSON.parse(review)),sha256:createHash('sha256').update(review).digest('hex')};
}catch(error){if(error.code!=='ENOENT')throw error;}
assert(snapshot||['complete','failed'].includes(journal.status),'Require terminal journal or explicit read-only snapshot');
const pressure=journal.continuousPressure??null;
const pressureDurationVerified=journal.status==='complete'&&journal.stoppedCleanly===true&&journal.stopReason==='continuous_track_reached'&&
 pressure?.sourceDurationMs>=pressure?.minimumDurationMs&&pressure?.minimumDurationMs>=1800000&&
 pressure?.playback?.completedHostMs-pressure?.playback?.submitBeforeHostMs>=pressure?.minimumDurationMs&&
 pressure?.playback?.frameMarkers?.length===pressure?.segments?.length;
const durationVerified=pressureDurationVerified||(journal.status==='complete'&&journal.stoppedCleanly===true&&journal.stopReason==='duration_reached'&&
 Number.isFinite(journal.actualInterviewDurationMs)&&Number.isFinite(journal.requestedDurationMs)&&journal.actualInterviewDurationMs>=journal.requestedDurationMs);
if(journal.status==='complete'&&journal.requestedDurationMs!=null)assert(durationVerified,'A completed timed run must reach duration and stop cleanly');
const rows=journal.rows.map(row=>{
 const measure=streamedWordLatency(journal,row),l=row.latency,p=l?.pipeline;
 const error=typeof row.recognizedQuestion==='string'?transcriptWordError(row.question,row.recognizedQuestion):null;
 return {round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,phase:measure.phase,error:measure.error,
  cancelled:row.cancelled??false,responseVersion:row.responseVersion,...measure,
  modelGrade:row.review?.verdict??null,partialModelGrade:row.provisionalReview?.review?.verdict??null,
  gradePending:!row.review,asrWordError:error,
  speechEndNativeMs:l?.speechStoppedAt??null,
  firstCharacterFromNativeSpeechEndMs:l?.firstWordAt==null||l?.speechStoppedAt==null?null:l.firstWordAt-l.speechStoppedAt,
  firstCharacterFromLatestInputMs:l?.firstWordAt==null||p?.latestInputSent==null?null:l.firstWordAt-p.latestInputSent,
  asrFinalizationFromNativeSpeechEndMs:l?.transcriptFinalAt==null||l?.speechStoppedAt==null?null:l.transcriptFinalAt-l.speechStoppedAt,
  renderAfterFirstCharacterMs:p?.firstVisible==null||l?.firstWordAt==null?null:p.firstVisible-l.firstWordAt,
  answerCompletionFromNativeSpeechEndMs:l?.completedAt==null||l?.speechStoppedAt==null?null:l.completedAt-l.speechStoppedAt,
  restarts:p?.refinementRestartCount??null,steers:p?.steeringCount??null,followups:p?.followupCount??null,
  otherAnswersStreamingAtPlaybackLaunch:row.audio?.runningAtPlaybackLaunch??[],
  immediateFollowup:row.nextDeliveryOrigin==='prepared_contextual_probe_after_actual_visible_answer'};
});
const visible=group=>latencyDistribution(group.map(row=>row.firstVisibleStreamedWord?.latencyMs.high));
const memory=records=>Object.fromEntries(['workingSetBytes','privateBytes','rss','heapUsed','handles','threads','pollMs'].map(key=>{
 const samples=(records??[]).filter(row=>Number.isFinite(row[key]));
 return [key,{first:samples[0]?.[key]??null,last:samples.at(-1)?.[key]??null,...latencyDistribution(samples.map(row=>row[key]))}];
}));
const count=key=>rows.reduce((n,row)=>n+(row[key]??0),0),split=Math.ceil(rows.length/2);
const referenceWords=rows.reduce((n,row)=>n+(row.asrWordError?.referenceWords??0),0),edits=rows.reduce((n,row)=>n+(row.asrWordError?.edits??0),0);
const report={recordedAt:new Date().toISOString(),revision,journalSha256:createHash('sha256').update(raw).digest('hex'),status:journal.status,
 failure:journal.failure??null,stoppedCleanly:journal.stoppedCleanly??null,durationVerified,requestedDurationMs:journal.requestedDurationMs,
 actualInterviewDurationMs:journal.actualInterviewDurationMs??null,stopReason:journal.stopReason??null,
 model:journal.model,effort:journal.effort,examinerModel:journal.examinerModel,examinerEffort:journal.examinerEffort,
 outputDevice:journal.outputDevice,speechConfiguration:journal.speechConfiguration,independentReview,rows,
 continuousPressure:pressure?{durationVerified:pressureDurationVerified,sourceDurationMs:pressure.sourceDurationMs,
  minimumDurationMs:pressure.minimumDurationMs,segments:pressure.segments.length,nativeJobs:pressure.nativeJobs.length,
  repeatedSourceCycles:pressure.repeatedSourceCycles,sourceSha256:pressure.sha256,scope:pressure.scope,
  sourceSpeechMs:pressure.segments.reduce((n,s)=>n+(s.endFrame-s.startFrame)/16,0),
  explicitSilenceMs:pressure.segments.reduce((n,s)=>n+s.gapMs,0),
  playback:pressure.playback}:null,
 summary:{evaluatedTurns:rows.length,firstVisibleWordMs:visible(rows),firstRetainedVisibleWordMs:latencyDistribution(rows.map(row=>row.firstRetainedVisibleStreamedWord?.latencyMs.high)),
  firstHalfVisibleWordMs:visible(rows.slice(0,split)),secondHalfVisibleWordMs:visible(rows.slice(split)),
  turnsWithoutVisibleWord:rows.filter(row=>!row.firstVisibleStreamedWord).length,
  cancelled:rows.filter(row=>row.cancelled).length,errors:rows.filter(row=>row.error).length,
  fullModelGrades:Object.fromEntries(['correct','incorrect','incomplete'].map(verdict=>[verdict,rows.filter(row=>row.modelGrade===verdict).length])),
  ungradedFullAnswers:rows.filter(row=>row.gradePending).length,partialModelGrades:rows.filter(row=>row.partialModelGrade).length,
  actualStreamingOverlapLaunches:rows.filter(row=>row.otherAnswersStreamingAtPlaybackLaunch.length).length,
  immediateContextFollowups:rows.filter(row=>row.immediateFollowup).length,
  asr:{assessedTurns:rows.filter(row=>row.asrWordError).length,unavailableTurns:rows.filter(row=>!row.asrWordError).length,referenceWords,edits,lexicalWordErrorRate:referenceWords?edits/referenceWords:null},
  counters:{restarts:count('restarts'),steers:count('steers'),followups:count('followups')},
  nativeProcessResources:memory(journal.nativeResources),recordingProcessResources:memory(journal.recorderResources),
  nativeProcessTreeResources:processTreeEvidence?{
   sha256:processTreeEvidence.sha256,source:processTreeEvidence.source??'process-tree-resources.jsonl',observations:processTreeEvidence.samples.length,
   firstHostMs:processTreeEvidence.samples[0]?.hostBeforeMs,lastHostMs:processTreeEvidence.samples.at(-1)?.hostAfterMs,
   privateAllocationBytes:latencyDistribution(processTreeEvidence.samples.map(s=>s.nativeTreePrivateBytes)),
   summedWorkingSetBytes:latencyDistribution(processTreeEvidence.samples.map(s=>s.nativeTreeSumWorkingSetBytes)),
   scope:processTreeEvidence.samples[0]?.scope}:null,
  pollErrors:journal.pollErrors??[]},
 scope:'Synthetic playback-only interview through WASAPI, local ASR, signed-in Codex and actual overlay. Visible-word timing does not wait for completion or require correctness. Full, partial and pending model reviews remain separate. ASR lexical edits include harmless code/numeral spelling changes. Resource samples distinguish native app from Node recorder and exclude separate ASR, Codex, WebView and GPU allocations. Adaptive correlated samples and before/after halves do not establish population p95, causal degradation or independent accuracy. Real microphone interruptions are excluded.',
 targetCertified:false};
if(snapshot)console.log(JSON.stringify({...report,rows:undefined}));
else{
 await writeFile(path.join(directory,`duration-audit${revision?'-'+revision:''}.json`),JSON.stringify(report,null,2),{flag:'wx'});
 const columns=['round','phase','cancelled','error','visibleWordLatencyHighMs','retainedVisibleWordLatencyHighMs','firstCharacterFromLatestInputMs','modelGrade','partialModelGrade','gradePending','asrWordEdits','overlapAtLaunch','question','recognizedQuestion'];
 const csv=values=>values.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',');
 await writeFile(path.join(directory,`round-metrics${revision?'-'+revision:''}.csv`),[csv(columns),...rows.map(row=>csv([row.round,row.phase,row.cancelled,row.error,
  row.firstVisibleStreamedWord?.latencyMs.high,row.firstRetainedVisibleStreamedWord?.latencyMs.high,row.firstCharacterFromLatestInputMs,
  row.modelGrade,row.partialModelGrade,row.gradePending,row.asrWordError?.edits,row.otherAnswersStreamingAtPlaybackLaunch.length,row.question,row.recognizedQuestion]))].join('\r\n'),{flag:'wx'});
 console.log(JSON.stringify({...report,rows:undefined}));
}
