import test from 'node:test';
import assert from 'node:assert/strict';
import {exactPauseWave} from '../lib/exact-pause-wave.mjs';
import {pcmWave,pcmData} from '../lib/rapid-wave.mjs';
import {waveformEvidence} from '../lib/deep-delivery.mjs';

test('natural SAPI silence is replaced at the join by exactly 1500 ms without trimming voiced samples',()=>{
 const prefix=Buffer.alloc(10000),tail=Buffer.alloc(10000);
 prefix.writeInt16LE(17,0);prefix.writeInt16LE(-31,3000);
 tail.writeInt16LE(21,2000);tail.writeInt16LE(-9,9998);
 const joined=exactPauseWave(pcmWave(prefix),pcmWave(tail),1500),pcm=pcmData(joined.wave);
 assert(pcm.subarray(0,3002).equals(prefix.subarray(0,3002)));
 assert(pcm.subarray(3002,51002).every(x=>x===0));
 assert(pcm.subarray(51002).equals(tail.subarray(2000)));
 const evidence=waveformEvidence(joined.wave,{split:10,pauseMs:1500});
 assert.equal(evidence.longestInternalExactZeroSpan.durationMs,1500);
 assert.equal(joined.evidence.pauseFrames,24000);
});
