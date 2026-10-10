import test from 'node:test';
import assert from 'node:assert/strict';
import {describeRapidJobs,describeRapidAttribution} from './rapid-interview.mjs';
import {composeBurst,pcmWave,pcmData} from './rapid-wave.mjs';

test('source attribution preserves operators and refuses merged questions',()=>{
 const question='Can x < y overflow?',latency={speechStoppedAt:100,firstWordAt:140,pipeline:{latestInputSent:120}};
 const job={question:{id:'exact',text:question},latency,confirmed:true,cancelled:false,answer:'A',phase:'complete'};
 const other={...job,question:{id:'changed',text:'Can x > y overflow?'}};
 const merged={...job,question:{id:'merged',text:question+' Explain the type.'}};
 const rows=describeRapidJobs([other,merged,job],['Can x   < y overflow?','Can x <= y overflow?']);
 assert.equal(rows[0].id,'exact');assert.equal(rows[0].firstWordFromNativeSpeechEndMs,40);assert.equal(rows[0].firstWordFromLatestInputMs,20);
 assert.equal(rows[1].matched,false);assert.equal(rows[1].outcome,'no_exact_question_job_observed');
});
test('cancelled partial answers are recorded without labeling them completed or accurate',()=>{
 const row=describeRapidJobs([{question:{id:'lost',text:'Derive the bound'},latency:{speechStoppedAt:10,firstWordAt:null},cancelled:true,confirmed:true,answer:'Partial',phase:'cancelled'}],['Derive the bound'])[0];
 assert.equal(row.outcome,'cancelled');assert.equal(row.firstWordFromNativeSpeechEndMs,null);assert.equal(row.answer,'Partial');
});
test('exact composite retention does not invent individual response timing or normalize operators',()=>{
 const questions=['Assume x < y.','Prove the bound.','What about overflow?'];
 const job={question:{id:'shared',text:questions.join(' ')},latency:{speechStoppedAt:100,firstWordAt:240,completedAt:300,pipeline:{latestInputSent:130}},confirmed:true,cancelled:false,answer:'Combined response',phase:'complete'};
 const {sourceOutcomes,mergedJobs}=describeRapidAttribution([job],questions);
 assert.equal(mergedJobs.length,1);assert.equal(mergedJobs[0].firstWordFromNativeSpeechEndMs,140);
 assert.deepEqual(mergedJobs[0].sourcePositions,[1,2,3]);
 assert(sourceOutcomes.every(row=>!row.matched&&row.answer===''&&row.firstWordFromNativeSpeechEndMs===null&&row.sharedMergedJobIds[0]==='shared'));
 const changed=describeRapidAttribution([job],['Assume x > y.',...questions.slice(1)]);
 assert.equal(changed.mergedJobs.length,0);assert.equal(changed.sourceOutcomes[0].outcome,'no_exact_question_job_observed');
 const subset=describeRapidAttribution([{...job,question:{id:'pair',text:questions.slice(1).join(' ')}}],questions);
 assert.deepEqual(subset.mergedJobs[0].sourcePositions,[2,3]);assert.equal(subset.sourceOutcomes[0].sharedMergedJobIds,undefined);
});
test('continuous audio preserves PCM and sample boundaries across configured gaps',()=>{
 const a=Buffer.from([1,0,2,0]),b=Buffer.from([3,0,4,0,5,0]);
 const result=composeBurst([pcmWave(a),pcmWave(b)],250);
 const pcm=pcmData(result.wave);
 assert.deepEqual(pcm.subarray(0,4),a);assert(pcm.subarray(4,8004).every(byte=>byte===0));assert.deepEqual(pcm.subarray(8004),b);
 assert.deepEqual(result.timeline.map(row=>[row.startSample,row.endSample]),[[0,2],[4002,4005]]);
 const bad=pcmWave(a);bad.writeUInt32LE(44100,24);assert.throws(()=>composeBurst([bad],0),/16 kHz/);
});
