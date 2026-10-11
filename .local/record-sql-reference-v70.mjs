import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base='artifacts/deep-interview-v70/algorithms-hour-t';
const bytes=await readFile(base+'/sql-reference-audit.json'),audit=JSON.parse(bytes),hash=x=>createHash('sha256').update(x).digest('hex');
const journal=JSON.parse(await readFile(base+'/interview.json')),row=journal.rows.find(x=>x.round===49),id=row.responseVersion.split(':')[0];
const contexts=journal.deepObservations.flatMap(o=>(o.jobs??[]).filter(x=>x.question.id===id&&typeof x.selectedContext==='string').map(x=>x.selectedContext));
const record={recordedAt:new Date().toISOString(),model:journal.model,effort:journal.effort,output:journal.outputDevice,
 journalSha256:audit.journalSha256,sourceRound:7,returnRound:49,interveningTurns:41,
 questionSha256:audit.questionSha256,answerSha256:audit.answerSha256,sourceAnswerSha256:audit.sourceAnswerSha256,
 originalEntryPoint:audit.originalEntryPoint,referredEntryPoint:audit.referredEntryPoint,
 earlierRecordedRowsDefiningReferredEntryPoint:audit.earlierRecordedRowsDefiningReferredEntryPoint,
 observedRevisionsDefiningReferredEntryPoint:audit.revisions.filter(r=>r.definesTransferOnce).map(r=>r.revision),
 selectedContextSamplesMentioningReferredEntryPoint:contexts.filter(x=>x.includes('transfer_once')).length,
 finding:'The retained answer says that a complete transfer_once schema and function were supplied immediately above, and gives a call and retry-branch fragment. No earlier retained answer or observed answer revision defines that function; the original completed implementation was the Python transfer function. The requested complete executable patch is missing from the recorded answer.',
 sourceConstraintTracking:'The retained answer correctly states that deleting every durable request trace is incompatible with indefinite deduplication and proposes keeping permanent request metadata while expiring payloads. This conceptual response does not supply the missing function.',
 rawAudit:base+'/sql-reference-audit.json',rawAuditSha256:hash(bytes),
 scope:'Selective mechanical reference audit of exposed recorded source/answer revisions. Hidden speculative backend turns are not reconstructed. No PostgreSQL runtime test was performed, and this finding does not establish a whole-interview accuracy rate.'};
await writeFile('docs/evidence/older-sql-reference-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify(record));
