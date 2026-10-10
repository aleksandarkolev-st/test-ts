// Offline evidence only. Never imported by runtime inference.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const load=async(name,effort='low')=>{
  const file=`artifacts/native-interview/${name}/interview.json`,r=await json(file);
  assert.equal(r.status,'complete');assert.equal(r.stoppedCleanly,true);
  assert.equal(r.model,'gpt-6-luna');assert.equal(r.effort,effort);assert.equal(r.tier,'fast');
  const values=r.rows.map(row=>row.firstWordFromSpeechEndMs);
  assert(values.every(Number.isFinite));
  const ordered=[...values].sort((a,b)=>a-b);
  return {raw:r,summary:{file,sha256:await sha(file),scope:r.measurement,
    model:r.model,effort:r.effort,tier:r.tier,binarySha256:r.nativeBinarySha256,sourceHashes:r.sourceHashes,intentSourceHashes:r.intentSourceHashes,
    diagnosticSourceHashes:r.diagnosticSourceHashes??null,reviewMode:r.reviewMode,
    speechConfiguration:r.speechConfiguration,classifier:r.intentClassifier??null,
    meanFirstWordMs:values.reduce((a,b)=>a+b,0)/values.length,
    medianFirstWordMs:(ordered[Math.floor((ordered.length-1)/2)]+ordered[Math.floor(ordered.length/2)])/2,
    minFirstWordMs:ordered[0],maxFirstWordMs:ordered.at(-1),
    rows:r.rows.map(row=>({round:row.round,firstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,
      preservesRecognizedClauses:row.preservesAllRecognizedClauses??null,
      pendingAgeAtConfirmationMs:row.latency.pipeline.pendingAgeAtConfirmationMs??null,
      finalPendingBudgetMs:row.latency.pipeline.finalPendingBudgetMs??null,
      restarts:row.latency.pipeline.refinementRestartCount??0,
      promptChars:row.latency.pipeline.promptChars,
      modelReview:row.review??null}))}};
};
const baseline=await load('luna-pending-age-baseline-v45');
const aged=await load('luna-pending-age-experiment-v46');
assert.equal(baseline.summary.binarySha256,aged.summary.binarySha256);
assert.deepEqual(baseline.summary.sourceHashes,aged.summary.sourceHashes);
assert.deepEqual(baseline.summary.intentSourceHashes,aged.summary.intentSourceHashes);
assert.equal(baseline.raw.rows.length,aged.raw.rows.length);
assert.equal(baseline.raw.speechConfiguration.agedFinalWait,false);
assert.equal(aged.raw.speechConfiguration.agedFinalWait,true);
for(let i=0;i<baseline.raw.rows.length;i++){
  assert.equal(baseline.raw.rows[i].question,aged.raw.rows[i].question);
  assert.equal(baseline.raw.rows[i].audio.sha256,aged.raw.rows[i].audio.sha256);
}
for(const run of [baseline,aged]){
  assert(run.raw.realAudio&&run.raw.outputDevice.includes('T24E390'));
  assert.equal(run.raw.speechConfiguration.chunkMs,160);
  assert.equal(run.raw.speechConfiguration.remoteOnly,true);
  assert(run.raw.rows.every(row=>row.reviewSkipped&&row.preservesAllRecognizedClauses));
}
const fresh=await load('luna-deep-prefix-diagnostics-v47');
assert(fresh.raw.realAudio&&fresh.raw.provisionalDiagnostics.enabled);
const stages=await json('artifacts/native-interview/luna-deep-prefix-diagnostics-v47/latency-stage-audit.json');
const prefixes=await json('artifacts/native-interview/luna-deep-prefix-diagnostics-v47/provisional-prefix-audit.json');
const compiler=await json('artifacts/native-interview/luna-deep-prefix-diagnostics-v47/compiler/verification.json');
assert.equal(compiler.exitCode,0);
for(const row of compiler.rows){
  const answer=fresh.raw.rows.find(r=>r.round===row.round).answer;
  const blocks=[...answer.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)];
  assert.equal(blocks.length,1);
  assert.equal(createHash('sha256').update(blocks[0][1]).digest('hex'),row.sourceSha256);
}
const replay=await load('luna-code-history-replay-v48');
assert.equal(replay.raw.realAudio,false);
assert.equal(replay.raw.rows.length,fresh.raw.rows.length);
for(let i=0;i<fresh.raw.rows.length;i++)assert.equal(fresh.raw.rows[i].question,replay.raw.rows[i].question);
const counterexample=await load('luna-claim-check-counterexample-v49');
assert.equal(counterexample.raw.realAudio,false);
assert.equal(counterexample.raw.rows.length,1);
const previousCounterexample=await json('artifacts/native-interview/luna-local-intent-exact-counterexample-v30/interview.json');
assert.equal(counterexample.raw.rows[0].question,previousCounterexample.rows[0].question);
const high=await load('luna-high-counterexample-v50','high');
assert.equal(high.raw.realAudio,false);
assert.equal(high.raw.rows.length,1);
assert.equal(high.raw.rows[0].question,counterexample.raw.rows[0].question);
assert.equal(high.summary.binarySha256,counterexample.summary.binarySha256);
assert.deepEqual(high.summary.sourceHashes,counterexample.summary.sourceHashes);
assert.deepEqual(high.summary.intentSourceHashes,counterexample.summary.intentSourceHashes);
const original='.local/intent-encoder/profile.before-finetuned-v35.json';
assert.equal(await sha('.local/intent-encoder/profile.json'),await sha(original));
const report={
  scope:'Experimental signed-in Luna Fast evidence; no demonstrated near-instant latency. Fixed replays cannot adapt to different answers. Model grades and compilation do not certify runtime correctness.',
  metric:'Client receipt of the first alphanumeric character of the retained decoded/validated answer, from final speech end; audio runs include capture/ASR, rendering is separate. Exact-transcript replay excludes audio and ASR. Does not wait for sentence completion.',
  agedWait:{baseline:baseline.summary,experiment:aged.summary,
    interpretation:'Same binary, public waveforms and settings except age-aware pending budget. Descriptive six-turn samples, not a causal gain or population p95. Many pending inputs were newly sent at confirmation; only some waits exercised an aged budget. No model grading calls between replay turns; independent correctness review remains necessary.'},
  freshAdaptive:fresh.summary,stageSummary:stages.summary,
  prefixObservations:{scope:prefixes.scope,
    differentQuestionPrefixesBeforeEnd:prefixes.rows.reduce((n,r)=>n+r.earlierDifferentQuestionPrefixes,0),
    literalMatchingPrefixesBeforeEnd:prefixes.rows.reduce((n,r)=>n+r.literalMatchingPrefixesBeforeEnd,0),
    largestHostTextUpdateIntervalMs:Math.max(...prefixes.rows.map(r=>r.largestRetainedTextUpdateIntervalMs??0)),
    interpretation:'Literal nonmatch does not establish semantic invalidity. Question-text matching does not establish context identity. No speculative prefix is authorized for display or reuse.'},
  independentReview:{scope:'Assistant review of public questions, actual suggested code and NVIDIA event semantics. No physical CUDA execution or human interview certification.',
    round10:'The premature-overwrite trace is invalid: Q waits on both later done records on the same consumer streams, which remain ordered after both earlier A0 reads. A later record can add dependencies or create a cycle; it cannot remove those earlier reads under the stated stream order.',
    round12:'For the actual 256-lane shared reduction and N=3, stride 2 combines lane 0 with lane 2 to obtain zero; stride 1 adds lane 1 to obtain one. The answer substituted a sequential addition order. The exact/superaccumulator recommendation does not settle the requested actual trace.',
    codeContextFinding:'The old single code slot treated every closed fence as a replacement implementation. Later usage snippets could discard earlier definitions from a fresh answer context. The bounded chronological archive fixes that structural loss; this does not establish that context loss alone caused model failures.',
    reference:'https://docs.nvidia.com/cuda/archive/12.9.1/cuda-runtime-api/group__CUDART__EVENT.html',
    completeCodeCompilerCheck:compiler,
    usageSnippetLimitation:'Later snippets include ellipses and illustrative kernel names; compilation of rounds 2 and 3 does not certify those snippets.'},
  exactTranscriptReplay:replay.summary,
  replayIndependentReview:{
    round2:'The explanation says 4,096 blocks; ceil(1,048,579 / 256) is 4,097. Its host expression computes the correct count. This is an explanation error even without ASR.',
    round10:'Model examiner false positive: its correct grade accepts A1 C2 completion at time 6 while A0 C2 read ends at time 8. Both are ordered on C2; the stated schedule is impossible, and Q waits on both done events.',
    round12:'The actual stride-halving code remains in the bounded code archive, but the answer still claims lane 0 combines with lane 1 first. It produces one for this input. Preserving definitions and generic trace instructions did not fix this model error.',
    correctnessCertified:false},
  exactCounterexample:counterexample.summary,
  exactCounterexampleIndependentReview:'Low reasoning repeats schedules where B is the second incrementer, then wrongly declares the A-finalizing case impossible. Under the question’s operational assumptions, B block 1 can increment first and A block 0 second, making A finalize the mixed array. Actual unsynchronized CUDA code is not certified as race-free by an operational interleaving.',
  highReasoningDiagnostic:high.summary,
  highReasoningIndependentReview:'Under the stated operational assumptions, the answer correctly makes B block 1 publish index 1 and receive old=0, then A block 0 publish index 0 and receive old=1; A writes A0+B1 to its own output and resets the counter. A’s other block need not have run. This one successful trace is not general interview or CUDA runtime certification.',
  reasoningComparisonScope:'Same public exact question, binary and runtime sources; isolated transcript injection with candidate effort changed from low to high, still Luna Fast. Harness source metadata differs because effort became configurable. Single-case diagnostic, no general accuracy or latency conclusion; live settings stay low.',
  comparisonScope:'v47 precedes the code-history fix and stronger generic trace instruction. v48 uses exact public transcript injection and changed candidate answers; its latency cannot be compared directly with audio v47. No claim that prompts or context archive satisfy all difficult traces.',
  checks:{rustDefaultPassed:119,rustAcceptancePassed:120,rustIgnored:14,typescriptChecked:true},
  runtimeProfileRestoredSha256:await sha('.local/intent-encoder/profile.json'),
  agedWaitEnabledInRelease:false,diagnosticsEnabledInRelease:false,classifierEnabledInRelease:false,
  realMicrophoneInterruptionsTested:false,goalAchieved:false,
};
await writeFile('docs/evidence/prefix-experiment-v48.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({output:'docs/evidence/prefix-experiment-v48.json',audioMedianMs:fresh.summary.medianFirstWordMs,
  replayReviews:replay.summary.rows.map(r=>[r.round,r.modelReview?.verdict])}));
