import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
const [journalFile,output]=process.argv.slice(2);assert(journalFile&&output);
const hash=value=>createHash('sha256').update(value).digest('hex');
const bytes=await readFile(journalFile),journal=JSON.parse(bytes);assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
const samples=journal.nativeResources.filter(sample=>sample.nativeTree?.rows?.length);assert(samples.length);
const groups=new Map();
for(const sample of samples){
 const tree=sample.nativeTree,ids=new Set();
 for(const row of tree.rows){
  assert(!ids.has(row.processId),'Duplicate process in a tree snapshot');ids.add(row.processId);
  const key=JSON.stringify([row.processId,row.parentProcessId,row.name]),group=groups.get(key)??{processId:row.processId,parentProcessId:row.parentProcessId,name:row.name,samples:[]};
  group.samples.push({hostBeforeMs:tree.hostBeforeMs,hostAfterMs:tree.hostAfterMs,...row});groups.set(key,group);
 }
 for(const [total,field] of [['nativeTreePrivateBytes','privateBytes'],['nativeTreeSumWorkingSetBytes','workingSetBytes']])
  assert.equal(tree[total],tree.rows.reduce((sum,row)=>sum+(Number.isFinite(row[field])?row[field]:0),0),'Recorded process sum differs');
}
const playback=journal.continuousPressure?.playback;
const midpoint=playback?(playback.submitBeforeHostMs+playback.completedHostMs)/2:
 (samples[0].nativeTree.hostBeforeMs+samples.at(-1).nativeTree.hostAfterMs)/2;
const metrics=['privateBytes','workingSetBytes','cpuSeconds','handles','threads'];
const summarize=rows=>Object.fromEntries(metrics.map(field=>{
 const values=rows.map(row=>row[field]).filter(Number.isFinite);
 return [field,{first:values[0]??null,last:values.at(-1)??null,...latencyDistribution(values)}];
}));
const processes=[...groups.values()].map(group=>({processId:group.processId,parentProcessId:group.parentProcessId,name:group.name,
 observedSamples:group.samples.length,firstHostBeforeMs:group.samples[0].hostBeforeMs,lastHostAfterMs:group.samples.at(-1).hostAfterMs,
 metrics:summarize(group.samples),firstTemporalHalf:summarize(group.samples.filter(sample=>sample.hostBeforeMs<midpoint)),
 secondTemporalHalf:summarize(group.samples.filter(sample=>sample.hostBeforeMs>=midpoint))}));
const final=samples.at(-1).nativeTree,totalPrivate=final.nativeTreePrivateBytes;
const finalAttribution=final.rows.map(row=>({...row,fractionOfRecordedTreePrivateBytes:totalPrivate?row.privateBytes/totalPrivate:null}))
 .sort((a,b)=>b.privateBytes-a.privateBytes);
const collector=fileURLToPath(import.meta.url),report={recordedAt:new Date().toISOString(),
 journal:{file:journalFile,sha256:hash(bytes)},collector:{file:collector,sha256:hash(await readFile(collector))},
 treeSamples:samples.length,temporalMidpointHostMs:midpoint,temporalMidpointBasis:playback?'physical_playback_midpoint':'recorded_resource_interval_midpoint',
 processes,finalSnapshot:{hostBeforeMs:final.hostBeforeMs,hostAfterMs:final.hostAfterMs,nativeTreePrivateBytes:totalPrivate,
  nativeTreeSumWorkingSetBytes:final.nativeTreeSumWorkingSetBytes,processes:finalAttribution},
 scope:'Recorded native app descendants grouped by PID, parent PID and name; process creation identities were not sampled, so PID reuse is not independently excluded. Every aggregate sum is checked against its recorded process rows. Private committed bytes and resident working set are distinct. Shared working-set pages may be counted more than once; GPU, sibling recorder/examiner/playback and pre-existing non-child services are excluded. Temporal halves retain startup and unequal samples; no invented warm-up cutoff, leak diagnosis, significance threshold or causal latency attribution.'};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,treeSamples:samples.length,finalAttribution:finalAttribution.map(row=>({name:row.name,processId:row.processId,privateBytes:row.privateBytes,workingSetBytes:row.workingSetBytes,fraction:row.fractionOfRecordedTreePrivateBytes}))}));
