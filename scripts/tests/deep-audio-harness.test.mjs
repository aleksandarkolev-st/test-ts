import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runDeepAudioInterview} from '../lib/deep-audio-interview.mjs';
import {pcmWave} from '../lib/rapid-wave.mjs';

test('delta recording retains the full live state for turn completion and error checks',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'deep-harness-'));
 try{
  let jobs=[],nativeNow=0;
  const state=()=>({nativeNow:++nativeNow,jobs,view:{error:null,answer:jobs[0]?.answer??''}});
  const result={realAudio:true,intentMode:'existing',speechConfiguration:{remoteOnly:true},rows:[],interviewPlan:{requestedDurationMs:null}};
  await runDeepAudioInterview({root:directory,output:directory,result,rounds:1,budget:{rounds:1,durationMs:null},
   scenario:{seed:'Explain the invariant'},seedQuestion:'Explain the invariant',playbackName:'test',examiner:'examiner',examinerModel:'test',examinerEffort:'low',
   invoke:async name=>{assert.equal(name,'acceptance_jobs');return state();},
   connection:{overlay:{evaluate:async()=>[]}},eventCount:async()=>0,events:async()=>[],persist:async()=>{},
   runChild:async(file,args)=>{
    if(file==='examiner'){
     await writeFile(args[1].replace(/\.json$/,'.review.json'),JSON.stringify({review:{verdict:'correct',question:'Why?'}}));
    }else if(args.includes('-TimingPath')){
     const now=Date.now();await writeFile(args[args.indexOf('-TimingPath')+1],JSON.stringify({lastVoicedDevicePositionLowerHostMs:now,lastVoicedDevicePositionUpperHostMs:now}));
     jobs=[{question:{id:'q',text:'Explain the invariant',detectedAt:2},confirmed:true,cancelled:false,running:false,
      phase:'complete',answer:'Each item is visited once.',selectedContext:'public',latency:{responseRevision:0,completedAt:10,firstWordAt:7,speechStoppedAt:6}}];
    }else await writeFile(args[args.indexOf('-OutputPath')+1],pcmWave(Buffer.from([1,0,0,0])));
   }});
  assert.equal(result.status,'complete');assert.equal(result.stopReason,'rounds_reached');
  assert.equal(result.rows[0].phase,'complete');assert.equal(result.rows[0].review.verdict,'correct');
  assert.equal(result.pollErrors.length,0);
  assert(result.deepObservations.every(r=>r.format==='changed_jobs_sparse_context'&&!r.view));
 }finally{await rm(directory,{recursive:true,force:true});}
});
