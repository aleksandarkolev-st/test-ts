import test from 'node:test';
import assert from 'node:assert/strict';
import {explicitContextProbe,questionPause,waveformEvidence} from '../lib/deep-delivery.mjs';
import {pcmWave} from '../lib/rapid-wave.mjs';

test('exact public switch replaces generic Why without adding a private answer',()=>{
 assert.equal(explicitContextProbe({},2,'Why?'),'Why?');
 assert.equal(explicitContextProbe({immediateAfterRounds:{}},2,'Why?'),null);
 assert.equal(explicitContextProbe({immediateAfterRounds:{1:'Explain phantom reads.'}},2,'Why?'),'Explain phantom reads.');
});

test('essential tail pause and its real PCM silence and duration remain independently observable',()=>{
 const question='Begin with atomics. Actually, no atomics are allowed.';
 const delivery={initialPauseBeforeText:'Actually',pauseMs:1500,targetSpeechDurationMs:2000,durationToleranceMs:1};
 const pause=questionPause(question,1,delivery,false);
 assert.equal(pause.split,20);assert.equal(pause.pauseMs,1500);
 assert.equal(questionPause(question,2,delivery,false).split,0);
 assert.throws(()=>questionPause(question,1,{initialPauseBeforeText:'absent'},false),/marker/);
 const pcm=Buffer.alloc(3500*32);
 for(let frame=0;frame<16000;frame++)pcm.writeInt16LE(1,frame*2);
 for(let frame=40000;frame<56000;frame++)pcm.writeInt16LE(-1,frame*2);
 const evidence=waveformEvidence(pcmWave(pcm),pause,delivery);
 assert.equal(evidence.longestInternalExactZeroSpan.durationMs,1500);
 assert.equal(evidence.sourceDurationMinusRequestedPauseMs,2000);
 assert.equal(evidence.targetDurationWithinTolerance,true);
});
