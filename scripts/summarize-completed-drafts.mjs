// Offline evidence only; never used to route requests or authorize output.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function load(name){
  const directory=`artifacts/native-interview/${name}`,file=`${directory}/interview.json`;
  const bytes=await readFile(file),report=JSON.parse(bytes);
  assert.equal(report.status,'complete');assert.equal(report.stoppedCleanly,true);
  assert.equal(report.model,'gpt-6-luna');assert.equal(report.effort,'low');assert.equal(report.tier,'fast');
  assert(report.realAudio&&report.outputDevice.includes('T24E390'));
  assert.equal(report.speechConfiguration.chunkMs,160);assert.equal(report.speechConfiguration.remoteOnly,true);
  assert(report.rows.every(row=>row.reviewSkipped&&row.preservesAllRecognizedClauses));
  const stages=JSON.parse(await readFile(`${directory}/latency-stage-audit.json`));
  const words=report.rows.map(row=>row.firstWordFromSpeechEndMs);assert(words.every(Number.isFinite));
  const ordered=[...words].sort((a,b)=>a-b);
  return {report,summary:{file,sha256:sha(bytes),binarySha256:report.nativeBinarySha256,
    sourceHashes:report.sourceHashes,intentSourceHashes:report.intentSourceHashes,diagnosticSourceHashes:report.diagnosticSourceHashes,
    classifier:report.intentClassifier,speechConfiguration:report.speechConfiguration,stageSummary:stages.summary,
    meanFirstWordMs:words.reduce((a,b)=>a+b,0)/words.length,
    medianFirstWordMs:(ordered[Math.floor((ordered.length-1)/2)]+ordered[Math.floor(ordered.length/2)])/2,
    rows:report.rows.map(row=>({round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,
      answer:row.answer,firstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,
      completedDraftReplacements:row.latency.pipeline.completedDraftReplacementCount,
      restarts:row.latency.pipeline.refinementRestartCount,
      followups:row.latency.pipeline.followupCount,
      latestInputSentAfterConfirmationMs:row.latency.pipeline.latestInputSent-row.latency.questionConfirmedAt}))}};
}
const baseline=await load('luna-completed-baseline-v54'),experiment=await load('luna-completed-experiment-v55');
for(const field of ['binarySha256','sourceHashes','intentSourceHashes','diagnosticSourceHashes','classifier'])
  assert.deepEqual(baseline.summary[field],experiment.summary[field]);
assert.equal(baseline.report.speechConfiguration.completedDraftReplacement,false);
assert.equal(experiment.report.speechConfiguration.completedDraftReplacement,true);
const {completedDraftReplacement:baselineFlag,...baselineSpeech}=baseline.summary.speechConfiguration;
const {completedDraftReplacement:experimentFlag,...experimentSpeech}=experiment.summary.speechConfiguration;
assert.deepEqual(baselineSpeech,experimentSpeech);
assert.equal(baseline.report.rows.length,experiment.report.rows.length);
for(let i=0;i<baseline.report.rows.length;i++){
  assert.equal(baseline.report.rows[i].question,experiment.report.rows[i].question);
  assert.equal(baseline.report.rows[i].audio.sha256,experiment.report.rows[i].audio.sha256);
}
assert(baseline.summary.rows.every(row=>row.completedDraftReplacements===0));
assert(experiment.summary.rows.some(row=>row.completedDraftReplacements===1),'The policy must actually be exercised');
assert(experiment.summary.rows.every(row=>row.completedDraftReplacements<=1),'Retirement cannot loop');
const original=sha(await readFile('.local/intent-encoder/profile.before-finetuned-v35.json'));
assert.equal(sha(await readFile('.local/intent-encoder/profile.json')),original);
const evidence={
  scope:'Same-build six-question public audio replay comparing completed provisional draft retirement. Questions cannot adapt to different answers; generated answer contexts can differ. No population latency estimate, CUDA execution or real microphone-interruption claim.',
  metric:'Client receipt of the first alphanumeric character of the retained decoded/validated answer, from speech end including ASR. Rendering and whole-answer completion are separate. Stages overlap and must not be summed.',
  policy:'Acceptance/debug COPILOT_REPLACE_COMPLETED_DRAFT=1 retires a terminal completed draft when the confirmed question or selected context differs and no update is pending. The existing single retry submits the explicit latest question, context and reference to a separate prepared thread; it cannot loop. Active streams and identical completed frames preserve their current behavior. No semantic keyword rules or expected answers are used.',
  baseline:baseline.summary,experiment:experiment.summary,
  experimentMinusBaselineMeanMs:experiment.summary.meanFirstWordMs-baseline.summary.meanFirstWordMs,
  result:'The median was essentially unchanged; the lower experimental mean includes disappearance of a baseline 6971 ms outlier whose post-consumption interval was 5570 ms. Two rounds exercised retirement, but the changed-thread answers still failed ordering requirements. This does not establish a general latency or accuracy benefit. No samples are discarded.',
  independentReview:{
    baselineRound4:'Submitting H2D before the CPU overwrite does not deterministically hold the copy until the overwrite. Its own explanation admits no such ordering edge.',
    experimentRound4:'The answer submits H2D first, then describes a not-yet-recorded gate as if it could hold that copy. Neither that call order nor waiting before a first event record establishes the claimed gate-before-copy edge.',
    round5Both:'Both answers claim a second gate record releases an existing wait on the first record. Later records do not retarget an existing CUDA event wait.',
    baselineRound6:'It finally records the gate behind a host function waiting on a CPU latch before submitting the copy-stream wait. Its dependency structure addresses the earlier missing-record error, assuming successful API calls and a CPU latch independent of unfinished CUDA work. No device execution or general callback-liveness certificate is claimed.',
    experimentRound6:'The final H2D submission comes after the overwrite, so that host call order can establish overwrite-before-copy. However, the answer invents an unspecified later gate-release mechanism and claims it releases a wait already capturing an earlier record. It does not supply the exact valid gate protocol it claims. Do not mistake the valid host submission order for validation of the gate mechanism.',
    eventSource:'https://docs.nvidia.com/cuda/archive/12.9.1/cuda-runtime-api/group__CUDART__EVENT.html',
    hostFunctionSource:'https://docs.nvidia.com/cuda/archive/12.9.1/cuda-runtime-api/group__CUDART__EXECUTION.html',
    scope:'Independent review of the recorded answers, not model grades or a population correctness estimate. Answers contain protocols rather than complete programs; no compiler or device execution claim.'},
  checks:{rustDefaultPassed:121,rustAcceptancePassed:122,rustIgnored:14,
    liveQuestionGrowthAndCompletedCorrectionPassed:true,liveCompletedRetirementCounterAsserted:true},
  classifierProfileRestoredSha256:original,policyEnabledInRelease:false,goalAchieved:false,
};
await writeFile('docs/evidence/completed-drafts-v55.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({baselineMeanMs:baseline.summary.meanFirstWordMs,experimentMeanMs:experiment.summary.meanFirstWordMs,
  replacements:experiment.summary.rows.map(row=>row.completedDraftReplacements)}));
