// Offline evidence of actual delivery; generation instructions are not coverage.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pcmData} from './lib/rapid-wave.mjs';
import {latencyDistribution} from './lib/streamed-word-latency.mjs';
const [directory]=process.argv.slice(2);assert(directory,'RECORDING_DIRECTORY');
const root=path.resolve(directory);assert(root.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));
const bytes=await readFile(path.join(root,'interview.json')),journal=JSON.parse(bytes);
assert(journal.status==='complete'&&journal.stoppedCleanly,'Require a clean completed recording');
const hash=data=>createHash('sha256').update(data).digest('hex');
async function waveEvidence(audio){
 const file=path.resolve(root,audio.waveFile);assert(file.toLowerCase().startsWith(root.toLowerCase()+path.sep));
 const wave=await readFile(file);assert.equal(hash(wave),audio.sha256,'Recorded waveform hash must match actual bytes');
 const pcm=pcmData(wave);let first=-1,last=-1,zeroStart=-1,longest=null;
 for(let frame=0;frame<pcm.length/2;frame++){
  if(pcm.readInt16LE(frame*2)!==0){
   if(first<0)first=frame;
   if(zeroStart>=0&&last>=0&&(!longest||frame-zeroStart>longest.frames))longest={startFrame:zeroStart,endFrame:frame,frames:frame-zeroStart,durationMs:(frame-zeroStart)/16};
   last=frame;zeroStart=-1;
  }else if(zeroStart<0)zeroStart=frame;
 }
 const playback=audio.playback;
 assert(playback&&Number.isFinite(playback.submitBeforeHostMs)&&Number.isFinite(playback.completedHostMs));
 assert.equal(playback.sampleRate,16000);
 assert.equal(playback.sourceFrames,pcm.length/2);
 // waveOut positions count consumed frames. The legacy playback field is
 // the exclusive end position, one beyond the zero-based last voiced frame.
 assert.equal(playback.lastNonzeroFrame,last+1);
 return {file:path.relative(process.cwd(),file),sha256:audio.sha256,sourceDurationMs:pcm.length/32,
  firstNonzeroFrameIndex:first,lastNonzeroFrameIndex:last,voicedEndPositionFrames:last+1,longestInternalExactZeroSpan:longest,
  requestedPause:audio.waveformEvidence?.requestedPause??null,
  physicalLastVoicedHostMs:{low:playback.lastVoicedDevicePositionLowerHostMs,high:playback.lastVoicedDevicePositionUpperHostMs},
  submitBeforeHostMs:playback.submitBeforeHostMs,completedHostMs:playback.completedHostMs};
}
const rows=[];
for(const [index,row] of journal.rows.entries()){
 const wave=await waveEvidence(row.audio),prior=journal.rows[index-1];
 const incomingOrigin=prior?.nextDeliveryOrigin??(prior?.provisionalReview?'examiner_generated_from_actual_partial_answer':index===0?'initial_question':'examiner_generated_followup');
 const basis=prior?.followupBasis,version=basis?.responseVersion?.split(':'),partial=basis?.partialAnswer;
 const paint=basis?(journal.overlayPaintSamples??[]).findLast(sample=>sample.hostMs<=basis.hostMs
  &&sample.questionId===version[0]&&sample.revision===Number(version[1])&&sample.recorderVersion===2&&sample.visible
  &&sample.visibleEnd>sample.visibleStart&&partial?.startsWith(sample.text)):null;
 const words=row.question.match(/[\p{L}\p{N}_]+/gu)??[];
 rows.push({round:row.round,question:row.question,sourceWordCount:words.length,wave,phase:row.phase,
  incomingOrigin,runningAtPlaybackLaunch:row.audio.runningAtPlaybackLaunch??[],
  precedingJobRunningAtLaunch:Boolean(prior?.responseVersion&&(row.audio.runningAtPlaybackLaunch??[]).includes(prior.responseVersion.split(':')[0])),
  priorAnswerBasis:basis?{responseVersion:basis.responseVersion,answerChars:partial.length,hostMs:basis.hostMs,
   sha256:hash(partial),matchingVisiblePaintObservedBeforeBasis:Boolean(paint),matchingPaintHostMs:paint?.hostMs??null,
   basisToPlaybackSubmissionMs:wave.submitBeforeHostMs-basis.hostMs}:null});
}
const background=[];
for(const entry of journal.backgroundPlaybacks??[])background.push({beforeRound:entry.beforeRound,text:entry.text,wave:await waveEvidence(entry.audio)});
const report={recordedAt:new Date().toISOString(),journal:{file:path.join(directory,'interview.json'),sha256:hash(bytes)},
 model:journal.model,effort:journal.effort,examinerModel:journal.examinerModel,examinerEffort:journal.examinerEffort,
 outputDevice:journal.outputDevice,remoteOnly:journal.speechConfiguration?.remoteOnly,
 microphoneCapture:journal.speechConfiguration?.selfCapture,actualInterviewDurationMs:journal.actualInterviewDurationMs,
 rows,background,summary:{sourceQuestions:rows.length,allQuestionAndBackgroundWaveHashesValidated:true,
  questionWaveDurationMs:latencyDistribution(rows.map(row=>row.wave.sourceDurationMs)),
  sourceWordCount:latencyDistribution(rows.map(row=>row.sourceWordCount)),
  shortestQuestions:rows.filter(row=>row.sourceWordCount<=6).map(({round,question,sourceWordCount})=>({round,question,sourceWordCount})),
  incomingDeliveryOrigins:Object.fromEntries([...new Set(rows.map(row=>row.incomingOrigin))].map(origin=>[origin,rows.filter(row=>row.incomingOrigin===origin).length])),
  deliveryByIncomingOrigin:Object.fromEntries([...new Set(rows.map(row=>row.incomingOrigin))].map(origin=>{
   const group=rows.filter(row=>row.incomingOrigin===origin);
   return [origin,{questions:group.length,precedingJobOverlapLaunches:group.filter(row=>row.precedingJobRunningAtLaunch).length,
    priorAnswerBasisToPlaybackSubmissionMs:latencyDistribution(group.map(row=>row.priorAnswerBasis?.basisToPlaybackSubmissionMs))}];
  })),
  activeAnswerOverlapLaunches:rows.filter(row=>row.runningAtPlaybackLaunch.length).length,
  precedingJobOverlapLaunches:rows.filter(row=>row.precedingJobRunningAtLaunch).length,
  priorVisiblePrefixBasisCount:rows.filter(row=>row.priorAnswerBasis?.matchingVisiblePaintObservedBeforeBasis).length,
  priorAnswerBasisToPlaybackSubmissionMs:latencyDistribution(rows.map(row=>row.priorAnswerBasis?.basisToPlaybackSubmissionMs)),
  backgroundUtterances:background.length},
 scope:'Actual completed synthetic playback delivery and immutable waveform hashes, not proof that requested generation styles occurred or that answers are correct. Source questions remain visible for manual topic, false-premise and constraint review. Longest digital silence may include normal synthesis punctuation and is not automatically the requested internal pause. Prefix-basis paint matching is a mechanical observation, not a correct-useful-phrase judgment. Native running-at-launch proves request overlap, not that the old answer was still visibly streaming. Room microphones and acoustic noise are excluded.'};
await writeFile(path.join(root,'delivery-coverage-audit.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({...report,rows:undefined,background:undefined}));
