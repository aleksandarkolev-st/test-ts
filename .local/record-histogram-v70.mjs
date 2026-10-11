import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base='artifacts/deep-interview-v70/hard-probes/histogram-late-reversal';
const journalBytes=await readFile(`${base}/interview.json`),journal=JSON.parse(journalBytes),row=journal.rows[0];
assert.equal(journal.status,'complete');assert.equal(journal.stoppedCleanly,true);
const source=await readFile(`${base}/code-review/round-1-block-1.cu`),executable=await readFile(`${base}/code-review/histogram.exe`);
const hash=x=>createHash('sha256').update(x).digest('hex');
assert.equal(hash(source),'599634bc71206ffb626a83ac40986611951f33fc7fc264ca6050741565fd1898');
assert.equal(executable.subarray(0,2).toString(),'MZ');
const record={recordedAt:new Date().toISOString(),model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 journalSha256:hash(journalBytes),sourceRound:1,questionSha256:hash(row.question),answerSha256:hash(row.answer),
 sourceSha256:hash(source),executableSha256:hash(executable),originalSourcePatched:false,
 compilation:{passed:true,compiler:'NVIDIA nvcc 12.9.86 with MSVC 14.44.35207',target:'sm_70',standard:'c++17',optimization:'O2',
  commandFile:'.local/compile-histogram-v70.cmd',unsupportedCompilerOverride:false,toolSession:79292,exitCode:0},
 manualOwnershipReview:{atomicOperations:false,
  partialWriter:'Each (block,bin) has one thread identified by bin modulo blockDim.x. Each block scans input indices congruent to its block index modulo gridDim.x.',
  finalWriter:'Each bin belongs to exactly one global-thread residue modulo the reduction grid stride. It sums all block partials.',
  ordering:'Both kernels and transfers are submitted to the same default stream in order.',
  skewHandling:'Every input key is visited for each candidate bin; skew does not introduce shared writes.',
  complexity:'O(N*K) work and O(min(N,1024)*K) partial-count storage; correctness design is expensive for large K.'},
 evidenceDirectory:base+'/code-review',
 scope:'Untouched recorded source compiled and linked. Ownership arguments were reviewed but no NVIDIA hardware execution or performance measurement was performed. The original SSML pause was longer than 1.5 seconds; the separate exact-PCM-pause variant remains a distinct test.'};
await writeFile('docs/evidence/atomic-free-histogram-compile-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify(record));
