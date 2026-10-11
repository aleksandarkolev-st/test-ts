import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files={classification:'artifacts/deep-interview-v70/algorithms-hour-t/code-review/round4/oracle-evidence.json',
 connectivity:'artifacts/deep-interview-v70/prior-sol-round10-code/oracle-evidence.json',
 newlineCorrection:'artifacts/deep-interview-v70/prior-sol-round10-code/boundary-newline-audit.json'};
const inputs={};
for(const [name,file] of Object.entries(files)){const bytes=await readFile(file);inputs[name]={file,sha256:hash(bytes),record:JSON.parse(bytes)};}
const c=inputs.classification.record,d=inputs.connectivity.record,n=inputs.newlineCorrection.record;
const report={recordedAt:new Date().toISOString(),model:'gpt-6.1-sol',effort:'low',
 scope:'Selective executable accuracy checks of two untouched recorded programs. No full-interview correctness rate or latency target is certified.',
 checks:[{run:'algorithms-hour-t',round:4,language:'Python',cases:c.cases,sourceContractFailures:c.sourceContractFailures,
   classificationsMatchAfterDiagnosticEncodingTranslation:c.classificationOnlyFailuresAfterExplicitEncodingTranslation===0,
   sourceContractPassed:false,sourceSha256:c.sourceSha256,answerSha256:c.answerSha256,
   issue:'Required string minus-INF was replaced with positive floating-point infinity. The output encoding translation is diagnostic and does not make the original source pass.'},
  {run:'sol-coding-hour-v68',round:10,language:'C++20',operations:d.operations,queries:d.queries,allQueriesMatch:d.allQueriesMatch,
   originalSourcePatched:false,compileExitCode:d.compileExitCode,sourceSha256:d.recordedSourceSha256,
   boundaryCases:d.boundaryCases.length,boundaryCasesPassingWithPlatformNewlines:d.boundaryCases.slice(0,-1).filter(x=>x.passed).length+Number(n.universalNewlineComparisonPassed),
   evaluatorCorrection:'Initial last-boundary false result compared Windows CRLF bytes with LF. Separate re-execution confirms identical logical lines; original evidence is retained.'}],
 inputs:Object.fromEntries(Object.entries(inputs).map(([key,{file,sha256}])=>[key,{file,sha256}])),
 currentHourStillPending:true};
await mkdir('docs/evidence',{recursive:true});
await writeFile('docs/evidence/selective-dsa-execution-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({classificationCases:c.cases,classificationContractFailures:c.sourceContractFailures,connectivityQueries:d.queries,connectivityMatch:d.allQueriesMatch}));
