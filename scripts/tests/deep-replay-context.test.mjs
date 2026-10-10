import test from 'node:test';
import assert from 'node:assert/strict';
import {replayContextCheckpoint,publicContextCheckpoint} from '../lib/deep-replay-context.mjs';

test('paired replay excludes current-question fragments and late completions',()=>{
 const job={confirmed:true,cancelled:false,question:{id:'previous',detectedAt:1,text:'Public previous question'},
  selectedContext:'Public older facts.',answer:'Visible partial answer',latency:{responseRevision:2}};
 const before={hostAfterMs:90,nativeNow:90,jobs:[job]};
 const after={hostAfterMs:110,nativeNow:110,jobs:[{...job,answer:'A later completion unavailable at playback',
  selectedContext:'The new question fragment has now entered context'}]};
 const row={audio:{clockAnchors:[{hostBeforeMs:100,nativeMs:100}]},selectedContext:'Current question fragments must not be used'};
 const checkpoint=replayContextCheckpoint({deepObservations:[before,after]},row);
 assert(checkpoint.text.includes('Public older facts.'));
 assert(checkpoint.text.includes('Visible partial answer'));
 assert(!checkpoint.text.includes('later completion'));
 assert(!checkpoint.text.includes('new question'));
 assert(!checkpoint.text.includes('Current question fragments'));
 assert.equal(checkpoint.provenance.nativeMs,90);
 assert.throws(()=>replayContextCheckpoint({deepObservations:[after]},row),/before playback/);
});

test('an opening checkpoint contains only the public introduction',()=>{
 const checkpoint=publicContextCheckpoint({jobs:[]},{nativeMs:0,hostMs:0});
 assert(checkpoint.text.startsWith('REMOTE: This is a technical interview.'));
 assert.deepEqual(checkpoint.provenance.responseVersions,[]);
 const row={audio:{publicPriorContext:checkpoint},selectedContext:'Later state'};
 assert.equal(replayContextCheckpoint({},row),checkpoint);
});
