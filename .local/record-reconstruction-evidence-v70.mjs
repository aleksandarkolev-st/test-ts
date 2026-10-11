import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='artifacts/deep-interview-v70/hard-probes/deep-code-memory/interview.json';
const bytes=await readFile(file),journal=JSON.parse(bytes),sha256=createHash('sha256').update(bytes).digest('hex');
const rounds=[];
for(const round of [25,26,27]){
 const evidenceFile=`artifacts/deep-interview-v70/hard-probes/deep-code-memory/code-review/round${round}/independent-reconstruction-oracle.json`;
 const evidence=JSON.parse(await readFile(evidenceFile));assert.equal(evidence.journalSha256,sha256);
 const row=journal.rows.find(row=>row.round===round);assert.equal(createHash('sha256').update(row.answer).digest('hex'),evidence.answerSha256);
 rounds.push({file:evidenceFile,...evidence});
}
const old=rounds[0].retainedJobListReferenceProfiles;
for(const profile of old){
 const depth=Math.log2(profile.capacity);assert.equal(depth,Math.trunc(depth));
 assert.equal(profile.jobListSlots,profile.negativePrefixJobs*(depth+1)+3*profile.capacity-2);
}
const record={recordedAt:new Date().toISOString(),source:{file,sha256},rounds,
 findings:{finiteCorrectness:'All three untouched listings passed the same 1998 independent subset-oracle cases, their supplied tests and the supported N=2000/K=50 boundary. The oracle checks both optimal profit and minimum cardinality, unique valid identifiers and chronological compatibility.',
  recursiveStorage:'On the supplied negative-prefix family with M negative jobs followed by K=2^d positive unit-profit jobs, the recursive listing retains distinct ancestor left lists. Measured call-boundary job-list slots equal M(d+1)+3K-2, including the retained root and pending right siblings. For M=256/K=32, 1630 slots remain live across 288 records. Deleting the child end_order variable does not release caller-owned left lists.',
  correctedStorage:'The explicit-stack listing had 288 job-list slots at observed split-call boundaries for the same family; the two-ordering listing had 576. These are job-reference measurements, not total peak RAM. Source inspection shows helpers return before child processing and caller parent aliases are removed before pushing children.',
  complexityScope:'The recursive ownership argument omits overlapping ancestor lists. Under the usual parameterized analysis, this family gives a retained-list term proportional to M log K. The listing enforces finite K<=50 and N<=2000; finite measurements do not by themselves prove an unbounded asymptotic lower bound. The explicit-stack and two-ordering corrections require their separate full work-array/partition accounting.',
  twoOrderingWorkArgument:'After two global sorts, a node of size n and capacity c performs O(nc) arithmetic operations. At each depth, child job sets are disjoint and capacities are at most ceil(C/2^d), with C=min(K,N); clamping only reduces them. Summing disjoint node sizes and the halving capacities gives O(NC) reconstruction work. This is an arithmetic-operation argument, not a bound on arbitrary-size integer bit operations.'},
 productionLogicChanged:false,
 scope:'Selective independent execution and source/ownership review of three complete recorded answers. No listing was patched. Does not certify other rounds, all inputs, full peak memory, or whole-interview accuracy.'};
await writeFile('docs/evidence/reconstruction-execution-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({rounds:rounds.map(r=>({round:r.round,cases:r.independentSubsetCases,failures:r.failures})),recursiveFamilyStorageConfirmed:true,originalSourcesPatched:false}));
