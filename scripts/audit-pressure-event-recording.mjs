// Offline audit of a read-only event sidecar. Never assigns semantic accuracy.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const directory=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&directory.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));
const journalBytes=await readFile(path.join(directory,'interview.json'));
const journal=JSON.parse(journalBytes),pressure=journal.continuousPressure;
assert(pressure&&['complete','failed'].includes(journal.status),'Require terminal pressure journal');
const bytes=await readFile(path.join(directory,'native-events-observer.jsonl'));
const observer=JSON.parse(await readFile(path.join(directory,'native-events-observer-report.json')));
const sha256=data=>createHash('sha256').update(data).digest('hex');
assert.equal(sha256(bytes),observer.eventsFileSha256);
const records=bytes.toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
const events=records.flatMap(record=>Array.isArray(record.events)?record.events:[]);
for(let i=1;i<events.length;i++)assert(events[i].eventIndex>events[i-1].eventIndex,'Duplicate or reordered retained event');
assert.equal(events.length,observer.events);
const anchors=pressure.clockAnchors??[];
const offsetLow=Math.max(...anchors.map(a=>a.nativeMs-a.hostAfterMs));
const offsetHigh=Math.min(...anchors.map(a=>a.nativeMs-a.hostBeforeMs));
const clocksValid=anchors.length>=2&&Number.isFinite(offsetLow)&&Number.isFinite(offsetHigh)&&offsetLow<=offsetHigh;
const nativeToHost=value=>clocksValid&&Number.isFinite(value)?{low:value-offsetHigh,high:value-offsetLow}:null;
const markers=pressure.playback?.frameMarkers??[];
const sourceEndpoints=pressure.segments.map((segment,index)=>{
 const marker=markers[index];
 if(marker)assert.equal(marker.frame,segment.lastVoicedFrame,'Marker does not match source endpoint');
 return {...segment,physicalEndpointHostMs:marker?{low:marker.lowerHostMs,high:marker.upperHostMs}:null};
});
const finalTranscripts=events.filter(e=>e.name==='transcript'&&e.payload?.final&&e.payload.source==='remote').map(e=>({
 eventIndex:e.eventIndex,...e.payload,startedHostMs:nativeToHost(e.payload.startedAt),endedHostMs:nativeToHost(e.payload.endedAt)
}));
const rawFinalBoundaries=events.filter(e=>e.name==='asr.raw_boundary'&&e.payload?.final&&e.payload.source==='remote').map(e=>({
 eventIndex:e.eventIndex,...e.payload,startedHostMs:nativeToHost(e.payload.startedAt),endedHostMs:nativeToHost(e.payload.endedAt),observedHostMs:nativeToHost(e.payload.observedAt)
}));
const eventCounts={};for(const event of events)eventCounts[event.name]=(eventCounts[event.name]??0)+1;
const lastEndpoint=sourceEndpoints.at(-1)?.physicalEndpointHostMs;
const latestFinal=finalTranscripts.at(-1);
const report={recordedAt:new Date().toISOString(),journalSha256:sha256(journalBytes),eventsSha256:sha256(bytes),
 model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,status:journal.status,stoppedCleanly:journal.stoppedCleanly,
 observer,clocksValid,clockOffsetMs:clocksValid?{low:offsetLow,high:offsetHigh}:null,eventCounts,
 instrumentation:{observerStartedAfterPlaybackMs:Date.parse(observer.startedAt)-pressure.playback?.submitBeforeHostMs,
  initialReadBackfilledRetainedEvents:true,
  scope:'The additional observer began during playback and read previously retained events. Its CPU/memory and CDP polling are extra instrumentation; native process-tree and main recorder measurements exclude this separate observer. Timing drift across its start is not an isolated model or app effect.'},
 coverage:{retainedEvents:events.length,initialReadStartsAtNativeEventIndex:records.find(r=>r.kind==='events')?.fromIndex,
  firstFinalTranscript:finalTranscripts[0],lastFinalTranscript:latestFinal,lastSourceEndpointHostMs:lastEndpoint,
  lastSuccessfulReadAfterLastSourceEndpointMs:lastEndpoint?observer.lastSuccessfulHostMs-lastEndpoint.high:null,
  lastFinalBoundaryRelativeToLastSourceEndpointMs:lastEndpoint&&latestFinal?.endedHostMs?{
   low:latestFinal.endedHostMs.low-lastEndpoint.high,high:latestFinal.endedHostMs.high-lastEndpoint.low}:null},
 sourceEndpoints,finalTranscripts,rawFinalBoundaries,
 lifecycleEvents:events.filter(e=>e.name.startsWith('question.')||e.name.startsWith('answer.')||e.name==='meeting.started'||e.name==='meeting.stopped'),
 semanticSourceAssignmentPending:true,independentAccuracyPending:true,
 scope:'Exact recorded source endpoints and retained final ASR/lifecycle events, calibrated to host time when both clock anchors overlap. ASR may merge or split utterances. Event counts and lexical similarity do not establish clause preservation, answer correctness or complete tail capture. Partial ASR and provisional answer prefixes were excluded by the observer. No product behavior changed.'};
await writeFile(path.join(directory,'pressure-events-audit.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({...report,sourceEndpoints:undefined,finalTranscripts:undefined,rawFinalBoundaries:undefined,lifecycleEvents:undefined}));
