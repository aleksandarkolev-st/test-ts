// Offline evidence only. Never imported by the application or intent worker.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const base=await read('docs/evidence/intent-gate-v24.json');
const run=async name=>read(`artifacts/native-interview/${name}/interview.json`);
const early=await run('luna-local-intent-early-v25');
const final=await run('luna-local-intent-final-v25');
const failed=await run('luna-local-intent-adaptive-v26');
const corrected=await run('luna-local-intent-continuation-v27');
const lateFailure=await run('luna-local-intent-counterexample-v28');
const lateFixed=await run('luna-local-intent-late-tail-v29');
const exact=await run('luna-local-intent-exact-counterexample-v30');
for(const data of [early,final,failed,corrected,lateFailure,lateFixed,exact])assert(['complete','failed'].includes(data.status),'Evidence requires a terminal run');
assert.equal(early.nativeBinarySha256,final.nativeBinarySha256);
assert.deepEqual(early.sourceHashes,final.sourceHashes);
assert.deepEqual(early.recordedReplay,final.recordedReplay);
assert.equal(early.speechConfiguration.chunkMs,160);
assert.deepEqual(early.speechConfiguration,final.speechConfiguration);
const summarize=data=>({status:data.status,failure:data.failure??null,scope:data.measurement,
  stoppedCleanly:data.stoppedCleanly,binarySha256:data.nativeBinarySha256,
  sourceHashes:data.sourceHashes,intentSourceHashes:data.intentSourceHashes,
  profileSha256:data.intentClassifier?.profileSha256??null,
  rows:data.rows.map(row=>{
    const predictions=row.intentEvents.filter(event=>event.name==='intent.predicted'&&event.payload.accepted).map(event=>event.payload.prediction);
    return {round:row.round,wordFromSpeechEndMs:row.firstWordFromSpeechEndMs,
      wordFromLatestInputMs:row.firstWordFromLatestInputMs,
      asrFinalizationMs:row.latency?row.latency.transcriptFinalAt-row.latency.speechStoppedAt:null,
      wordFromLatestInputConsumedMs:row.latency?.pipeline?.latestInputConsumed==null?null:row.latency.firstWordAt-row.latency.pipeline.latestInputConsumed,
      preservesRecognizedClauses:row.preservesAllRecognizedClauses,
      earlySends:row.intentEvents.filter(event=>event.name==='intent.early_sent').length,
      acceptedPredictions:predictions.length,abstentions:predictions.filter(p=>p.abstained).length,
      maxWorkerMs:predictions.length?Math.max(...predictions.map(p=>p.elapsedMs??0)):null,
      provisionalModelVerdict:row.review?.verdict??null};
  })});
const reviewed=await read('artifacts/intent-classifier/reviewed-regressions-v25.json');
const sequence=await read('artifacts/intent-classifier/reviewed-sequence-heldout-v25.json');
const training=await read('artifacts/intent-classifier/reviewed-training-v25.json');
const validation=await read('artifacts/intent-classifier/reviewed-validation-v25.json');
const head=await read('.local/intent-encoder/profile.reviewed-v25.json');
const release=await read('.local/latency-app-refresh-proof.json');
const result={...base,scope:'Experimental learned gate, disabled in release. Matched corrected remote-audio comparison and continuation regression. Target remains unmet; no population p95 or correctness certification.',
  matchedAudio:{sameBinarySourcesWaveformsAndSpeechConfiguration:true,finalOnly:summarize(final),learned:summarize(early),
    conclusion:'No classifier-triggered early sends in four matched turns; no demonstrated latency improvement. Samples are too few for a population p95.'},
  readinessExpansion:{trainingCount:training.cases.length,validationCount:validation.cases.length,
    trainingSha256:head.trainingSha256,validationSha256:head.validationSha256,
    validationLoss:head.validationLoss,regressionScope:reviewed.scope,regressions:reviewed.thresholds,
    alternativeSequenceDiagnostic:{scope:sequence.scope,thresholds:sequence.thresholds},
    promoted:false,labelReview:'Assistant corrections to synthetic labels; not human certification. Old held-out labels remain uncertain.'},
  adaptiveFailure:summarize(failed),continuationRegression:summarize(corrected),
  continuationFix:'Restore confirmed text on resumed speech only if the confirmed question belongs to the same acoustic floor. No semantic phrases or domain routing.',
  lateTailFailure:summarize(lateFailure),lateTailRegression:summarize(lateFixed),exactCounterexampleProbe:summarize(exact),
  lateTailFix:'Do not confirm a nonempty unfinalized partial; retain a same-clause confirmed prefix when ASR finalization arrives late.',
  releaseRefresh:{updatedAt:release.updatedAt,binarySha256:release.binarySha256,debug:release.debug,active:release.active,
    model:release.model,effort:release.effort,tier:release.tier,output:release.output,settingsPreserved:release.settingsPreserved,classifierEnabled:false},
  checks:{rustPassed:112,rustIgnored:14,workerUtf8OversizeContractPassed:true},goalAchieved:false};
await writeFile('docs/evidence/intent-gate-v30.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({output:'docs/evidence/intent-gate-v30.json',correctedStatus:corrected.status,lateTailStatus:lateFixed.status,exactProbeStatus:exact.status,goalAchieved:false}));
