import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pcmData} from '../scripts/lib/rapid-wave.mjs';
const [directory,output]=process.argv.slice(2);assert(directory&&output,'RECORDING_DIRECTORY OUTPUT_JSON');
const root=path.resolve(directory),file=path.join(root,'interview.json');assert(root.startsWith(process.cwd()+path.sep));
assert((await stat(file)).size<=8*1024*1024,'Use this bounded audit on small completed pause recordings');
const bytes=await readFile(file),journal=JSON.parse(bytes);assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
const hash=x=>createHash('sha256').update(x).digest('hex'),rows=[];
for(const row of journal.rows){
 const pause=row.audio?.waveformEvidence?.requestedPause;if(pause?.kind!=='exact_pcm_gap')continue;
 const waveFile=path.resolve(root,row.audio.waveFile);assert(waveFile.startsWith(root+path.sep));
 const wave=await readFile(waveFile);assert.equal(hash(wave),row.audio.sha256);const pcm=pcmData(wave),frames=pcm.length/2;
 let first=0,last=frames-1;while(first<frames&&pcm.readInt16LE(first*2)===0)first++;while(last>=first&&pcm.readInt16LE(last*2)===0)last--;
 assert(pause.pauseStartFrame>first&&pause.pauseEndFrame<=last);
 for(let frame=pause.pauseStartFrame;frame<pause.pauseEndFrame;frame++)assert.equal(pcm.readInt16LE(frame*2),0);
 assert.notEqual(pcm.readInt16LE((pause.pauseStartFrame-1)*2),0);assert.notEqual(pcm.readInt16LE(pause.pauseEndFrame*2),0);
 assert.equal(row.audio.playback.sourceFrames,frames);assert.equal(row.audio.playback.lastNonzeroFrame,last+1);
 const measuredPauseMs=(pause.pauseEndFrame-pause.pauseStartFrame)/16,prefixMs=(pause.pauseStartFrame-first)/16,tailMs=(last+1-pause.pauseEndFrame)/16;
 const anchors=row.audio.clockAnchors??[],offsetLow=Math.max(...anchors.map(a=>a.nativeMs-a.hostAfterMs)),offsetHigh=Math.min(...anchors.map(a=>a.nativeMs-a.hostBeforeMs));
 const calibrated=anchors.length>0&&Number.isFinite(offsetLow)&&Number.isFinite(offsetHigh)&&offsetLow<=offsetHigh;
 const physicalEnd=calibrated?{low:row.audio.playback.lastVoicedDevicePositionLowerHostMs+offsetLow,high:row.audio.playback.lastVoicedDevicePositionUpperHostMs+offsetHigh}:null;
 const id=row.responseVersion?.split(':')[0],snapshots=new Map();
 if(physicalEnd)for(const observation of journal.deepObservations??[])for(const job of observation.jobs??[]){
  if(job.question.id!==id||!Number.isFinite(job.latency?.completedAt)||job.latency.completedAt>=physicalEnd.low||observation.nativeNow>=physicalEnd.low)continue;
  const key=JSON.stringify([id,job.latency.responseRevision,job.latency.completedAt,job.confirmed,job.phase]);
  snapshots.set(key,{nativeNow:observation.nativeNow,completedAt:job.latency.completedAt,confirmed:job.confirmed,phase:job.phase,
   responseRevision:job.latency.responseRevision,question:job.question.text,answer:job.answer,error:job.error??null,cancelled:job.cancelled??false});
 }
 rows.push({round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,answer:row.answer,
  responseVersion:row.responseVersion,phase:row.phase,error:row.error??null,cancelled:row.cancelled??false,
  sourceQuestionSha256:hash(row.question),answerSha256:hash(row.answer??''),
  wave:{file:path.relative(process.cwd(),waveFile),sha256:row.audio.sha256,sourceFrames:frames,firstNonzeroFrame:first,lastNonzeroFrame:last,
   sourceDurationMs:frames/16,measuredInsertedPauseMs:measuredPauseMs,requestedPauseMs:pause.pauseMs,
   matchesRequestedPause:measuredPauseMs===pause.pauseMs,prefixSpanMs:prefixMs,tailSpanMs:tailMs,
   firstToLastVoicedSpanExcludingInsertedPauseMs:prefixMs+tailMs,prefixFractionExcludingInsertedPause:prefixMs/(prefixMs+tailMs),
   providedTargetSpeechDurationMs:row.audio.waveformEvidence.targetSpeechDurationMs,
   providedTargetDurationWithinTolerance:row.audio.waveformEvidence.targetDurationWithinTolerance},
  calibratedPhysicalEndNativeMs:physicalEnd,completedJobSnapshotsBeforeFinalPhysicalSpeechEnd:physicalEnd?[...snapshots.values()]:null,
  firstRetainedVisibleWord:row.firstStreamedWordMeasurement?.firstRetainedVisibleStreamedWord??null});
}
assert(rows.length,'No measured exact digital pause was recorded');
const report={recordedAt:new Date().toISOString(),journal:{file,sha256:hash(bytes)},collectorSha256:hash(await readFile(new URL(import.meta.url))),
 model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,rows,independentAccuracyPending:true,goalComplete:false,
 scope:'Actual unchanged PCM, exact internal zero gap, waveOut final frame position and calibrated native observation evidence. Prefix fraction is measured rather than assumed. Completed snapshots before final speech end distinguish confirmed and speculative work; their absence in sparse observations is not proof that no transient early completion occurred. Gap host crossing times were not recorded and are not invented from nominal playback rate. Final constraint retention and visible obsolete text require semantic and paint review.'};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,rows:rows.map(row=>({round:row.round,wave:row.wave,earlyCompletionSnapshots:row.completedJobSnapshotsBeforeFinalPhysicalSpeechEnd?.length??null}))}));
