// Classify recorded transport writes independently of answer correctness.
// Prepared Codex threads and retained backend history are different states.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {latencyDistribution} from './lib/streamed-word-latency.mjs';

const [outputFile,...inputs]=process.argv.slice(2);
assert(outputFile&&inputs.length&&inputs.length%2===0,'OUT_FILE JOURNAL REVIEW [JOURNAL REVIEW...]');
const root=process.cwd(),out=path.resolve(outputFile);
assert(out.startsWith(path.resolve('docs/evidence')+path.sep),'Write reviewable evidence within docs/evidence');
const sha=x=>createHash('sha256').update(x).digest('hex');
const cells=[];
for(let i=0;i<inputs.length;i+=2){
 const file=inputs[i],reviewFile=inputs[i+1];
 const bytes=await readFile(file),journal=JSON.parse(bytes);assert.equal(journal.status,'complete');
 const reviewBytes=await readFile(reviewFile),review=JSON.parse(reviewBytes);assert.equal(review.journalSha256,sha(bytes));
 const verdicts=new Map(review.rows.map(row=>[row.round,row]));assert.equal(verdicts.size,journal.rows.length);
 const rows=journal.rows.map(row=>{
  const verdict=verdicts.get(row.round);assert(verdict);assert.equal(verdict.answerSha256,sha(row.answer));
  const p=row.latency?.pipeline??{},acceptedAt=row.latency?.questionConfirmedAt;
  if(p.generationId&&row.responseVersion)assert.equal(p.generationId,row.responseVersion.split(':')[0]);
  const actualWriteAt=journal.backend==='codex'?p.transportWrittenAt:null;
  const acceptedToWriteMs=Number.isFinite(acceptedAt)&&Number.isFinite(actualWriteAt)?actualWriteAt-acceptedAt:null;
  if(acceptedToWriteMs!==null)assert(acceptedToWriteMs>=0,'Never combine different input generations');
  const prepared=Number.isFinite(p.warmThreadTaken)&&Number.isFinite(p.preparedThreadAgeMs)&&p.preparedThreadAgeMs>=0;
  const faultInjected=!!row.faultInjection,observerInterference=row.observerInterference??verdict.observerInterference??null;
  const healthyPreparedWrite=journal.backend==='codex'&&prepared&&acceptedToWriteMs!==null&&!faultInjected&&!observerInterference&&!row.error;
  return {round:row.round,responseVersion:row.responseVersion??null,answerSha256:sha(row.answer),phase:row.phase,error:row.error??null,
   acceptedAt:acceptedAt??null,actualWriteAt:actualWriteAt??null,acceptedToWriteMs,
   preparedThreadTakenAt:p.warmThreadTaken??null,preparedThreadAgeMs:p.preparedThreadAgeMs??null,
   retainedThreadHistoryUsed:p.warmStateUsed??null,faultInjected,observerInterference,healthyPreparedWrite};
 });
 const healthy=rows.filter(row=>row.healthyPreparedWrite);
 cells.push({journalFile:path.relative(root,path.resolve(file)),journalSha256:sha(bytes),reviewSha256:sha(reviewBytes),nativeBinarySha256:journal.nativeBinarySha256,
  backend:journal.backend,model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
  allRows:rows.length,observedWrites:rows.filter(row=>row.acceptedToWriteMs!==null).length,
  healthyPreparedWrites:healthy.length,healthyPreparedAcceptedToWriteMs:latencyDistribution(healthy.map(row=>row.acceptedToWriteMs)),rows});
}
const report={schemaVersion:1,recordedAt:new Date().toISOString(),classifierSha256:sha(await readFile(new URL(import.meta.url))),
 distributionSourceSha256:sha(await readFile(new URL('./lib/streamed-word-latency.mjs',import.meta.url))),cells,
 scope:'Completed recorded captures only. A healthy prepared Codex submission requires the same generation, an observed prepared-thread take and age, actual owned app-server stdin flush, and no recorded injected fault, observer interference or answer error. Subsequent intended interruption does not make its earlier submission cold. This is local adapter transport submission, not provider first-content or answer correctness. warmStateUsed records retained-history reuse; false does not disqualify an acknowledged prepared ephemeral thread. HTTP actual wire writes and warm readiness remain unknown. Excluded and missing rows remain present in full capture evidence; finite sample p95 is not a population or whole-assistant latency guarantee.'};
// Re-exporting a review is allowed only for the same immutable input journals.
try{const previous=JSON.parse(await readFile(out));assert.deepEqual(previous.cells.map(c=>[c.journalFile,c.journalSha256]),cells.map(c=>[c.journalFile,c.journalSha256]));}
catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2));
console.log(JSON.stringify({file:outputFile,cells:cells.map(cell=>({backend:cell.backend,rows:cell.allRows,healthy:cell.healthyPreparedWrites,submission:cell.healthyPreparedAcceptedToWriteMs}))}));
