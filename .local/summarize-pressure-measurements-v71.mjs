// Summarize recorded diagnostics without changing transcripts or app behavior.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [directory,output]=process.argv.slice(2);
assert(directory&&output,'RECORDING_DIRECTORY OUTPUT');
const evidence=new Map();
async function fileHash(file){
 const resolved=path.resolve(file);if(evidence.has(resolved))return evidence.get(resolved).sha256;
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 const sha256=hash.digest('hex');evidence.set(resolved,{file,sha256});return sha256;
}
async function load(name){const file=path.join(directory,name);await fileHash(file);return JSON.parse(await readFile(file));}
const journalSha256=await fileHash(path.join(directory,'interview.json'));
const [duration,events,native,physical,coverage,drift,visibility]=await Promise.all([
 load('duration-audit.json'),load('pressure-events-audit.json'),load('pressure-audit.json'),
 load('pressure-physical-latency-audit.json'),load('pressure-source-coverage-audit.json'),
 load('pressure-drift-audit.json'),load('pressure-visibility-audit.json')]);
for(const report of [duration,events,native,drift,visibility])assert.equal(report.journalSha256,journalSha256);
for(const report of [physical,coverage]){
 for(const binding of report.evidence)assert.equal(await fileHash(binding.file),binding.sha256);
 assert(report.evidence.some(binding=>path.resolve(binding.file)===path.resolve(directory,'interview.json')&&binding.sha256===journalSha256));
}
assert(duration.durationVerified&&events.stoppedCleanly&&events.clocksValid);
for(const report of [native,physical,coverage,drift,visibility]){
 assert.equal(report.model,events.model);assert.equal(report.effort,events.effort);assert.equal(report.outputDevice??report.output,events.outputDevice);
}
const observerOffset=events.instrumentation.observerStartedAfterPlaybackMs;assert(Number.isFinite(observerOffset));
const report={recordedAt:new Date().toISOString(),journalSha256,model:events.model,effort:events.effort,outputDevice:events.outputDevice,
 duration:{requestedDurationMs:duration.requestedDurationMs,actualInterviewDurationMs:duration.actualInterviewDurationMs,
  durationVerified:duration.durationVerified,stoppedCleanly:duration.stoppedCleanly,speechConfiguration:duration.speechConfiguration},
 nativeEndpointMeasurements:native.summary,physicalSourcePairMeasurements:physical.summary,
 sourceCoverage:coverage.summary,visibility:visibility.summary,
 temporalHalves:{first:drift.firstHalf,second:drift.secondHalf},resources:{...drift.resources,instrumentationChange:undefined},
 instrumentation:{observerStartedAfterPlaybackMs:observerOffset,
  observerStartRelation:observerOffset<0?'before_playback':observerOffset>0?'after_playback':'at_playback',
  initialReadBackfilledRetainedEvents:events.instrumentation.initialReadBackfilledRetainedEvents,
  correction:'The original event and drift audit prose says the observer began during playback. The saved numeric offset determines its actual relation above. Original files remain unchanged; this derived report corrects the prose rather than changing any timing.'},
 evidence:[...evidence.values()],independentAccuracyPending:true,semanticClauseAssessmentPending:true,goalComplete:false,
 scope:'Completed playback-only recording. Native-job endpoint and original-source endpoint distributions remain separate. Physical source/native-job pairs are dependent and may be split or merged; missing and background sources remain explicit. Lexical retention is not semantic answer coverage or correctness. Prior-question visibility intervals require semantic interpretation and may overlap. Temporal halves have unequal outcomes and dependent repeated workloads; no significance threshold, memory-leak conclusion or population p95 is invented.'};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,sourceUtterances:physical.summary.sourceUtterances,
 physicalPairSampleP95Ms:physical.summary.sourceEndpointToRetainedVisibleWordMs.sampleP95,
 sourcesWithoutRetainedWords:physical.summary.sourcesWithoutAnyRetainedVisibleWord,observerStartRelation:report.instrumentation.observerStartRelation}));
