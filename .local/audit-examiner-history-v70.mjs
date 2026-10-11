import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {jobsAtObservation} from '../scripts/lib/deep-observations.mjs';
import {fencedSources} from '../scripts/lib/fenced-sources.mjs';
const base='artifacts/deep-interview-v70/algorithms-hour-t';
const raw=await readFile(base+'/interview.json'),journal=JSON.parse(raw),findings=[];
for(const [earlierRound,reviewRound] of [[9,11],[3,7],[25,28]]){
 const file=`${base}/round-${String(reviewRound).padStart(2,'0')}.examiner.json`;
 let requestRaw,metadata;
 try{requestRaw=await readFile(file);metadata=await stat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
 const request=JSON.parse(requestRaw),earlier=journal.rows.find(r=>r.round===earlierRound),id=earlier?.responseVersion?.split(':')[0];
 const index=journal.deepObservations.findLastIndex(o=>o.hostAfterMs<=metadata.birthtimeMs);
 const job=jobsAtObservation(journal.deepObservations,index).find(j=>j.question.id===id);
 const code=fencedSources(job?.answer??'');
 findings.push({earlierRound,reviewRound,requestCreatedHostMs:metadata.birthtimeMs,
  observationHostMs:journal.deepObservations[index]?.hostAfterMs,jobPhase:job?.phase,
  earlierAnswerCharsObservedBeforeRequest:job?.answer?.length??null,closedCodeBlocksObservedBeforeRequest:code.length,
  examinerHistoryContainsEveryObservedClosedBlock:code.length?code.every(b=>request.history.includes(b.text)):null,
  requestSha256:createHash('sha256').update(requestRaw).digest('hex'),
  earlierAnswerSha256:job?createHash('sha256').update(job.answer).digest('hex'):null});
}
const report={recordedAt:new Date().toISOString(),journalSnapshotSha256:createHash('sha256').update(raw).digest('hex'),findings,
 scope:'Selective examiner-history audit against native observations strictly before request file creation. Closed source presence does not establish correctness, visibility, completion, or that a particular grade was wrong. The running original harness is unchanged; future runs refresh earlier public answers at review time.'};
await writeFile(base+'/examiner-history-audit.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(report));
