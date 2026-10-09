// Offline evidence only. Never imported by the application or intent worker.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const audio=async name=>read(`artifacts/native-interview/${name}/interview.json`);
const early=await audio('luna-local-intent-asr-trained-v33');
const final=await audio('luna-local-intent-asr-final-v34');
const lower=await audio('luna-local-intent-threshold-v32');
for(const run of [early,final,lower]){
  assert.equal(run.status,'complete');assert.equal(run.stoppedCleanly,true);
  assert.equal(run.speechConfiguration.chunkMs,160);
  assert(run.rows.every(row=>row.preservesAllRecognizedClauses));
}
assert.equal(early.nativeBinarySha256,final.nativeBinarySha256);
assert.deepEqual(early.sourceHashes,final.sourceHashes);
assert.deepEqual(early.intentSourceHashes,final.intentSourceHashes);
assert.deepEqual(early.recordedReplay,final.recordedReplay);
assert.deepEqual(early.speechConfiguration,final.speechConfiguration);
assert.equal(early.intentClassifier.profileSha256,await sha('.local/intent-encoder/profile.extended-asr-v33.json'));
const summarize=run=>({status:run.status,stoppedCleanly:run.stoppedCleanly,scope:run.measurement,
  binarySha256:run.nativeBinarySha256,sourceHashes:run.sourceHashes,intentSourceHashes:run.intentSourceHashes,
  classifier:run.intentClassifier??null,
  rows:run.rows.map(row=>({round:row.round,firstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,
    firstWordFromLatestInputMs:row.firstWordFromLatestInputMs,
    asrFinalizationMs:row.latency.transcriptFinalAt-row.latency.speechStoppedAt,
    preservesRecognizedClauses:row.preservesAllRecognizedClauses,
    earlyInputs:row.intentEvents.filter(event=>event.name==='intent.early_input').map(event=>event.payload.text),
    earlySends:row.intentEvents.filter(event=>event.name==='intent.early_sent').length})),
  meanFirstWordMs:run.rows.reduce((sum,row)=>sum+row.firstWordFromSpeechEndMs,0)/run.rows.length});
const diagnostic=async name=>{
  const report=await read(`artifacts/intent-classifier/${name}.json`);
  return {scope:report.scope,identity:report.identity,latencyMs:report.latencyMs,thresholds:report.thresholds};
};
const head=await read('.local/intent-encoder/profile.extended-asr-v33.json');
const training=await read('artifacts/intent-classifier/extended-asr-training-v33.json');
const originals=await read('artifacts/intent-classifier/combined-training-v33.json');
const validation=await read('artifacts/intent-classifier/asr-validation-v33.json');
assert.equal(await sha('.local/intent-encoder/profile.json'),await sha('.local/intent-encoder/profile.before-extended-v33.json'));
const long=await read('artifacts/intent-classifier/long-training-v33.json');
const counts=long.cases.map(row=>row.text.trim().split(/\s+/u).length);
const result={scope:'Experimental readiness work. No classifier promotion, no demonstrated audio latency gain, no population p95 or correctness certification. Assistant-reviewed synthetic labels are not human certification.',
  matchedAudio:{sameBinarySourcesWaveformsAndSpeechConfiguration:true,learned:summarize(early),finalOnly:summarize(final),
    conclusion:'Two early sends, including the incomplete fragment "what exact". The learned gate was not faster on average in this four-turn run. All recognized final clauses were retained. No causal benefit or population statistic is established.'},
  lowerThresholdBeforeContextFix:summarize(lower),
  training:{profileSha256:await sha('.local/intent-encoder/profile.extended-asr-v33.json'),
    trainingSha256:head.trainingSha256,validationSha256:head.validationSha256,
    originalCases:originals.cases.length,augmentedVariants:training.cases.length,validationCases:validation.cases.length,
    validationLoss:head.validationLoss,augmentationScope:training.scope,
    generatorLengthFailure:{requestedReadyAndBackgroundWords:[50,110],requestedUnfinishedWords:[20,70],
      observedMeanWords:counts.reduce((a,b)=>a+b,0)/counts.length,observedMaxWords:Math.max(...counts),
      observedCasesAtLeast50Words:counts.filter(count=>count>=50).length},
    promoted:false},
  validation:await diagnostic('extended-asr-validation-v33'),
  reusedDiagnostic:await diagnostic('extended-asr-diagnostic-v33'),
  alternatives:{jointFreshHeldout:await diagnostic('joint-heldout-v31'),
    jointValidation:await diagnostic('joint-validation-v31'),
    neuralJointValidation:await diagnostic('joint-mlp-validation-v31'),promoted:false},
  contextFix:'Exclude this acoustic floor\'s own answer draft, retain previous answers even after a current answer completes, and retain other-speaker corrections on the current floor. Full Luna code context is preserved.',
  checks:{rustPassed:114,rustIgnored:14,utf8OversizeWorkerContractPassed:true},
  runtimeProfileRestoredSha256:await sha('.local/intent-encoder/profile.json'),
  classifierEnabledInRelease:false,goalAchieved:false};
await writeFile('docs/evidence/intent-gate-v34.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({output:'docs/evidence/intent-gate-v34.json',earlyMeanMs:result.matchedAudio.learned.meanFirstWordMs,finalOnlyMeanMs:result.matchedAudio.finalOnly.meanFirstWordMs,goalAchieved:false}));
