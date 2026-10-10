// Offline experimental evidence; never used for semantic routing or answers.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const read=async f=>JSON.parse(await readFile(f,'utf8'));
const sha=async f=>createHash('sha256').update(await readFile(f)).digest('hex');
async function load(name){
  const directory=`artifacts/native-interview/${name}`,file=`${directory}/interview.json`,r=await read(file);
  assert.equal(r.status,'complete');assert.equal(r.stoppedCleanly,true);
  assert.equal(r.model,'gpt-6-luna');assert.equal(r.effort,'low');assert.equal(r.tier,'fast');
  assert(r.realAudio&&r.outputDevice.includes('T24E390'));
  assert.equal(r.speechConfiguration.chunkMs,160);assert.equal(r.speechConfiguration.remoteOnly,true);
  assert(r.rows.every(x=>x.preservesAllRecognizedClauses));
  const audit=await read(`${directory}/provisional-prefix-audit.json`);
  const stages=await read(`${directory}/latency-stage-audit.json`);
  const words=r.rows.map(x=>x.firstWordFromSpeechEndMs).sort((a,b)=>a-b);
  assert(words.every(Number.isFinite));
  return {raw:r,summary:{file,sha256:await sha(file),binarySha256:r.nativeBinarySha256,
    sourceHashes:r.sourceHashes,intentSourceHashes:r.intentSourceHashes,diagnosticSourceHashes:r.diagnosticSourceHashes,
    classifier:r.intentClassifier,speechConfiguration:r.speechConfiguration,
    meanFirstWordMs:words.reduce((s,x)=>s+x,0)/words.length,
    medianFirstWordMs:(words[Math.floor((words.length-1)/2)]+words[Math.floor(words.length/2)])/2,
    stageSummary:stages.summary,
    rows:r.rows.map((x,i)=>({round:x.round,firstWordFromSpeechEndMs:x.firstWordFromSpeechEndMs,
      firstExactCandidateFromSpeechEndMs:audit.rows[i].firstExactCandidateFromSpeechEndMs,
      firstExactCandidateBeforeFinalAsrMs:audit.rows[i].firstExactCandidateBeforeFinalAsrMs,
      exactFinalContextReceived:Boolean(audit.rows[i].receivedFinalFrame),
      earlySends:x.intentEvents.filter(e=>e.name==='intent.early_sent').length,
      settledUpdates:x.intentEvents.filter(e=>e.name==='intent.settled_updated').map(e=>e.payload),
      restarts:x.latency.pipeline.refinementRestartCount??0,
      latestInputSentAfterConfirmationMs:x.latency.pipeline.latestInputSent-x.latency.questionConfirmedAt,
      modelReview:x.review??null}))}};
}
const fresh=await load('luna-transfer-frame-audit-v51');
const baseline=await load('luna-settled-baseline-v52');
const experiment=await load('luna-settled-experiment-v53');
assert.equal(baseline.summary.binarySha256,experiment.summary.binarySha256);
assert.deepEqual(baseline.summary.sourceHashes,experiment.summary.sourceHashes);
assert.deepEqual(baseline.summary.intentSourceHashes,experiment.summary.intentSourceHashes);
assert.deepEqual(baseline.summary.diagnosticSourceHashes,experiment.summary.diagnosticSourceHashes);
assert.deepEqual(baseline.summary.classifier,experiment.summary.classifier);
assert.equal(baseline.raw.rows.length,experiment.raw.rows.length);
assert.equal(baseline.raw.speechConfiguration.settledUpdate,false);
assert.equal(experiment.raw.speechConfiguration.settledUpdate,true);
for(let i=0;i<baseline.raw.rows.length;i++){
  assert.equal(baseline.raw.rows[i].question,experiment.raw.rows[i].question);
  assert.equal(baseline.raw.rows[i].audio.sha256,experiment.raw.rows[i].audio.sha256);
  assert(baseline.raw.rows[i].reviewSkipped&&experiment.raw.rows[i].reviewSkipped);
}
assert.equal(await sha('.local/intent-encoder/profile.json'),await sha('.local/intent-encoder/profile.before-finetuned-v35.json'));
const evidence={
  scope:'Fresh adaptive GPU transfer interview plus a two-question controlled public audio replay. No near-instant latency or deep-interview correctness demonstrated. Model grades require independent review; microphone interruptions and physical CUDA execution are excluded.',
  metric:'Client receipt of the first alphanumeric character in the retained decoded/validated answer from speech end, including ASR. Exact-candidate observations use actor receipt time, not submitted audio chunk timestamps. Rendering is separate; sentence completion is not measured.',
  fresh:fresh.summary,baseline:baseline.summary,experiment:experiment.summary,
  comparisonScope:'Matched binary, runtime sources, diagnostic sources, classifier and saved public waveforms; policy differs. Two descriptive samples, not a population p95 or a general causal estimate. Fixed replay questions cannot adapt to differing answers. Review calls are skipped between replay turns.',
  result:'The experimental policy was slower in both replay rounds: mean 2599 ms versus 2131.5 ms, a 467.5 ms increase. Round 1 sent the latest input 119 ms before confirmation but still took 2000 ms after consumption; round 2 still restarted pending work. These observations do not isolate a causal source of the regression. The policy remains disabled in release.',
  contextFix:'Current-floor suggestions are excluded from their own reference context. Earlier completed code and earlier visible unfinished answers remain available. Manual prompts are unchanged. Unit tests prove context stability under current draft growth/completion; no latency gain is attributed solely to this fix.',
  updatePolicy:'Acceptance/debug COPILOT_SETTLED_UPDATE=1 permits one stable exact-text update of an existing hidden speculative job per observed acoustic end. It cannot start a job or publish an unconfirmed answer. Final ASR and new speech still invalidate or correct work. No intent prediction is required for this update; the learned gate still controls initial speculative starts.',
  independentReview:{
    rounds5and6:'Both answers wait on gate before its first record, then claim a future record releases that wait. CUDA event waits capture state at the call; an unrecorded event captures no work. Later records do not change the existing wait, so the claimed overwrite-before-copy ordering is unproven. Round 6 acknowledges the rule but repeats the same invalid order.',
    source:'https://docs.nvidia.com/cuda/archive/12.9.1/cuda-runtime-api/group__CUDART__EVENT.html',
    readinessFailure:'An early request was started for the dependent phrase “before proposing a fix”. High readiness confidence did not imply that the request was complete.',
    noCompileClaim:'The six answers contain protocols rather than complete compilable programs; no compiler or CUDA-device execution certificate is claimed.'},
  checks:{rustDefaultPassed:121,rustAcceptancePassed:122,rustIgnored:14},
  classifierProfileRestoredSha256:await sha('.local/intent-encoder/profile.json'),
  classifierEnabledInRelease:false,settledUpdatesEnabledInRelease:false,goalAchieved:false,
};
await writeFile('docs/evidence/settled-update-v53.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({output:'docs/evidence/settled-update-v53.json',freshMedianMs:fresh.summary.medianFirstWordMs,
  baselineMeanMs:baseline.summary.meanFirstWordMs,experimentMeanMs:experiment.summary.meanFirstWordMs}));
