import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sourceFile='artifacts/deep-interview-v70/general-hour-t/interview.json';
const bytes=await readFile(sourceFile),journal=JSON.parse(bytes),row=journal.rows.find(row=>row.round===36);
assert(row?.phase==='complete'&&!row.error&&row.latency.completedAt!=null);
const block=row.answer.match(/```python\s*\n([\s\S]*?)```/u)?.[1];assert(block);
const requestedName=row.question.match(/named (\w+)/u)?.[1];assert(requestedName);
const definedNames=[...block.matchAll(/^def (\w+)\(/gmu)].map(match=>match[1]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const rowSnapshotFile='artifacts/deep-interview-v70/general-hour-t/round-36-completed-row-snapshot.json';
const rowBytes=Buffer.from(JSON.stringify(row,null,2));
await writeFile(rowSnapshotFile,rowBytes,{flag:'wx'});
const report={recordedAt:new Date().toISOString(),sourceJournal:{file:sourceFile,sha256AtSnapshot:hash(bytes),statusAtSnapshot:journal.status},
 rowSnapshot:{file:rowSnapshotFile,sha256:hash(rowBytes)},round:row.round,requestedSourceEntryPoint:requestedName,
 recognizedQuestion:row.recognizedQuestion,definedTopLevelFunctions:definedNames,
 sourceCodeSha256:hash(block),answerSha256:hash(row.answer),
 requestedEntryPointPresent:definedNames.includes(requestedName),
 mathematicalAlgorithmExecutionPending:true,finalJournalBindingPending:true,
 scope:'Read-only inspection of an actual completed retained listing. The exact source-text entry-point contract and mathematical behavior are separate. Spoken identifier capitalization may be ambiguous; this does not isolate ASR versus generation as the cause. No identifier is renamed or alias injected. This immutable row snapshot will be checked against the clean final journal before final assessment.'};
await writeFile('docs/evidence/general-crt-entrypoint-snapshot-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({round:row.round,requestedEntryPoint:requestedName,definedNames,requestedEntryPointPresent:report.requestedEntryPointPresent,mathematicalAlgorithmExecutionPending:true,finalJournalBindingPending:true}));
