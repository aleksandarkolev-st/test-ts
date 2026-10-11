import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const directory='artifacts/deep-interview-v70/algorithms-hour-t/code-review/round12';
const manifestFile=`${directory}/round-12.manifest.json`,manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes);
const oracleFile=`${directory}/independent-parser-oracle.json`,oracleBytes=await readFile(oracleFile),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.journalSha256,manifest.source.sha256);
assert.equal(oracle.sourceSha256,manifest.files[0].sha256);
assert.equal(hash(await readFile(manifest.files[0].file)),oracle.sourceSha256);
const journalBytes=await readFile(manifest.source.file);assert.equal(hash(journalBytes),manifest.source.sha256);
const row=JSON.parse(journalBytes).rows.find(row=>row.round===manifest.round);assert(!row.error&&!row.cancelled);
assert.equal(hash(row.answer),manifest.answerSha256);
const caseKeys=['random_partition_cases','malformed_suffix_cases','truncated_eof_cases','early_close_cases','maximum_payload_cases'];
const total=caseKeys.reduce((sum,key)=>sum+oracle.independentCases[key],0);assert.equal(oracle.failures,0);
const report={recordedAt:new Date().toISOString(),journal:manifest.source,round:manifest.round,
 questionSha256:hash(row.question),answerSha256:manifest.answerSha256,
 code:manifest.files[0],evidence:[{file:manifestFile,sha256:hash(manifestBytes)},{file:oracleFile,sha256:hash(oracleBytes)}],
 model:manifest.model,effort:manifest.effort,candidateAuthoredTests:oracle.ownCandidateTests,
 independentCases:oracle.independentCases,totalIndependentCases:total,seed:oracle.seed,failures:oracle.failures,
 observedExecutionMs:oracle.elapsedMs,originalSourcePatched:false,
 manualSourceReview:{ownership:'feed sets the active iterator before returning. A rejected competing feed or EOF leaves ownership intact. Normal exhausted next releases it; explicit early close and parsing errors additionally close and discard the parser state.',
  yieldOrder:'Each next returns a completed frame before looking at the following header, so an invalid suffix does not suppress a preceding valid frame.',
  inputReferences:'finish releases the top-level input memoryview and removes the iterator references to that view and parser. Temporary slices use memoryview context managers. The execution checks also keep protocol-error tracebacks alive and check their candidate-frame views for release.',
  workBound:'For immutable byte chunks and sequential calls, each consumed header or payload byte is appended once; completed payload conversion copies that payload once. Bounded header unpacking and constant iterator operations give amortized O(B + K) for B bytes and K feed calls, using the standard bytearray growth model.',
  storageBound:'Copied header storage is at most twelve bytes and the unfinished payload is at most the cap. The parser has one input view; it does not accumulate yielded outputs. This supports O(cap) internal copied storage under the stated exclusions, not a strict one-cap peak-byte bound.'},
 scope:'Selective full-source execution of the completed DSA round-12 parser, not a whole-interview accuracy rate or proof of every input. The 759 functional cases are dependent finite checks, not independent interview draws. No real network concurrency, simultaneous calls or exact peak-memory benchmark was performed. Full source-contract and other-answer judgments remain separately reviewable.'};
await writeFile('docs/evidence/tcp-parser-execution-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/tcp-parser-execution-v70.json',totalIndependentCases:total,failures:oracle.failures}));
