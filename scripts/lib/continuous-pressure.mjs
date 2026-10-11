import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pcmData,pcmWave} from './rapid-wave.mjs';

// A fixed public pressure track complements answer-adaptive interviews. Preparing
// it before playback prevents examiner/synthesis gaps from masquerading as load.
export function composePressureTrack(clips,minimumDurationMs){
 assert(clips.length>0&&Number.isFinite(minimumDurationMs)&&minimumDurationMs>0);
 const parts=[],segments=[];let frames=0,cycle=0;
 while(frames/16<minimumDurationMs){
  const clip=clips[cycle++%clips.length],pcm=pcmData(clip.wave);
  assert(pcm.length/2>=160,'Pressure speech clip is too short');
  let last=pcm.length/2-1;
  while(last>=0&&pcm.readInt16LE(last*2)===0)last--;
  assert(last>=0,'Silent source cannot be a speech segment');
  const gapMs=clip.gapMs??500;
  assert(Number.isInteger(gapMs)&&gapMs>=0&&gapMs<=15000);
  segments.push({sequence:segments.length+1,clipId:clip.id,text:clip.text,kind:clip.kind,
   startFrame:frames,endFrame:frames+pcm.length/2,lastVoicedFrame:frames+last+1,gapMs});
  parts.push(pcm,Buffer.alloc(gapMs*32));frames+=pcm.length/2+gapMs*16;
 }
 return {wave:pcmWave(Buffer.concat(parts)),segments,sourceDurationMs:frames/16,
  repeatedSourceCycles:cycle/clips.length};
}

export async function runContinuousPressure(ctx){
 const {root,output,result,delivery,runChild,invoke,poll,persist,latest,playbackName}=ctx;
 const plan=delivery.continuousPressure;
 assert(plan?.minimumDurationMs>=1800000&&plan.minimumDurationMs<=3600000);
 assert(Array.isArray(plan.clips)&&plan.clips.length>=10);
 const clips=[];
 for(const [index,clip] of plan.clips.entries()){
  assert(typeof clip.text==='string'&&clip.text.trim()&&clip.text.length<=12000);
  const base=path.join(output,`pressure-source-${index+1}`);
  await writeFile(base+'.txt',clip.text,{flag:'wx'});
  const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/synthesize-interview-question.ps1'),'-TextPath',base+'.txt','-OutputPath',base+'.wav'];
  if(clip.pauseBefore){
   const split=clip.text.indexOf(clip.pauseBefore);assert(split>0);
   args.push('-PauseAfterCharacters',String(split),'-PauseMs',String(clip.pauseMs??1500));
  }
  await runChild('powershell.exe',args,process.env);
  clips.push({...clip,id:index+1,wave:await readFile(base+'.wav')});
 }
 const track=composePressureTrack(clips,plan.minimumDurationMs);
 const waveFile=path.join(output,'continuous-pressure.wav'),markerFile=path.join(output,'pressure-frame-markers.json'),timingFile=path.join(output,'pressure-playback.json');
 await writeFile(waveFile,track.wave,{flag:'wx'});
 await writeFile(markerFile,JSON.stringify(track.segments.map(s=>s.lastVoicedFrame)),{flag:'wx'});
 result.evaluationKind='fixed_public_continuous_audio_pressure';
 result.continuousPressure={...track,wave:undefined,waveFile:path.basename(waveFile),
  sha256:createHash('sha256').update(track.wave).digest('hex'),minimumDurationMs:plan.minimumDurationMs,
  scope:'One uninterrupted waveOut track with speech, internal pauses and explicit silence. Fixed repeated public utterances; no adaptive examiner, synthesis or grading during playback. Source segments and native jobs are recorded separately because ASR may merge or split utterances. No automatic one-to-one assignment or accuracy certification.'};
 result.reviewMode='Deferred independent review; no examiner inference during pressure playback';
 await invoke('action',{action:'dismiss'});
 const beforeHostMs=Date.now(),before=await invoke('acceptance_jobs');
 const beforeHostAfterMs=Date.now();
 const originalIds=new Set(before.jobs.map(j=>j.question.id));
 result.interviewSessionStartedAt=new Date().toISOString();await persist();
 await runChild('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/play-pressure-device.ps1'),'-InputPath',waveFile,'-OutputName',playbackName,'-TimingPath',timingFile,'-FrameMarkersPath',markerFile],process.env);
 const after=await poll();
 result.continuousPressure.playback=JSON.parse(await readFile(timingFile,'utf8'));
 result.continuousPressure.clockAnchors=[{hostBeforeMs:beforeHostMs,hostAfterMs:beforeHostAfterMs,nativeMs:before.nativeNow},
  {hostBeforeMs:after.hostBeforeMs,hostAfterMs:after.hostAfterMs,nativeMs:after.nativeNow}];
 result.continuousPressure.nativeJobs=[...latest.values()].filter(j=>!originalIds.has(j.question.id));
 result.actualInterviewDurationMs=Date.now()-beforeHostMs;
 assert(result.continuousPressure.playback.completedHostMs-result.continuousPressure.playback.submitBeforeHostMs>=plan.minimumDurationMs,'Pressure playback ended before the required duration');
 assert(result.continuousPressure.playback.frameMarkers.length===track.segments.length,'Missing source endpoint observations');
 result.requestedDurationMs=plan.minimumDurationMs;result.stopReason='continuous_track_reached';
 result.status='complete';result.targetAchieved=false;result.evaluatedTurnCount=0;
 await persist();
}
