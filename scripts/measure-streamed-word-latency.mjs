import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {streamedWordLatency,latencyDistribution} from './lib/streamed-word-latency.mjs';

const args=process.argv.slice(2),outputIndex=args.indexOf('--output');
assert(outputIndex>=0&&args[outputIndex+1],'JOURNAL [JOURNAL ...] --output REPORT.json');
const output=path.resolve(args[outputIndex+1]),files=args.slice(0,outputIndex);
assert(files.length&&output.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep),'Require journals and workspace output');
const runs=[];
for(const file of files){
 const raw=await readFile(file),journal=JSON.parse(raw);
 const rows=journal.rows.map(row=>({round:row.round,trial:row.trial,policy:row.policy,
  ...streamedWordLatency(journal,row)}));
 runs.push({journal:file,journalSha256:createHash('sha256').update(raw).digest('hex'),status:journal.status,
  capture:journal.speechConfiguration,rows,
  firstVisibleWordMs:latencyDistribution(rows.map(row=>row.firstVisibleStreamedWord?.latencyMs.high)),
  retainedVisibleWordMs:latencyDistribution(rows.map(row=>row.firstRetainedVisibleStreamedWord?.latencyMs.high)),
  firstWordHiddenUntilAfterStreaming:rows.filter(row=>row.firstWordHiddenUntilAfterStreaming).length,
  trialsWithoutVisibleWord:rows.filter(row=>!row.firstVisibleStreamedWord).length});
}
const report={recordedAt:new Date().toISOString(),primaryMetric:'last voiced playback sample to first complete streamed word visibly rendered in the actual overlay',
 completionRequired:false,correctnessRequiredForThisLatencyMetric:false,populationP95Certified:false,runs};
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,runs:runs.map(({journal,status,firstVisibleWordMs,retainedVisibleWordMs,trialsWithoutVisibleWord})=>
 ({journal,status,firstVisibleWordMs,retainedVisibleWordMs,trialsWithoutVisibleWord}))}));
