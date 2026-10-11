import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
const directory='artifacts/deep-interview-v70/continuous-pressure-t';
const bytes=await readFile(`${directory}/interview.json`),journal=JSON.parse(bytes),pressure=journal.continuousPressure;
const latency=JSON.parse(await readFile(`${directory}/pressure-audit.json`));
const events=JSON.parse(await readFile(`${directory}/pressure-events-audit.json`));
const sha256=createHash('sha256').update(bytes).digest('hex');assert.equal(latency.journalSha256,sha256);assert.equal(events.journalSha256,sha256);
const middleHostMs=(pressure.playback.submitBeforeHostMs+pressure.playback.completedHostMs)/2;
const offset=(events.clockOffsetMs.low+events.clockOffsetMs.high)/2;
const midNativeMs=middleHostMs+offset;
const summarize=rows=>({nativeJobs:rows.length,observedVisibleWords:rows.filter(r=>r.firstVisibleWord).length,
 missingVisibleWords:rows.filter(r=>!r.firstVisibleWord).length,cancelled:rows.filter(r=>r.cancelled).length,
 phases:Object.fromEntries([...new Set(rows.map(r=>r.phase))].map(phase=>[phase,rows.filter(r=>r.phase===phase).length])),
 nativeEndpointToFirstVisibleWordMs:latencyDistribution(rows.map(r=>r.firstVisibleWord?.latencyMs.high)),
 completeJobsNativeEndpointToFirstVisibleWordMs:latencyDistribution(rows.filter(r=>r.phase==='complete').map(r=>r.firstVisibleWord?.latencyMs.high))});
const first=latency.rows.filter(row=>row.nativeSpeechEndMs<midNativeMs),second=latency.rows.filter(row=>row.nativeSpeechEndMs>=midNativeMs);
const resource=(rows,fields)=>Object.fromEntries(fields.map(field=>[field,{
 first:rows.find(r=>Number.isFinite(r[field]))?.[field],last:rows.findLast(r=>Number.isFinite(r[field]))?.[field],
 ...latencyDistribution(rows.map(r=>r[field]))} ]));
const record={recordedAt:new Date().toISOString(),journalSha256:sha256,model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 middleHostMs,midNativeMs,firstHalf:summarize(first),secondHalf:summarize(second),
 sourceKinds:Object.fromEntries([...new Set(pressure.segments.map(s=>s.kind))].map(kind=>[kind,pressure.segments.filter(s=>s.kind===kind).length])),
 resources:{native:resource(journal.nativeResources,['workingSetBytes','privateBytes','handles','threads']),
  recorder:resource(journal.recorderResources,['rss','heapUsed','pollMs']),
  childTree:resource(journal.nativeResources.map(r=>r.nativeTree).filter(Boolean),['nativeTreePrivateBytes','nativeTreeSumWorkingSetBytes']),
  instrumentationChange:events.instrumentation},
 scope:'Descriptive temporal halves using native job speech-end times calibrated to the physical playback midpoint. Jobs may combine source utterances; missing/cancelled jobs stay in each denominator. Complete-job statistics are explicitly conditional. Source repeats and partial cycles give dependent and unequal workload samples. The event observer started during playback; its additional load prevents an isolated causal drift claim. Startup/warm-up memory growth is not a leak proof. Working-set sums may double count shared pages; GPU and sibling process allocations are excluded. No predeclared significant-degradation threshold or population certification is inferred.'};
await writeFile(`${directory}/pressure-drift-audit.json`,JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify(record));
