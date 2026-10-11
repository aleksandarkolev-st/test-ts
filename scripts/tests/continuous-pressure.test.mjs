import test from 'node:test';
import assert from 'node:assert/strict';
import {composePressureTrack} from '../lib/continuous-pressure.mjs';
import {pcmWave,pcmData} from '../lib/rapid-wave.mjs';

test('pressure source repeats whole clips to reach duration and preserves real silence and per-clip endpoints',()=>{
 const pcm=Buffer.alloc(32000);pcm.writeInt16LE(15,0);pcm.writeInt16LE(-8,30000);
 const track=composePressureTrack([{id:1,text:'Why?',kind:'followup',wave:pcmWave(pcm),gapMs:1500}],6000);
 assert.equal(track.sourceDurationMs,7500);
 assert.equal(track.segments.length,3);
 assert.deepEqual(track.segments.map(s=>s.lastVoicedFrame),[15001,55001,95001]);
 const composed=pcmData(track.wave);
 assert(composed.subarray(32000,80000).every(x=>x===0));
 assert.equal(track.segments[2].text,'Why?');
});

test('silent pressure clips and unbounded gaps are rejected',()=>{
 const wave=pcmWave(Buffer.alloc(32000));
 assert.throws(()=>composePressureTrack([{wave,gapMs:0}],1000),/Silent source/);
 const pcm=Buffer.alloc(32000);pcm.writeInt16LE(1,0);
 assert.throws(()=>composePressureTrack([{wave:pcmWave(pcm),gapMs:15001}],1000));
});
