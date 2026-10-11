import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('duration audit rejects a claimed hour ending early and keeps missing measurements and reviews separate',async()=>{
 const directory=await mkdtemp(path.resolve('.local/deep-duration-check-'));
 try{
  const file=path.join(directory,'interview.json');
  const journal={status:'in_progress',requestedDurationMs:3600000,actualInterviewDurationMs:2000,
   rows:[{round:1,question:'Why?',recognizedQuestion:'Why',answer:'Because the invariant fails.',phase:'complete',
     review:{verdict:'correct'}},{round:2,question:'And if that changes?',phase:'no_job'}]};
  await writeFile(file,JSON.stringify(journal));
  const args=['scripts/summarize-deep-audio-duration.mjs',directory,'--snapshot'];
  const result=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));
  assert.equal(result.durationVerified,false);assert.equal(result.summary.evaluatedTurns,2);
  assert.equal(result.summary.turnsWithoutVisibleWord,2);assert.equal(result.summary.ungradedFullAnswers,1);
  assert.equal(result.summary.asr.assessedTurns,1);assert.equal(result.summary.asr.unavailableTurns,1);
  assert.equal(result.summary.asr.lexicalWordErrorRate,0);
  journal.status='complete';journal.stopReason='duration_reached';journal.stoppedCleanly=true;
  await writeFile(file,JSON.stringify(journal));
  assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}),/must reach duration/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('continuous pressure requires a clean thirty-minute device playback and observed segment endpoints',async()=>{
 const directory=await mkdtemp(path.resolve('.local/pressure-duration-check-'));
 try{
  const file=path.join(directory,'interview.json');
  const journal={status:'complete',stoppedCleanly:true,stopReason:'continuous_track_reached',
   requestedDurationMs:1800000,actualInterviewDurationMs:1800200,rows:[],
   continuousPressure:{minimumDurationMs:1800000,sourceDurationMs:1800000,
    segments:[{startFrame:0,endFrame:16000,gapMs:0}],nativeJobs:[],
    playback:{submitBeforeHostMs:100,completedHostMs:1800100,frameMarkers:[{frame:16000}]}}};
  const args=['scripts/summarize-deep-audio-duration.mjs',directory,'--snapshot'];
  await writeFile(file,JSON.stringify(journal));
  const report=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));
  assert.equal(report.continuousPressure.durationVerified,true);
  assert.equal(report.summary.evaluatedTurns,0);
  journal.continuousPressure.playback.completedHostMs=500;
  await writeFile(file,JSON.stringify(journal));
  assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}),/must reach duration/);
  journal.continuousPressure.playback.completedHostMs=1800100;
  journal.continuousPressure.playback.frameMarkers=[];
  await writeFile(file,JSON.stringify(journal));
  assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}),/must reach duration/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
