import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const directory='artifacts/deep-interview-v70/algorithms-hour-t/code-review/round36';
const manifestFile=`${directory}/round-36.manifest.json`,manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes);
const oracleFile=`${directory}/independent-cleanup-schedule-oracle.json`,oracleBytes=await readFile(oracleFile),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.journalSha256,manifest.source.sha256);assert.equal(oracle.sourceSha256,manifest.files[0].sha256);
assert.equal(hash(await readFile(manifest.files[0].file)),oracle.sourceSha256);
const journalBytes=await readFile(manifest.source.file);assert.equal(hash(journalBytes),manifest.source.sha256);
const journal=JSON.parse(journalBytes),row=journal.rows.find(row=>row.round===manifest.round);assert(row&&!row.error&&!row.cancelled);
assert.equal(hash(row.answer),manifest.answerSha256);assert.equal(oracle.failures,0);
const report={recordedAt:new Date().toISOString(),journal:manifest.source,round:manifest.round,
 questionSha256:hash(row.question),answerSha256:manifest.answerSha256,code:manifest.files[0],
 priorPublicContract:[32,33].map(round=>{const prior=journal.rows.find(row=>row.round===round);return {round,question:prior.question,questionSha256:hash(prior.question)};}),
 evidence:[{file:manifestFile,sha256:hash(manifestBytes)},{file:oracleFile,sha256:hash(oracleBytes)}],
 model:manifest.model,effort:manifest.effort,seed:oracle.seed,candidateAuthoredTests:oracle.ownCandidateTests,
 exhaustiveSubsetOracleCases:oracle.exhaustiveSubsetOracleCases,feasibleCases:oracle.feasibleCases,infeasibleCases:oracle.infeasibleCases,
 namedBoundaryCases:oracle.namedBoundaryCases,maximumDomainCase:oracle.maximumDomainCase,
 failures:oracle.failures,observedExecutionMs:oracle.elapsedMs,originalSourcePatched:false,
 manualSourceReview:{ordering:'Compatibility requires c_i=end_i+g_i <= start_j < end_j <= c_j, so any compatible predecessor has strictly smaller completion. Equal-completion jobs cannot follow one another.',
  predecessorBoundary:'bisect_right searches only the earlier prefix and includes completions equal to the new start. The resulting prefix index is strictly before the current job, preventing its reuse.',
  exactlyK:'Only the zero-count row is initialized to zero. Positive-count infeasible states remain None; negative optima remain eligible. Each take consumes one count and jumps to its compatible predecessor prefix.',
  finalCleanup:'There is no external completion deadline on the final selected job. A huge cleanup value changes ordering but does not prevent selection as the last job.',
  workBound:'Sorting and predecessor searches use O(N log N) arithmetic comparisons; DP uses O(NK) transitions and O(N(K+1)) storage. The answer explicitly notes that arbitrary-precision timestamp/cleanup bit lengths add integer-operation costs.'},
 scope:'Selective full-source execution and manual reasoning about DSA round 36. The 3066 subset-oracle cases come from dependent small instances, with five named boundary cases and one maximum-size positive chain. These are not independent interview draws, an all-input proof, all large-instance coverage or a whole-interview accuracy rate.'};
await writeFile('docs/evidence/cleanup-schedule-execution-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/cleanup-schedule-execution-v70.json',oracleCases:oracle.exhaustiveSubsetOracleCases,failures:oracle.failures}));
