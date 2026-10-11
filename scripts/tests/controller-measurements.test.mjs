import test from 'node:test';
import assert from 'node:assert/strict';
import {measureJournal,usefulPaint,wordError,auditPanelTransitions,allRowP95} from '../lib/controller-measurements.mjs';
test('Useful feedback excludes stale generations, invisible clauses and ungraded openings',()=>{
 const row={responseVersion:'new:0',audio:{playback:{lastVoicedDevicePositionLowerHostMs:100,lastVoicedDevicePositionUpperHostMs:110}},latency:{responseRevision:0}};
 const base={recorderVersion:2,visible:true,revision:0,text:'No. Every named lane must execute the matching collective.',visibleStart:0,visibleEnd:58};
 const journal={overlayPaintSamples:[{...base,questionId:'old',hostMs:120},{...base,questionId:'new',hostMs:130,visibleEnd:3},{...base,questionId:'new',hostMs:150}]};
 const review={correctness:'correct',usefulPrefix:'Every named lane must execute the matching collective.'};
 assert.deepEqual(usefulPaint(journal,row,review),{hostMs:150,low:40,high:50,origin:'actual synthetic speech end'});
 assert.equal(usefulPaint(journal,row,{...review,correctness:'incorrect'}),null);
 assert.equal(usefulPaint(journal,row,{}),null);
});
test('Missing and interrupted answers stay in denominator; missing wire timing is unknown',()=>{
 const j={rows:[{round:1,phase:'no_job',answer:''},{round:2,phase:'cancelled',answer:'Opening',settle:false},{round:3,phase:'complete',answer:'Answer',latency:{questionConfirmedAt:5,pipeline:{modelRequestSent:7}}}]};
 const m=measureJournal(j,{});assert.equal(m.counts.all,3);assert.equal(m.counts.missing,1);assert.equal(m.counts.complete,1);assert.equal(m.counts.intentionallyInterrupted,1);assert.equal(m.acceptedToWriteMs.count,0);
});
test('provider completion does not certify completion of the requested work',()=>{
 const measured=measureJournal({rows:[{round:1,phase:'complete',answer:'One omitted constraint'}]},
  {rows:[{round:1,completed:false,correctness:'incorrect',reasoningVerdict:'fail'}]});
 assert.equal(measured.counts.complete,1);
 assert.equal(measured.counts.requestedWorkComplete,0);
 assert.equal(measured.counts.requestedWorkIncomplete,1);
 assert.equal(measured.counts.incorrect,1);
});
test('a planned audio interruption that never becomes a request is not a successful interruption',()=>{
 const measured=measureJournal({rows:[{round:1,phase:'complete',answer:'Finished original code',settle:false},{round:2,phase:'no_job',answer:''}]},{});
 assert.equal(measured.counts.intentionallyInterrupted,1);
 assert.equal(measured.counts.observedPlannedInterruptions,0);
 assert.equal(measured.counts.missing,1);
});
test('injected cold recovery and incomplete work are not healthy dispatch or correct completion samples',()=>{
 const rows=[{round:1,phase:'complete',answer:'Correct',latency:{questionConfirmedAt:10,completedAt:30,pipeline:{transportWrittenAt:12}}},
  {round:2,phase:'complete',answer:'Omitted constraints',faultInjection:{injected:true},latency:{questionConfirmedAt:40,completedAt:3000,pipeline:{transportWrittenAt:2140}}}];
 const measured=measureJournal({rows},{rows:[{round:1,completed:true,correctness:'correct'},{round:2,completed:false,correctness:'incorrect'}]});
 assert.equal(measured.acceptedToWriteMs.count,2);
 assert.equal(measured.nonFaultProbeAcceptedToWriteMs.sampleP95,2);
 assert.equal(measured.faultProbeAcceptedToWriteMs.sampleP95,2100);
 assert.equal(measured.acceptedToProtocolCompletionMs.count,2);
 assert.equal(measured.acceptedToCorrectWorkCompletionMs.count,1);
 assert.equal(measured.acceptedToCorrectWorkCompletionMs.sampleP95,20);
});
test('a requested but unsupported fault is separated without claiming it was injected',()=>{
 const measured=measureJournal({rows:[{round:1,disconnectBackend:true,faultInjection:{injected:false},phase:'complete',answer:'Reply',latency:{questionConfirmedAt:1,pipeline:{transportWrittenAt:5}}}]},{});
 assert.equal(measured.rows[0].injectedTransportFault,false);
 assert.equal(measured.nonFaultProbeAcceptedToWriteMs.count,0);
 assert.equal(measured.faultProbeAcceptedToWriteMs.count,1);
});
test('generation mismatch is rejected instead of combining timing',()=>{
 assert.throws(()=>measureJournal({rows:[{round:1,responseVersion:'a:0',latency:{pipeline:{generationId:'b'}}}]},{}));
});
test('ASR numerical and identifier errors remain visible',()=>{
 assert.equal(wordError('Mira owns Foo_17','Myra owns Foo_17').distance,1);
 assert.equal(wordError('Why?',null),null);
});
test('retained prior panel time is reported separately from stale appended output',()=>{
 const journal={deepObservations:[{format:'changed_jobs',nativeNow:10,hostBeforeMs:109,hostAfterMs:111,jobs:[{confirmed:true,question:{id:'new'},latency:{questionConfirmedAt:10}}]}],
  overlayPaintSamples:[{hostMs:100,questionId:'old',visible:true,text:'Old answer'},{hostMs:140,questionId:'new',visible:false,text:''}]};
 const audit=auditPanelTransitions(journal);assert.equal(audit.transitions.length,1);assert.deepEqual(audit.transitions[0].possibleOldPanelDurationMs,{low:0,high:32});assert.equal(audit.oldPaintChangesAfterAcceptance,0);
});
test('missing useful answers can make all-row p95 unverified',()=>{
 assert.equal(allRowP95([1,2,3,null]).gateEvaluable,false);
 assert.equal(allRowP95([1,2,3,null]).p95,null);
 assert.equal(allRowP95(Array.from({length:20},(_,i)=>i===19?null:i)).p95,18);
});
