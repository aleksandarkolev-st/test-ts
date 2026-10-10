// Offline evidence only; never imported by the app or classifier.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const diagnostic=async name=>{
  const file=`artifacts/intent-classifier/${name}.json`,report=await read(file);
  return {file,sha256:await sha(file),scope:report.scope,identity:report.identity,latencyMs:report.latencyMs,thresholds:report.thresholds};
};
const model=async directory=>{
  const file=`.local/intent-encoder/${directory}/profile.json`,head=await read(file);
  return {profileSha256:await sha(file),trainedModel:head.trainedModel,trainingSha256:head.trainingSha256,
    validationSha256:head.validationSha256,trainingVariants:head.trainingVariants,trainingOriginalGroups:head.trainingOriginalGroups,
    selectedEpoch:head.selectedEpoch,temperature:head.temperature,validationLoss:head.validationLoss,
    validationAccuracy:head.validationAccuracy,maxExportLogitDifference:head.maxExportLogitDifference,
    exportPredictionDisagreements:head.exportPredictionDisagreements,promoted:false};
};
const audio=async name=>{
  const file=`artifacts/native-interview/${name}/interview.json`,run=await read(file);
  assert.equal(run.status,'complete');assert.equal(run.stoppedCleanly,true);
  assert.equal(run.speechConfiguration.chunkMs,160);assert(run.outputDevice.includes('T24E390'));
  assert(run.rows.every(row=>row.preservesAllRecognizedClauses));
  const values=run.rows.map(row=>row.firstWordFromSpeechEndMs);
  assert(values.every(value=>Number.isFinite(value)));
  const cpu=run.rows.flatMap(row=>row.intentEvents.filter(event=>event.name==='intent.predicted')
    .map(event=>event.payload.prediction.elapsedMs)).filter(Number.isFinite).sort((a,b)=>a-b);
  return {file,sha256:await sha(file),scope:run.measurement,binarySha256:run.nativeBinarySha256,
    sourceHashes:run.sourceHashes,intentSourceHashes:run.intentSourceHashes,
    speechConfiguration:run.speechConfiguration,acousticRefinements:run.acousticRefinements,
    backgroundSuppression:run.backgroundSuppression??'not recorded',classifier:run.intentClassifier??null,
    classifierElapsedMs:cpu.length?{count:cpu.length,median:cpu[Math.floor(cpu.length/2)],
      sampleP95:cpu[Math.floor((cpu.length-1)*.95)],max:cpu.at(-1)}:null,
    meanFirstWordMs:values.reduce((a,b)=>a+b,0)/values.length,
    rows:run.rows.map(row=>({round:row.round,firstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,
      firstWordFromLatestInputMs:row.firstWordFromLatestInputMs,
      asrFinalizationMs:row.latency.transcriptFinalAt-row.latency.speechStoppedAt,
      preservesRecognizedClauses:row.preservesAllRecognizedClauses,
      earlySends:row.intentEvents.filter(event=>event.name==='intent.early_sent').length,
      earlyUpdates:row.intentEvents.filter(event=>event.name==='intent.early_updated').length,
      review:row.review??null}))};
};
const initialEarly=await audio('luna-local-intent-finetuned-v35');
const initialFinal=await audio('luna-local-intent-finetuned-final-v36');
assert.equal(initialEarly.binarySha256,initialFinal.binarySha256);
assert.deepEqual(initialEarly.sourceHashes,initialFinal.sourceHashes);
assert.deepEqual(initialEarly.speechConfiguration,initialFinal.speechConfiguration);
const review=await read('artifacts/intent-classifier/reviewed-paired-training-v41.json');
const fpFile='.local/intent-encoder/finetuned-parity-v42/profile.fp32.json',fp=await read(fpFile);
assert.equal(fp.exportPredictionDisagreements,0);assert(fp.maxExportLogitDifference<1e-3);
const fresh=await audio('luna-fp32-adaptive-v43');
const replay=await audio('luna-fp32-final-replay-v44');
assert.equal(fresh.binarySha256,replay.binarySha256);
assert.deepEqual(fresh.sourceHashes,replay.sourceHashes);
assert.deepEqual(fresh.intentSourceHashes,replay.intentSourceHashes);
const rawFresh=await read(fresh.file),rawReplay=await read(replay.file);
assert.equal(rawFresh.rows.length,rawReplay.rows.length);
assert.equal(rawReplay.recordedReplay.length,rawFresh.rows.length);
for(let index=0;index<rawFresh.rows.length;index++){
  assert.equal(rawFresh.rows[index].question,rawReplay.rows[index].question);
  assert.equal(rawFresh.rows[index].audio.sha256,rawReplay.rows[index].audio.sha256);
}
for(const key of ['backend','chunkMs','device','deviceName','remoteOnly'])
  assert.deepEqual(fresh.speechConfiguration[key],replay.speechConfiguration[key]);
const original='.local/intent-encoder/profile.before-finetuned-v35.json';
assert.equal(await sha('.local/intent-encoder/profile.json'),await sha(original));
const result={scope:'Experimental learned readiness and native audio evidence. No promotion or demonstrated near-instant latency. Synthetic labels and model grades need independent review; real microphone interruptions are excluded.',
  metric:'Client receipt of first alphanumeric character of retained decoded and validated answer, measured from final speech end. Includes capture/ASR; rendering is separate. Does not wait for sentence completion.',
  training:{first:await model('finetuned-v35'),paired:await model('finetuned-v41'),
    pairedReview:review.review,correlatedVariants:'90 added variants belong to 30 matched episodes; source grouping does not make them independent situations.'},
  exportVerification:{int8:await model('finetuned-parity-v42'),fp32:{profileSha256:await sha(fpFile),trainedModel:fp.trainedModel,
    temperature:fp.temperature,validationLoss:fp.validationLoss,validationAccuracy:fp.validationAccuracy,
    maxExportLogitDifference:fp.maxExportLogitDifference,exportPredictionDisagreements:fp.exportPredictionDisagreements}},
  diagnostics:{initialValidation:await diagnostic('finetuned-validation-policy-v40'),
    freshLongForInitialModel:await diagnostic('finetuned-long-policy-v40'),
    pairedValidation:await diagnostic('paired-finetuned-validation-v41'),
    reusedLongForPairedModel:await diagnostic('paired-finetuned-long-diagnostic-v41'),
    fp32Validation:await diagnostic('fp32-validation-v42')},
  backgroundSuppression:'Disabled by default, including learned experiments. A complete imperative was classified as background above 0.95. Finalized inference never waits for this classifier. Debug COPILOT_INTENT_BACKGROUND_IGNORE=1 is a separate unpromoted experiment.',
  initialMatchedAudio:{early:initialEarly,finalOnly:initialFinal,conclusion:'Small four-turn replay; no causal benefit or population p95 established.'},
  unconditionalUpdates:await audio('luna-local-intent-coalesced-v37'),
  unconditionalMetadataIssue:'v37 top-level acousticRefinements=true reflected runtime, but speechConfiguration.acousticRefinements incorrectly recorded false. Fixed prospectively; raw artifact retained.',
  readinessGatedUpdates:await audio('luna-local-intent-ready-updates-v39'),
  freshAdaptive:fresh,finalOnlyReplay:replay,
  freshAccuracyReview:{scope:'Assistant review against intended public questions, recognized transcripts, and NVIDIA documentation. Not CUDA hardware execution or human certification.',
    countFailure:'Round 3: speech recognition lost completion-ratio notation; Luna asserted large counts instead of asking about the consequential ambiguity.',
    visibilityFailure:'Round 6: the answer did not establish a valid consumer-side visibility guarantee for the exact producer-fence/relaxed-legacy-atomic protocol. Model examiner marked it incomplete. Ordering and liveness caveats do not settle this question.',
    references:['https://docs.nvidia.com/cuda/archive/12.9.1/cuda-c-programming-guide/index.html#memory-fence-functions',
      'https://docs.nvidia.com/cuda/archive/12.9.1/cuda-c-programming-guide/index.html#atomic-functions',
      'https://docs.nvidia.com/cuda/archive/12.9.1/cuda-c-programming-guide/index.html#thread-hierarchy'],
    exactCodeThroughAudioCertified:false,realMicrophoneInterruptionsTested:false},
  comparisonScope:'The early run is freshly adaptive. Final-only replays its saved public questions/waveforms; follow-ups cannot adapt to final-only answers. Binary/source/ASR settings match, but early acoustic refinement policy intentionally differs. No population p95 claim.',
  checks:{rustPassed:116,rustIgnored:14,tokenBoundaryTestsPassed:3,fp32Utf8OversizeWorkerContractPassed:true},
  runtimeProfileRestoredSha256:await sha('.local/intent-encoder/profile.json'),classifierEnabledInRelease:false,goalAchieved:false};
await writeFile('docs/evidence/intent-gate-v44.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({output:'docs/evidence/intent-gate-v44.json',freshMeanMs:fresh.meanFirstWordMs,finalReplayMeanMs:replay.meanFirstWordMs,goalAchieved:false}));
