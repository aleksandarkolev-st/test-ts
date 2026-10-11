import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='artifacts/deep-interview-v70/hard-probes/deep-code-memory/interview.json';
const bytes=await readFile(file),journal=JSON.parse(bytes),sha256=createHash('sha256').update(bytes).digest('hex');
const records=[];
for(const round of [15,16]){
 const directory=`artifacts/deep-interview-v70/hard-probes/deep-code-memory/code-review/round${round}`;
 const isolated=JSON.parse(await readFile(`${directory}/independent-bit-tree-oracle.json`));
 const integration=JSON.parse(await readFile(`${directory}/independent-sampler-integration.json`));
 assert.equal(isolated.journalSha256,sha256);
 assert.equal(createHash('sha256').update(journal.rows[round-1].answer).digest('hex'),isolated.answerSha256);
 for(const dependency of integration.dependencies)assert.equal(dependency.journalSha256,sha256);
 records.push({round,isolatedFunctionEvidence:{file:`${directory}/independent-bit-tree-oracle.json`,...isolated},
  fullAppendOnlyIntegrationEvidence:{file:`${directory}/independent-sampler-integration.json`,...integration}});
}
const own=JSON.parse(await readFile('artifacts/deep-interview-v70/hard-probes/deep-code-memory/code-review/sampler-dependency-own-tests.json'));
for(const dependency of own.sources)assert.equal(dependency.journalSha256,sha256);
const record={recordedAt:new Date().toISOString(),source:{file,sha256},records,dependencyOwnTests:own,
 manualProofReview:{assessment:'sound_under_stated_bit_source_assumption',
  assumption:'Injected integer bits are independent and unbiased. No physical source was tested.',
  uniformity:'Conditional on survival, c is uniform on the integer interval [0,v). Appending one unbiased bit doubles that uniform range. Every accepted rank receives equal mass; rejection followed by subtracting the count preserves a uniform retained tail.',
  survival:'For n>1, the surviving prefix count after k bits follows r_(k+1)=2*r_k mod n with r_0=1. Hence r_k=2^k mod n and P(T>k)=r_k/2^k<n/2^k, which tends to zero.',
  expectation:'For nonpowers of two, write n=2^m*x with 1<x<2. The first m+1 tail-sum terms equal one; the remaining geometric upper bound is strictly less than x. Thus E[T]<m+1+x<log2(n)+2 because log2(x)>x-1. For n=2^m, exactly m bits suffice. Count one returns without a bit request; nonpositive counts reject before requesting one.',
  scope:'Direct mathematical review of the recorded argument plus separate finite executions. This is not a measurement of a physical entropy source or a certification of every schedule-index complexity claim.'},
 conclusion:'Both complete append-only sampler versions passed the isolated finite bit-tree tests, independent conditional-schedule integration cases, zero/singleton draw checks and their supplied sampler tests. The earlier isolated-function scope remains preserved; subsequent full-chain evidence establishes the tested integration separately.',
 productionLogicChanged:false,
 scope:'Selective independent execution of exact recorded code and manual proof review. Test executions are dependent checks of two related answers, not independent population-accuracy samples. No source was repaired, and no expected answers were installed in the app.'};
await writeFile('docs/evidence/bit-sampler-execution-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({rounds:records.map(r=>({round:r.round,bitStrings:r.isolatedFunctionEvidence.totalBitStringExecutions,
  integrationCases:r.fullAppendOnlyIntegrationEvidence.independentRestrictionCases,failures:r.fullAppendOnlyIntegrationEvidence.failures})),originalSourcesPatched:false}));
