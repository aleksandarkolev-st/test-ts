import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const journalFile='artifacts/deep-interview-v70/systems-hour-t/interview.json';
const bytes=await readFile(journalFile),journal=JSON.parse(bytes);
assert(journal.status==='complete'&&journal.stoppedCleanly);
const binding=round=>{const row=journal.rows.find(row=>row.round===round);assert(row);return {
 round,questionSha256:hash(Buffer.from(row.question)),answerSha256:hash(Buffer.from(row.answer)),
 contextSha256:hash(Buffer.from(row.selectedContext)),phase:row.phase,error:row.error,cancelled:row.cancelled};};
const oracleFile='artifacts/deep-interview-v70/systems-hour-t/code-review/independent-finite-field-oracle.json';
const oracleBytes=await readFile(oracleFile),oracle=JSON.parse(oracleBytes);assert.equal(oracle.journal.sha256,hash(bytes));
assert.equal(oracle.failures,0);
const source=journal.rows.find(row=>row.round===8),probe=journal.rows.find(row=>row.round===29);
const cpp=source.answer.match(/^```cpp\n([\s\S]*?)^```/mu)?.[1];assert(cpp);
assert(!probe.selectedContext.includes(cpp));assert(!probe.selectedContext.includes('Use a bounded grid'));
assert(!probe.selectedContext.includes('MAX_N ='));assert(!probe.answer.includes('```'));
assert.equal(journal.olderCodeProbe.sourceAnswerSha256,hash(Buffer.from(source.answer)));
assert.equal(journal.olderCodeProbe.interveningTurns,20);
const ambiguityVector=[0,1,4,0,0],p=[0,0,0,0,0],q=[1,2,3,4,5].map(x=>(x-1)**2%17);
assert.equal(p.filter((value,i)=>value!==ambiguityVector[i]).length,2);
assert.equal(q.filter((value,i)=>value!==ambiguityVector[i]).length,2);
const record={recordedAt:new Date().toISOString(),journal:{file:journalFile,sha256:hash(bytes)},
 executableChecks:{evidence:{file:oracleFile,sha256:hash(oracleBytes)},bindings:[binding(20),binding(43)],
  decoderCases:oracle.decoderCases,invalidAndInconsistentRejected:oracle.rejectedInvalidOrInconsistentCases,
  suppliedRsaInstanceExhaustivelyChecked:oracle.rsaExhaustiveMessages,failures:0,recordedSourceChanged:false,
  manualDecoderProof:'Within 2t+s <= n-d-1, at least d+1 correct known points form an enumerated interpolation subset. Two accepted degree-at-most-d candidates agree on at least n-s-2t>d distinct field points, so their difference is zero. Zero-error cases do not need a unique error-locator system. Finite code checks remain separate from this mathematical argument.'},
 manualMathematicalChecks:[
  {...binding(7),finding:'The three marginal disease-negative probabilities imply triple-positive disease probability at least 7/10 by the union bound. The no-disease triple-positive probability is at most 1/10. Monotonic Bayes gives 7/106; the recorded lower and upper joint distributions have the required marginals and positive conditioning probabilities. Their posteriors are exactly 7/106 and 1.'},
  {...binding(19),finding:'Independently evaluated the recorded zero polynomial and (x-1)^2 at all five supplied field points. The recorded received vector has distance two from both distinct degree-two-or-less polynomials. Three revealed correct positions determine one polynomial by the root bound.'},
  {...binding(24),finding:'The requested construction is impossible: the alleged 251- and at-most-249-error sets leave at least 500 shared evaluations, exceeding degree 499. The answer correctly rejects that premise. This is a mathematical check; the cancelled and unfinished decoder listing in round 22 is not certified.'}],
 olderImplementationRetention:{sourceBinding:binding(8),probeBinding:binding(29),interveningTurns:20,
  originalBodyInActualSelectedContext:false,originalLeadSentenceInContext:false,originalBoundConstantInContext:false,
  originalResponseReproduced:false,answerRequestsOriginalCode:true,
  finding:'The pipeline did not retain/reproduce the original implementation for this probe. The answer declined to invent absent code. Later replacement code is present in the actual selected context. Hidden backend history is not reconstructed; selected public context alone cannot prove every internal memory source was empty. The spoken reference contains a clipped original-question prefix, so the incomplete exact-reproduction outcome is not treated as an unrelated numerical-constraint failure.'},
 raftManualCheck:{bindings:[binding(51),binding(52)],
  primarySource:{title:'In Search of an Understandable Consensus Algorithm, extended version',url:'https://raft.github.io/raft.pdf',sections:['5.4.1','5.4.2','5.4.3'],consultedAt:'2026-10-11'},
  finding:'The current-term commit rule and freshness comparison agree with the paper. For this fixed three-replica adjacent-term instance, a first later leader lacking the term-seven entry would need an intersecting vote; an older log fails freshness, and any newer log entry must come from the unique term-seven/eight leader or an intervening leader retaining the prefix. That contradicts the first-exception premise. The answer correctly distinguishes the conservative commit rule from the impossibility of the requested replacement trace.',
  scope:'The adjacent-term conclusion is an independent inference from the rules, under ordinary fixed-membership Raft with durable voting/log state. No distributed fault-injection or formal model checking was performed.'},
 independentModelReviewsPending:true,
 scope:'Selective source-bound executable and manual checks. They do not replace the denominator of 53 recorded turns, certify all CUDA/C++/SQL code, grade incomplete cancelled fragments as complete, or infer population accuracy. Earlier timeout and missing-visible-word findings remain recorded.'};
await writeFile('docs/evidence/systems-substantive-checks-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({decoderCases:oracle.decoderCases,rsaValuesChecked:oracle.rsaExhaustiveMessages,finiteFailures:0,
 olderImplementationReproduced:false,independentReviewsPending:true}));
