import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {recordedCohort} from './lib/recorded-cohort.mjs';
const [root,output]=process.argv.slice(2);assert(root&&output,'RUN_DIRECTORY OUTPUT_JSON');
const hash=value=>createHash('sha256').update(value).digest('hex');
const cohort=await recordedCohort(root,{requireTerminal:false}),hours=[];
for(const source of cohort.hours){
 const auditFile=path.join(path.dirname(source.file),'duration-audit.json'),bytes=await readFile(auditFile),audit=JSON.parse(bytes);
 assert(audit.status==='complete'&&audit.stoppedCleanly&&audit.durationVerified);
 assert.equal(audit.requestedDurationMs,source.requestedDurationMs);
 hours.push({name:source.name,domain:source.domain,journal:{file:source.file,sha256:audit.journalSha256},audit:{file:auditFile,sha256:hash(bytes)},
  model:audit.model,effort:audit.effort,outputDevice:audit.outputDevice,speechConfiguration:audit.speechConfiguration,
  actualInterviewDurationMs:audit.actualInterviewDurationMs,summary:audit.summary});
}
const report={recordedAt:new Date().toISOString(),queueSnapshot:{file:cohort.queueFile,sha256:hash(await readFile(cohort.queueFile)),latestEvent:cohort.events.at(-1)},
 collectorSourceHashes:{[import.meta.url]:hash(await readFile(new URL(import.meta.url))),'.local/lib/recorded-cohort.mjs':hash(await readFile(new URL('./lib/recorded-cohort.mjs',import.meta.url)))},
 hours,scope:'Completed recordings discovered from actual queue events. Per-recording descriptive sample percentiles and all missing/error/cancellation denominators remain separate. Provisional examiner grades are not independent accuracy. Resource growth includes recorder history retention and does not establish a native leak. This snapshot does not certify population p95, pressure-test completion or candidate improvement.',
 independentAccuracyPending:true,candidatePerformanceVerified:false,goalComplete:false};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,hours:hours.map(hour=>({name:hour.name,minutes:hour.actualInterviewDurationMs/60000,turns:hour.summary.evaluatedTurns,latency:hour.summary.firstRetainedVisibleWordMs,missing:hour.summary.turnsWithoutVisibleWord,errors:hour.summary.errors,cancelled:hour.summary.cancelled}))}));
