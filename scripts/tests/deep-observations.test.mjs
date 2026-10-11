import test from 'node:test';
import assert from 'node:assert/strict';
import {changedJobObservation,jobsAtObservation,deepDeliveryRound,immediateContextProbe} from '../lib/deep-observations.mjs';
import {replayContextCheckpoint} from '../lib/deep-replay-context.mjs';
import {streamedWordLatency} from '../lib/streamed-word-latency.mjs';

test('delta observations preserve old public code and later answer revisions without repeated copies',()=>{
 const fingerprints=new Map(),job=(id,answer)=>({question:{id,text:'Implement it',detectedAt:5},confirmed:true,answer,
  selectedContext:'Public only',phase:'complete',latency:{responseRevision:0}});
 const first=changedJobObservation({nativeNow:10,jobs:[job('a','exact code A')]},fingerprints,{hostBeforeMs:100,hostAfterMs:101});
 const second=changedJobObservation({nativeNow:11,jobs:[job('a','exact code A'),job('b','No. ')]},fingerprints,{hostBeforeMs:110,hostAfterMs:111});
 const third=changedJobObservation({nativeNow:12,jobs:[job('a','exact code A'),job('b','No. Updated')]},fingerprints,{hostBeforeMs:120,hostAfterMs:121});
 assert.equal(second.jobs.length,1);assert.equal(third.jobs.length,1);
 assert.equal(second.jobs[0].selectedContext,'Public only');
 assert.equal(Object.hasOwn(third.jobs[0],'selectedContext'),false);
 assert.equal(jobsAtObservation([first,second,third],2)[1].selectedContext,'Public only');
 assert.equal(first.jobs[0].answer,'exact code A');
 assert.deepEqual(jobsAtObservation([first,second,third],2).map(j=>j.answer),['exact code A','No. Updated']);
 const checkpoint=replayContextCheckpoint({deepObservations:[first,second,third]},
  {audio:{clockAnchors:[{hostBeforeMs:115,nativeMs:11}]}});
 assert(checkpoint.text.includes('exact code A'));assert(!checkpoint.text.includes('Updated'));
 const measured=streamedWordLatency({deepObservations:[first,second,third],overlayPaintSamples:[]},
  {audio:{clockAnchors:[{nativeMs:0}]}});
 assert.equal(measured.questionId,'b');
});

test('hour-long delivery repeats follow-ups and pauses beyond the first twelve turns',()=>{
 assert.deepEqual([4,8,16,20,28,32].map(deepDeliveryRound),[4,8,4,8,4,8]);
 assert.equal(deepDeliveryRound(25),1);
 assert.equal(immediateContextProbe(2),'Why?');
 assert.equal(immediateContextProbe(14),'Why?');
 assert.equal(immediateContextProbe(4),null);
});
