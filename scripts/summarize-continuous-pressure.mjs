import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {streamedWordLatency,latencyDistribution} from './lib/streamed-word-latency.mjs';
const directory=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&directory.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));
const raw=await readFile(path.join(directory,'interview.json')),journal=JSON.parse(raw),pressure=journal.continuousPressure;
assert(pressure&&['complete','failed'].includes(journal.status),'Require terminal continuous pressure evidence');
const anchors=pressure.clockAnchors??[],offsetLow=Math.max(...anchors.map(a=>a.nativeMs-a.hostAfterMs)),
 offsetHigh=Math.min(...anchors.map(a=>a.nativeMs-a.hostBeforeMs));
const clocksValid=anchors.length>=2&&Number.isFinite(offsetLow)&&Number.isFinite(offsetHigh)&&offsetLow<=offsetHigh;
const rows=(pressure.nativeJobs??[]).map(job=>{
 const end=job.latency?.speechStoppedAt;
 const nativeEndpoint=clocksValid&&Number.isFinite(end)?{
  lastVoicedDevicePositionLowerHostMs:end-offsetHigh,lastVoicedDevicePositionUpperHostMs:end-offsetLow}:null;
 const measurement=streamedWordLatency(journal,{responseVersion:`${job.question.id}:${job.latency?.responseRevision??0}`,
  answer:job.answer,latency:job.latency,phase:job.phase,error:job.error,audio:{clockAnchors:anchors,playback:nativeEndpoint}});
 return {questionId:job.question.id,recognizedQuestion:job.question.text,phase:job.phase,cancelled:job.cancelled,error:job.error,
  nativeSpeechEndMs:end,firstVisibleWord:measurement.firstVisibleStreamedWord,
  missingReason:measurement.missingReason,sourceSegmentAssignment:null,
  sourceSegmentAssignmentReason:'Independent timing-and-clause matching pending; rapid utterances may merge or split.',
  counters:{restarts:job.latency?.pipeline?.refinementRestartCount,steers:job.latency?.pipeline?.steeringCount}};
});
const report={recordedAt:new Date().toISOString(),journalSha256:createHash('sha256').update(raw).digest('hex'),
 status:journal.status,stoppedCleanly:journal.stoppedCleanly,model:journal.model,effort:journal.effort,output:journal.outputDevice,
 clocksValid,rows,summary:{nativeJobs:rows.length,sourceSegments:pressure.segments.length,
  nativeEndpointToFirstVisibleWordMs:latencyDistribution(rows.map(r=>r.firstVisibleWord?.latencyMs.high)),
  missingVisibleWords:rows.filter(r=>!r.firstVisibleWord).length,cancelled:rows.filter(r=>r.cancelled).length,
  errors:rows.filter(r=>r.error).length,phases:Object.fromEntries([...new Set(rows.map(r=>r.phase))].map(phase=>[phase,rows.filter(r=>r.phase===phase).length]))},
 scope:'Visible word latency uses the native speech-end signal calibrated to host time, not per-source waveOut endpoints. Source endpoint markers remain in the recording for independent segment attribution. Merged, split, ignored and cancelled jobs remain in the denominator. No source-clause preservation, stale-answer absence or accuracy certificate is inferred from counts.',
 independentAssessmentPending:true,targetCertified:false};
await writeFile(path.join(directory,'pressure-audit.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({...report,rows:undefined}));
