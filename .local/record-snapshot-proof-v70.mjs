import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='artifacts/deep-interview-v70/hard-probes/deep-code-memory/interview.json';
const raw=await readFile(file),journal=JSON.parse(raw),row=journal.rows.find(row=>row.round===19);
assert.equal(row.phase,'complete');assert(row.latency.completedAt!=null&&!row.cancelled);
const hash=text=>createHash('sha256').update(text).digest('hex');
const record={recordedAt:new Date().toISOString(),sourceJournal:file,sourceSnapshotSha256:hash(raw),sourceSnapshotStatus:journal.status,
 round:19,questionSha256:hash(row.question),answerSha256:hash(row.answer),responseVersion:row.responseVersion,
 candidateModel:journal.model,candidateEffort:journal.effort,output:journal.outputDevice,
 firstVisibleWordLatencyHighMs:row.firstStreamedWordMeasurement?.firstVisibleStreamedWord?.latencyMs.high??null,
 reviewType:'Selective source-grounded reasoning review by the recording agent; not the deferred independent model reviewer',
 verdict:'correct',
 finding:'The answer rejects the proposed commit-order lemma using the actual A-to-B antidependency. It distinguishes snapshot visibility order from wall-clock timestamps and gives the necessary edge inequalities. Its cycle traversal crosses from a post-snapshot commit to a pre-snapshot commit through an antidependency, establishing an active-at-snapshot transaction. The final incoming-edge argument establishes that this transaction must write, rather than merely be read-only.',
 reviewMethod:'Independently reason about the finite serialization cycle and its first pre-snapshot committed vertex, then compare the criterion with the primary publication. No benchmark-specific application behavior was added.',
 sources:[{url:'https://www.vldb.org/pvldb/vol5/p1850_danrkports_vldb2012.pdf',section:'4.1–4.2, Theorem 3 and safe snapshots'}],
 scope:'One completed recorded response under the source question’s abstract snapshot-isolation assumptions. This is a reviewed mathematical argument, without a formal proof checker or database runtime execution. It does not establish whole-interview accuracy. The ongoing journal can change; confirm this exact answer identity again after it terminates.'};
await writeFile('docs/evidence/snapshot-proof-accuracy-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify(record));
