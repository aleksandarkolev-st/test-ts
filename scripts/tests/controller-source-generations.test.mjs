import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {playbackNativeBounds,sourceGenerationAudit} from '../lib/controller-source-generations.mjs';

const row={nativeStartedAt:0,responseVersion:'opening:0',audio:{
 playback:{submitBeforeHostMs:1000,submitAfterHostMs:1000,completedHostMs:1100},
 clockAnchors:[{hostBeforeMs:990,hostAfterMs:992,nativeMs:0}]}};
const job=(id,floor,accepted,phase='complete')=>({question:{id,text:id,detectedAt:accepted-1},
 confirmed:phase==='complete',cancelled:phase==='superseded',phase,
 latency:{remoteSpeechStartedAt:floor,questionConfirmedAt:accepted,completedAt:phase==='complete'?accepted+1:null}});

test('full request interrupted by later ignored input is retained instead of a completed opening',()=>{
 const audit=sourceGenerationAudit(row,[job('opening',20,25),job('full',40,120,'superseded'),
  job('ignored',140,150,'cancelled')],200);
 assert.equal(audit.targetGenerationId,'full');
 assert.equal(audit.selectionChanged,true);
 assert.deepEqual(audit.generations.map(g=>g.association),['within_playback','within_playback','outside_playback']);
 assert.equal(audit.generations[1].phase,'superseded');
});

test('failed final request wins over successful earlier request; answer text has no role',()=>{
 const jobs=[job('opening',20,25),{...job('full',40,120),error:'provider unavailable'}];
 assert.equal(sourceGenerationAudit(row,jobs,200).targetGenerationId,'full');
 assert.equal(sourceGenerationAudit(row,jobs.map(j=>({...j,question:{...j.question,text:'unrelated arbitrary text'},answer:''})),200).targetGenerationId,'full');
});

test('missing clock/floor and source-boundary uncertainty remain unknown',()=>{
 assert.equal(playbackNativeBounds({...row,audio:{}}),null);
 assert.equal(sourceGenerationAudit(row,[job('opening',null,25)],200).targetGenerationId,null);
 const audit=sourceGenerationAudit(row,[job('opening',20,25),job('boundary',109,120)],200);
 assert.equal(audit.targetGenerationId,null);assert.equal(audit.ambiguous,true);
 assert.equal(audit.generations[1].association,'boundary_uncertain');
});

test('clock drift expands the envelope and next input horizon excludes later turns',()=>{
 const drifting={...row,audio:{...row.audio,clockAnchors:[...row.audio.clockAnchors,
  {hostBeforeMs:1100,hostAfterMs:1104,nativeMs:120}]}};
 assert.deepEqual(playbackNativeBounds(drifting).end,{low:108,high:120});
 const audit=sourceGenerationAudit(row,[job('opening',20,25),job('next',40,220)],200);
 assert.equal(audit.targetGenerationId,'opening');assert.equal(audit.generations.length,1);
});

test('observed multipart waveform regression preserves all three outcomes without a topic rule',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../fixtures/controller-multipart-focus-v72.json',import.meta.url)));
 const audit=sourceGenerationAudit(fixture.row,fixture.jobs,fixture.nextNativeStartedAt);
 assert.equal(audit.targetGenerationId,fixture.fullRequestGenerationId);
 assert.equal(audit.originalGenerationId,fixture.openingGenerationId);
 assert.equal(audit.generations.length,3);
 assert.equal(audit.generations.at(-1).association,'outside_playback');
 assert(fixture.fullRequestCancellationObservedAt<fixture.ignoredEvent.payload.timestamp);
 const ignored=fixture.jobs.find(j=>j.question.id===fixture.ignoredEvent.payload.id);
 assert.equal(ignored.phase,'cancelled');
 assert.equal(ignored.latency.completedAt,fixture.ignoredEvent.payload.timestamp);
});
