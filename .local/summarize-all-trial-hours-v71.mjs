import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {recordedCohort} from './lib/recorded-cohort.mjs';
import {streamedWordLatency,latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
const [root='artifacts/deep-interview-v71',output]=process.argv.slice(2);assert(output);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const cohort=await recordedCohort(root),hours=[];
for(const entry of cohort.hours){
 const bytes=await readFile(entry.file),journal=JSON.parse(bytes);
 assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
 assert.equal(journal.model,cohort.configuration.model);assert.equal(journal.effort,cohort.configuration.effort);
 assert(journal.outputDevice.includes(cohort.configuration.output));
 const rows=journal.rows.map(row=>{
  const measurement=streamedWordLatency(journal,row);
  return {round:row.round,responseVersion:row.responseVersion??null,phase:row.phase,
   cancelled:row.cancelled??false,error:row.error??null,
   firstRetainedVisibleWordLatencyMs:measurement.firstRetainedVisibleStreamedWord?.latencyMs??null,
   firstVisibleWordMissingReason:measurement.missingReason};
 });
 const values=rows.map(row=>row.firstRetainedVisibleWordLatencyMs?.high).filter(Number.isFinite).sort((a,b)=>a-b);
 const rank=Math.ceil(rows.length*.95);
 hours.push({...entry,journalSha256:hash(bytes),turns:rows.length,
  finiteObservedRetainedWordLatencyMs:latencyDistribution(values),
  allRecordedTrialsRetainedWordP95:{nearestRank:rank,totalTrials:rows.length,deliveredWords:values.length,
   missingWords:rows.length-values.length,valueMs:values.length>=rank?values[rank-1]:null,
   status:values.length>=rank?'rank_reached_among_recorded_trials':'rank_not_reached'},rows});
}
const collector=fileURLToPath(import.meta.url);
const result={recordedAt:new Date().toISOString(),model:cohort.configuration.model,effort:cohort.configuration.effort,
 outputDevice:cohort.configuration.output,collector:{file:collector,sha256:hash(await readFile(collector))},
 hours,scope:'All recorded source rows remain in the percentile denominator. Missing retained words rank after observed deliveries, without assigning an invented numerical latency. First-word delivery is measured separately from correctness, completion, cancellation and timeout; this is a dependent synthetic sample, not population p95.'};
await writeFile(output,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(hours.map(({name,turns,finiteObservedRetainedWordLatencyMs,allRecordedTrialsRetainedWordP95})=>({name,turns,finiteObservedRetainedWordLatencyMs,allRecordedTrialsRetainedWordP95}))));
