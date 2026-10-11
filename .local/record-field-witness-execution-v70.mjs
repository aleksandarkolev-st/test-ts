import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const base='artifacts/deep-interview-v70/algorithms-hour-t/code-review';
const manifests=[];
for(const round of [44,48]){
 const file=`${base}/round${round}/round-${round}.manifest.json`,bytes=await readFile(file),data=JSON.parse(bytes);
 assert.equal(hash(await readFile(data.files[0].file)),data.files[0].sha256);
 manifests.push({file,sha256:hash(bytes),data});
}
const oracleFile=`${base}/round48/independent-field-witness-oracle.json`,oracleBytes=await readFile(oracleFile),oracle=JSON.parse(oracleBytes);
for(const manifest of manifests){
 assert.equal(manifest.data.source.sha256,oracle.journalSha256);
 assert(oracle.sourceBlocks.some(source=>source.sha256===manifest.data.files[0].sha256));
}
const journalFile=manifests[0].data.source.file,journalBytes=await readFile(journalFile);assert.equal(hash(journalBytes),oracle.journalSha256);
const journal=JSON.parse(journalBytes);
const responses=manifests.map(manifest=>{
 const row=journal.rows.find(row=>row.round===manifest.data.round);assert(row&&!row.error&&!row.cancelled);
 assert.equal(hash(row.answer),manifest.data.answerSha256);
 return {round:row.round,question:row.question,questionSha256:hash(row.question),answerSha256:manifest.data.answerSha256};
});
assert.equal(oracle.failures,0);
const report={recordedAt:new Date().toISOString(),journal:{file:journalFile,sha256:oracle.journalSha256},responses,
 evidence:[...manifests.map(({file,sha256})=>({file,sha256})),{file:oracleFile,sha256:hash(oracleBytes)}],
 sourceBlocks:oracle.sourceBlocks,dependencyIntegration:oracle.dependencyIntegration,
 candidateAuthoredMainAssertions:oracle.candidateAuthoredMainAssertions,seed:oracle.seed,
 independentChecks:oracle.independentChecks,imageRankCaseCounts:oracle.imageRankCaseCounts,
 failures:oracle.failures,observedExecutionMs:oracle.elapsedMs,originalSourcesPatched:false,
 manualSourceReview:{affineSpace:'A particular solution plus the kernel of the first projection describes all permissible X. Mapping that kernel through the second projection gives the attainable output affine space.',
  pairedElimination:'Each stored output/preimage pair retains A(z)=0 and B(z)=y. XORing both coordinates preserves these equations. Distinct leading output pivots are independent and span the processed images.',
  targetReduction:'Removing the highest residual bit through an existing pivot accumulates a matching nullspace preimage. A missing leading pivot proves infeasibility; zero residual gives a witness satisfying both equations.',
  zeroImage:'A nonzero preimage with zero output lies in both kernels. Discarding it preserves attainable outputs and reconstruction of one witness, though it does not preserve an enumeration of every witness.',
  rankOracle:'For each checked parameter pair, independently constructed coefficient rows give rank(A)=64. The independent combined-system rank minus 64 equals the affine variation dimension. Feasible offset, independent basis vectors of that dimension and their homogeneous membership verify the returned affine-space description for that checked pair.'},
 model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 scope:'Selective algebraic execution checks of unchanged DSA rounds 44 and 48, combined exactly as the append instruction requires. The reference uses polynomial long multiplication/reduction and independent row elimination of all equations. Finite parameter cases, not a whole-interview accuracy rate, real AES-GCM interoperability, attack execution, all-input proof or peak-memory benchmark.'};
await writeFile('docs/evidence/field-witness-execution-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/field-witness-execution-v70.json',independentChecks:oracle.independentChecks,failures:oracle.failures}));
