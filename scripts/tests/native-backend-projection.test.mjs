import assert from 'node:assert/strict';
import test from 'node:test';
import {projectNativeBackendWave} from '../lib/native-backend-projection.mjs';
const playback=at=>({submitBeforeHostMs:at,lastVoicedDevicePositionLowerHostMs:at+10,lastVoicedDevicePositionUpperHostMs:at+12});
const snap=(at,id,text,answer,state='confirmed')=>({hostBeforeMs:at,hostAfterMs:at+1,snapshot:{question:{id,text},answer,error:null,
 questions:[{id,text,state}],latency:{responseRevision:1,pipeline:{cancelled:false}}}});
test('switch projection cannot grade a later answer as the first source response',()=>{
 const record={waves:[{sourceQuestion:'Explain CUDA.',file:'a.wav',sha256:'a',playback:playback(0)},
  {sourceQuestion:'Explain phantom reads.',file:'b.wav',sha256:'b',playback:playback(50)}],
  events:[{name:'speech.ended',receivedHostMs:11,payload:{source:'remote',timestamp:10}},
   {name:'question.confirmed',receivedHostMs:15,payload:{id:'cuda',timestamp:14}},
   {name:'speech.ended',receivedHostMs:61,payload:{source:'remote',timestamp:60}},
   {name:'question.confirmed',receivedHostMs:65,payload:{id:'db',timestamp:64}}],
  snapshots:[snap(20,'cuda','Explain CUDA.','CUDA uses warps.'),snap(70,'db','Explain phantom reads.','Predicate rows may change.','complete')],paintSamples:[]};
 const first=projectNativeBackendWave(record,0),second=projectNativeBackendWave(record,1);
 assert.equal(first.answer,'CUDA uses warps.');assert.equal(first.sourceBinding.nativeQuestionId,'cuda');
 assert.equal(first.observationWindow.endHostMs,50);assert.equal(second.answer,'Predicate rows may change.');
 assert.equal(second.sourceBinding.nativeQuestionId,'db');
});
test('an unconfirmed final source never borrows the old visible answer',()=>{
 const record={waves:[{sourceQuestion:'New question.',file:'new.wav',sha256:'n',playback:playback(50)}],
  events:[{name:'question.confirmed',receivedHostMs:55,payload:{id:'old',timestamp:10}},
   {name:'speech.ended',receivedHostMs:61,payload:{source:'remote',timestamp:60}}],
  snapshots:[snap(70,'old','Old question.','Old answer.','complete')],paintSamples:[]};
 const result=projectNativeBackendWave(record,0);assert.equal(result.answer,'');assert.equal(result.phase,'no_job');
 assert.equal(result.sourceBinding.finalSourceConfirmationObserved,false);
});
