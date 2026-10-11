import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fencedSources} from '../scripts/lib/fenced-sources.mjs';
const base='artifacts/deep-interview-v70/algorithms-hour-t';
const raw=await readFile(base+'/interview.json'),j=JSON.parse(raw),r=j.rows.find(x=>x.round===49),id=r.responseVersion.split(':')[0];
const changes=j.deepObservations.flatMap(o=>(o.jobs??[]).filter(job=>job.question.id===id).map(job=>({hostAfterMs:o.hostAfterMs,...job})));
const revisions=[...new Set(changes.map(job=>job.latency?.responseRevision))].map(revision=>{
 const jobs=changes.filter(job=>job.latency?.responseRevision===revision),longest=jobs.reduce((a,b)=>(b.answer?.length??0)>(a?.answer?.length??0)?b:a,null);
 const blocks=fencedSources(longest?.answer??'');
 return {revision,phase:longest?.phase,answerChars:longest?.answer?.length,closedBlocks:blocks.length,
  definesTransferOnce:blocks.some(b=>/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+transfer_once|def\s+transfer_once\s*\(/iu.test(b.text)),
  blocks:blocks.map(b=>({language:b.language,sha256:createHash('sha256').update(b.text).digest('hex'),preview:b.text.slice(0,160)}))};
});
const prior=j.rows.filter(x=>x.round<49);
const priorDefines=prior.filter(x=>fencedSources(x.answer??'').some(b=>/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+transfer_once|def\s+transfer_once\s*\(/iu.test(b.text))).map(x=>x.round);
const selected=changes.find(job=>typeof job.selectedContext==='string')?.selectedContext??null;
const report={recordedAt:new Date().toISOString(),journalSha256:createHash('sha256').update(raw).digest('hex'),round:49,
 questionSha256:createHash('sha256').update(r.question).digest('hex'),answerSha256:createHash('sha256').update(r.answer).digest('hex'),
 sourceRound:7,sourceAnswerSha256:createHash('sha256').update(j.rows.find(x=>x.round===7).answer).digest('hex'),
 originalEntryPoint:'transfer(dsn, request_id, from_id, to_id, amount)',referredEntryPoint:'transfer_once(UUID,BIGINT,BIGINT,BIGINT)',
 earlierRecordedRowsDefiningReferredEntryPoint:priorDefines,revisions,
 selectedContextChars:selected?.length??null,selectedContextContainsReferredName:selected?.includes('transfer_once')??null,
 scope:'Mechanical code-reference audit of immutable source answers and observed revisions. Regex definition presence does not establish runnable SQL, functional correctness, exact old-code recall or what appeared in every physical viewport.'};
await writeFile(base+'/sql-reference-audit.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(report));
