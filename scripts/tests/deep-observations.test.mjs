import test from 'node:test';
import assert from 'node:assert/strict';
import {changedJobObservation,jobsAtObservation,deepDeliveryRound,immediateContextProbe,shouldRetainDeepObservation} from '../lib/deep-observations.mjs';
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


test('numeric speech counters survive observations without answer changes',()=>{
 const fingerprints=new Map(),job={question:{id:'a'},answer:'same',selectedContext:'same'};
 const before={remote:{capturedSamples:2560,queuedBytes:5120,socketFlushedBytes:0,transcriptEvents:0,providerAudioFrontierMicros:null},self:{capturedSamples:0}};
 const after={remote:{...before.remote,socketFlushedBytes:5120},self:{capturedSamples:0}};
 const first=changedJobObservation({nativeNow:0,jobs:[job],speechTransport:before},fingerprints,{});
 const second=changedJobObservation({nativeNow:1,jobs:[job],speechTransport:after},fingerprints,{});
 assert.equal(second.jobs.length,0);assert.deepEqual(first.speechTransport,before);assert.deepEqual(second.speechTransport,after);
 assert.equal(first.speechTransport.remote.socketFlushedBytes,0);assert.equal(second.speechTransport.remote.transcriptEvents,0);
 assert.deepEqual(jobsAtObservation([first,second],1),[job]);
});
test('legacy and stopped observations leave speech counters absent rather than infer zeros',()=>{
 for(const state of [{nativeNow:0,jobs:[]},{nativeNow:0,jobs:[],speechTransport:null}]){
  assert.equal(Object.hasOwn(changedJobObservation(state,new Map(),{}),'speechTransport'),false);
 }
});

test('missing-request transport evidence gets a heartbeat without changed jobs',()=>{
 const previous={nativeNow:0,hostAfterMs:100000,jobs:[],speechTransport:{remote:{socketFlushedBytes:0}}};
 const middle={nativeNow:999,hostAfterMs:100999,jobs:[],speechTransport:{remote:{socketFlushedBytes:32000}}};
 const after={nativeNow:1000,hostAfterMs:101000,jobs:[],speechTransport:{remote:{socketFlushedBytes:32000}}};
 assert(shouldRetainDeepObservation(previous,null));assert(!shouldRetainDeepObservation(middle,previous));assert(shouldRetainDeepObservation(after,previous));
 assert.equal(after.jobs.length,0);assert.equal(after.speechTransport.remote.socketFlushedBytes,32000);
});
test('job updates are immediate while legacy no-job observations stay unchanged',()=>{
 assert(shouldRetainDeepObservation({jobs:[{question:{id:'a'}}],nativeNow:0},{nativeNow:0}));
 assert(!shouldRetainDeepObservation({jobs:[],nativeNow:100000},null));
});
test('native monotonic heartbeat is valid at zero and independent of host clock jumps',()=>{
 const record={jobs:[],speechTransport:{},nativeNow:1000,hostAfterMs:0},previous={nativeNow:0,hostAfterMs:100000};
 assert(shouldRetainDeepObservation(record,previous));
 assert(!shouldRetainDeepObservation({...record,nativeNow:100},previous));
 assert(shouldRetainDeepObservation({...record,nativeNow:null,hostAfterMs:101000},{...previous,nativeNow:null}));
});
