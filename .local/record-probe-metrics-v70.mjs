// Offline measurement aggregation only; does not import or alter the application.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base='artifacts/deep-interview-v70/hard-probes',records=[],pending=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const entry of await readdir(base,{withFileTypes:true})){
 if(!entry.isDirectory())continue;
 let raw;
 try{raw=await readFile(`${base}/${entry.name}/duration-audit.json`);}catch(error){if(error.code==='ENOENT'){pending.push(entry.name);continue;}throw error;}
 const report=JSON.parse(raw);
 records.push({name:entry.name,report:`${base}/${entry.name}/duration-audit.json`,reportSha256:hash(raw),
  journalSha256:report.journalSha256,status:report.status,stoppedCleanly:report.stoppedCleanly,
  model:report.model,effort:report.effort,output:report.outputDevice,
  evaluatedTurns:report.summary.evaluatedTurns,firstVisibleWordMs:report.summary.firstVisibleWordMs,
  turnsWithoutVisibleWord:report.summary.turnsWithoutVisibleWord,cancelled:report.summary.cancelled,errors:report.summary.errors,
  provisionalFullModelGrades:report.summary.fullModelGrades,ungradedFullAnswers:report.summary.ungradedFullAnswers,
  provisionalPartialGrades:report.summary.partialModelGrades,asrLexicalComparison:report.summary.asr,
  actualStreamingOverlapLaunches:report.summary.actualStreamingOverlapLaunches});
}
const record={recordedAt:new Date().toISOString(),records,pending,
 selectiveEvidence:['docs/evidence/cuda-nineteen-lane-execution-v70.json','docs/evidence/atomic-free-histogram-compile-v70.json',
  'docs/evidence/streaming-topic-switch-v70.json',`${base}/fp32-association/fp32-execution-evidence.json`],
 scope:'Aggregate immutable reports from completed playback-only recordings. The application was not changed to supply canned answers. First visible-word latency measures rendering, independently of whether the answer is correct. Examiner grades are provisional; partial and missing grades remain separate. Evidence of compilation, finite symbolic execution and selective content checks does not establish full accuracy. Stale display failure is recorded separately from content grading. These small dependent samples do not estimate population p95.',
 fullIndependentAccuracyVerified:false,goalComplete:false};
await writeFile('docs/evidence/hard-probe-recordings-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({saved:'docs/evidence/hard-probe-recordings-v70.json',completedReports:records.length,pending}));
