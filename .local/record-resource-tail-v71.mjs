import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const directory='artifacts/deep-interview-v71/general-hour-t',excerptFile=directory+'/native-resource-excerpt.json',auditFile=directory+'/duration-audit.json',checkpointFile='docs/evidence/architecture-r34-checkpoint-v71.json';
const files=[];for(const file of [excerptFile,auditFile,checkpointFile]){const raw=await readFile(file);files.push({file,sha256:hash(raw),value:JSON.parse(raw)});}
const [excerpt,audit,checkpoint]=files.map(f=>f.value);assert(audit.status==='complete'&&audit.stoppedCleanly&&audit.durationVerified);
assert.equal(excerpt.value.length,audit.summary.nativeProcessResources.privateBytes.count);
const word=checkpoint.firstStreamedWordMeasurement.firstVisibleStreamedWord;
const low=word.observedHostMs-word.latencyMs.high,high=word.observedHostMs;
const samples=excerpt.value.filter(s=>s.hostMs>=low&&s.hostMs<=high);
const processes=new Map();for(const sample of samples)for(const row of sample.nativeTree?.rows??[]){const key=row.processId;const record=processes.get(key)??{processId:key,name:row.name,samples:[]};record.samples.push({hostMs:sample.hostMs,...row});processes.set(key,record);}
const changes=[...processes.values()].map(({samples,...process})=>{
 const first=samples[0],last=samples.at(-1),seconds=(last.hostMs-first.hostMs)/1000;
 const cpuSeconds=seconds>0?last.cpuSeconds-first.cpuSeconds:null;
 return {...process,samples:samples.length,firstHostMs:first.hostMs,lastHostMs:last.hostMs,windowSeconds:seconds,
  observedProcessorSeconds:cpuSeconds,processorSecondsPerWallSecond:seconds>0&&cpuSeconds>=0?cpuSeconds/seconds:null,
  firstPrivateBytes:first.privateBytes,lastPrivateBytes:last.privateBytes,maximumPrivateBytes:Math.max(...samples.map(s=>s.privateBytes)),
  firstWorkingSetBytes:first.workingSetBytes,lastWorkingSetBytes:last.workingSetBytes};
});
const report={recordedAt:new Date().toISOString(),evidence:files.map(({file,sha256})=>({file,sha256})),
 journal:{file:directory+'/interview.json',sha256:audit.journalSha256,status:audit.status,stoppedCleanly:audit.stoppedCleanly},
 round:checkpoint.round,responseVersion:checkpoint.responseVersion,visibleWordLatencyMs:word.latencyMs,
 resourceHostWindow:{low,high,scope:'From physical synthetic endpoint lower host bound to first visibly painted complete word in the preserved row snapshot.'},
 nativeResourceSamplesInsideWindow:samples.length,processes:changes,
 finalNativeTreeSnapshot:excerpt.value.at(-1).nativeTree,
 scope:'Descriptive process-wide counters in sparse samples wholly inside the tail interval. CPU deltas cover only first-to-last observed samples, not the entire latency interval. Processor seconds include all threads and do not isolate the parser or any request; one second per wall second means one logical core occupied. Processes absent or exiting between snapshots are unobserved; PID lifetime identity is not captured in these resource rows. Private bytes are not resident working-set bytes or a GPU allocation metric. Native descendants exclude recorder/examiner/playback siblings and pre-existing system services. These measurements do not identify a causal tail mechanism or establish absence of transient resource contention.',
 independentAccuracyPending:true,goalComplete:false};
const output='docs/evidence/general-resource-tail-v71.json';await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,windowSamples:samples.length,processes:changes.map(p=>({name:p.name,processId:p.processId,observedProcessorSeconds:p.observedProcessorSeconds,windowSeconds:p.windowSeconds,maximumPrivateBytes:p.maximumPrivateBytes}))}));
