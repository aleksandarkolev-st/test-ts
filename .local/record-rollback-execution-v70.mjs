import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const directory='artifacts/deep-interview-v70/algorithms-hour-t/code-review/round16';
const manifestFile=`${directory}/round-16.manifest.json`,manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes);
const oracleFile=`${directory}/independent-rollback-oracle.json`,oracleBytes=await readFile(oracleFile),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.journalSha256,manifest.source.sha256);assert.equal(oracle.sourceSha256,manifest.files[0].sha256);
assert.equal(hash(await readFile(manifest.files[0].file)),oracle.sourceSha256);
const journalBytes=await readFile(manifest.source.file);assert.equal(hash(journalBytes),manifest.source.sha256);
const journal=JSON.parse(journalBytes),row=journal.rows.find(row=>row.round===manifest.round);assert(!row.error&&!row.cancelled);
assert.equal(hash(row.answer),manifest.answerSha256);assert.equal(oracle.failures,0);
const report={recordedAt:new Date().toISOString(),journal:manifest.source,round:manifest.round,
 questionSha256:hash(row.question),answerSha256:manifest.answerSha256,code:manifest.files[0],
 priorPublicContract:[13,15].map(round=>{const prior=journal.rows.find(row=>row.round===round);return {round,question:prior.question,questionSha256:hash(prior.question)};}),
 evidence:[{file:manifestFile,sha256:hash(manifestBytes)},{file:oracleFile,sha256:hash(oracleBytes)}],
 model:manifest.model,effort:manifest.effort,candidateAuthoredTests:oracle.ownCandidateTests,
 independentChecks:oracle.independentChecks,exercisedFeatures:oracle.exercisedFeatures,
 seed:oracle.seed,failures:oracle.failures,observedExecutionMs:oracle.elapsedMs,originalSourcePatched:false,
 manualSourceReview:{parity:'For opposite-colored endpoints, the parity linking their roots is pu XOR pv XOR 1. XOR symmetry preserves this expression if roots are swapped for union by size.',
  contradictions:'A same-root inconsistent edge logs and increments that root\u2019s bad count. A consistent redundant edge does not change state. Component merges aggregate bad counts; asks inspect only their own root.',
  rollback:'Reverse history restores old bad counts or detaches a merged root and restores the parent root\u2019s old size and bad count. The detached root was a root before its merge, so resetting its parent to itself and parity to zero is valid; its size and bad count were retained.',
  lifetimes:'An active edge lifetime covers [addition,removal), or ends at the operation count if not removed. Its disjoint segment-tree placement contributes it exactly once on each applicable ask leaf\u2019s ancestor path. Reused IDs have separate lifetimes.',
  bounds:'The visible implementation supports the stated O(N + T + (A log(T+1) + Q) log(N+1)) work under expected constant-time ID dictionary operations, and O(N + T + A log(T+1)) storage. Contradictions can generate O(A) live history entries; history is not limited to structural merges. These are source-level arguments, not measured maximum-size performance.'},
 scope:'Selective execution and manual reasoning about the full unchanged DSA round-16 source. The 1200 offline operation sequences and 300 nested rollback sequences are finite dependent functional checks, not independent interview samples or a whole-interview accuracy rate. Valid small graphs only; invalid inputs, maximum-size performance and all possible executions remain unverified.'};
await writeFile('docs/evidence/rollback-parity-execution-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/rollback-parity-execution-v70.json',independentChecks:oracle.independentChecks,failures:oracle.failures}));
