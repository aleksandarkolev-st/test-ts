import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {streamedWordLatency,latencyDistribution} from './lib/streamed-word-latency.mjs';
const directory=process.argv[2];assert(directory,'RECORDING_DIRECTORY');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function load(name){const file=path.join(directory,name),bytes=await readFile(file);return {file,sha256:hash(bytes),value:JSON.parse(bytes)};}
const recording=await load('interview.json'),coverage=await load('pressure-source-coverage-audit.json'),projection=await load('pressure-review-input.json');
const journal=recording.value,pressure=journal.continuousPressure;
assert(journal.status==='complete'&&journal.stoppedCleanly&&pressure);
assert.equal(projection.value.derivedFrom.journalSha256,recording.sha256);
assert(coverage.value.evidence.some(item=>path.resolve(item.file)===path.resolve(recording.file)&&item.sha256===recording.sha256));
assert(coverage.value.evidence.some(item=>path.resolve(item.file)===path.resolve(projection.file)&&item.sha256===projection.sha256));
assert.equal(pressure.playback.frameMarkers.length,pressure.segments.length);
assert.equal(coverage.value.rows.length,pressure.segments.length);
const markers=new Map(pressure.playback.frameMarkers.map(marker=>[marker.frame,marker])),jobs=new Map(pressure.nativeJobs.map(job=>[job.question.id,job]));
assert.equal(markers.size,pressure.segments.length,'Source endpoint markers must be unique');
const rows=pressure.segments.map(segment=>{
 const endpoint=markers.get(segment.lastVoicedFrame);assert(endpoint);
 assert(Number.isFinite(endpoint.lowerHostMs)&&Number.isFinite(endpoint.upperHostMs)&&endpoint.lowerHostMs<=endpoint.upperHostMs);
 const source=coverage.value.rows.find(row=>row.sequence===segment.sequence);assert(source);
 assert.equal(source.sourceText,segment.text);
 const pairs=source.nativeJobs.map(mapped=>{
  const job=jobs.get(mapped.id);assert(job,'Mapped native job absent from recorded pressure session');
  const responseVersion=job.question.id+':'+(job.latency?.responseRevision??0);
  const measurement=streamedWordLatency(journal,{responseVersion,answer:job.answer,latency:job.latency,phase:job.phase,error:job.error,
   audio:{clockAnchors:pressure.clockAnchors,playback:{lastVoicedDevicePositionLowerHostMs:endpoint.lowerHostMs,lastVoicedDevicePositionUpperHostMs:endpoint.upperHostMs}}});
  return {nativeQuestionId:job.question.id,responseVersion,recognizedQuestion:job.question.text,phase:job.phase,cancelled:job.cancelled??false,error:job.error??null,
   sourceFragments:mapped.sourceFragments,entireSourceUtteranceRepresented:mapped.sourceFragments.some(fragment=>fragment.completeSourceUtterance),
   firstVisibleWord:measurement.firstVisibleStreamedWord,firstRetainedVisibleWord:measurement.firstRetainedVisibleStreamedWord,missingReason:measurement.missingReason};
 });
 return {sequence:segment.sequence,clipId:segment.clipId,kind:segment.kind,sourceText:segment.text,sourceTextSha256:hash(segment.text),
  endpoint:{frame:endpoint.frame,lowerHostMs:endpoint.lowerHostMs,upperHostMs:endpoint.upperHostMs},
  alignedSourceWords:source.sourceWords,alignedRecognizedWords:source.alignedRecognizedWords,pairs};
});
const pairs=rows.flatMap(row=>row.pairs);
const report={recordedAt:new Date().toISOString(),evidence:[recording,coverage,projection].map(({file,sha256})=>({file,sha256})),
 collectorSha256:hash(await readFile(new URL(import.meta.url))),model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,rows,
 summary:{sourceUtterances:rows.length,mappedSourceJobPairs:pairs.length,sourcesWithoutAnyMappedNativeJob:rows.filter(row=>!row.pairs.length).length,
  sourcesWithoutAnyRetainedVisibleWord:rows.filter(row=>!row.pairs.some(pair=>pair.firstRetainedVisibleWord)).length,
  pairsWithRetainedVisibleWord:pairs.filter(pair=>pair.firstRetainedVisibleWord).length,pairsMissingRetainedVisibleWord:pairs.filter(pair=>!pair.firstRetainedVisibleWord).length,
  pairsWithPartialSourceRepresentation:pairs.filter(pair=>!pair.entireSourceUtteranceRepresented).length,
  sourceEndpointToRetainedVisibleWordMs:latencyDistribution(pairs.map(pair=>pair.firstRetainedVisibleWord?.latencyMs.high)),
  sourceKinds:Object.fromEntries([...new Set(rows.map(row=>row.kind))].map(kind=>{const selected=rows.filter(row=>row.kind===kind),values=selected.flatMap(row=>row.pairs);return [kind,{sourceUtterances:selected.length,mappedPairs:values.length,
   missingRetainedWords:values.filter(pair=>!pair.firstRetainedVisibleWord).length,sourceEndpointToRetainedVisibleWordMs:latencyDistribution(values.map(pair=>pair.firstRetainedVisibleWord?.latencyMs.high))}];}))},
 scope:'Every played source utterance is retained. Each globally aligned source/native-job pair measures actual viewport-visible words against that source utterance\'s waveOut last-voiced-frame crossing interval. Merged or split utterances create dependent many-to-many pairs; these descriptive pair percentiles are not a one-response-per-question population p95 and must not be pooled with independent hour turns. Partial source representation is explicit: its full-utterance endpoint may occur after an early job output, producing valid negative timing without proving the final condition was answered. Lexical attribution does not certify semantic relevance or correctness. Missing and background sources remain explicit. The separate native-job speech-end metric is preserved.',
 semanticAccuracyCertified:false,goalComplete:false};
const output=path.join(directory,'pressure-physical-latency-audit.json');await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,summary:report.summary}));
