// Experimental evidence only; no classifier promotion or runtime imports.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const record=async file=>{const raw=await readFile(file);return {file,sha256:sha(raw),data:JSON.parse(raw)};};
const diagnostic=async name=>{
 const r=await record(`artifacts/intent-classifier/${name}.json`);
 return {file:r.file,sha256:r.sha256,identity:r.data.identity,scope:r.data.scope,
  cases:r.data.rows.length,readyRequests:r.data.rows.filter(row=>row.request&&row.ready).length,
  thresholds:r.data.thresholds,latencyMs:r.data.latencyMs};
};
const oldDirectory='artifacts/native-interview/luna-capacity-intent-audit-v56';
const oldRun=await record(`${oldDirectory}/interview.json`);
assert.equal(oldRun.data.status,'failed');assert.equal(oldRun.data.stoppedCleanly,true);
assert.equal(oldRun.data.rows.length,1);assert.equal(oldRun.data.rounds,6);
const audit=await record(`${oldDirectory}/intent-stream-audit.json`);
assert.equal(audit.data.source.sha256,oldRun.sha256);
const ablation=await record(`${oldDirectory}/intent-context-ablation.json`);
assert.equal(ablation.data.sourceAuditSha256,audit.sha256);
const recovered=await record(`${oldDirectory}/round-01.review.json`);
const stages=await record(`${oldDirectory}/latency-stage-audit.json`);
assert.equal(stages.data.status,'failed');
const fp=await record('.local/intent-encoder/finetuned-prefix-v57/profile.fp32.json');
assert.equal(fp.data.exportPredictionDisagreements,0);assert(fp.data.maxExportLogitDifference<1e-3);
const training=await record('artifacts/intent-classifier/prefix-training-v57.json');
const validation=await record('artifacts/intent-classifier/prefix-validation-v57.json');
assert.equal(training.sha256,fp.data.trainingSha256);assert.equal(validation.sha256,fp.data.validationSha256);
const groups=new Set(training.data.cases.map(row=>row.sourceGroup));
assert.equal(groups.size,fp.data.trainingOriginalGroups);
assert(validation.data.cases.every(row=>!groups.has(row.sourceGroup)));
const profile=await readFile('.local/intent-encoder/profile.json');
assert.equal(sha(profile),sha(await readFile('.local/intent-encoder/profile.before-finetuned-v35.json')),'Restore original runtime profile first');
const newDirectory='artifacts/native-interview/luna-prefix-gate-adaptive-v57';
const native=await record(`${newDirectory}/interview.json`);
assert.equal(native.data.status,'complete');assert.equal(native.data.stoppedCleanly,true);
assert.equal(native.data.rows.length,native.data.rounds);
assert.equal(native.data.intentClassifier.profileSha256,fp.sha256);
assert.equal(native.data.intentClassifier.threshold,.95);
assert.equal(native.data.speechConfiguration.chunkMs,160);assert(native.data.outputDevice.includes('T24E390'));
const newAudit=await record(`${newDirectory}/intent-stream-audit.json`);
assert.equal(newAudit.data.source.sha256,native.sha256);
const newStages=await record(`${newDirectory}/latency-stage-audit.json`);
const newAblation=await record(`${newDirectory}/intent-context-ablation.json`);
assert.equal(newAblation.data.sourceAuditSha256,newAudit.sha256);
const finalDirectory='artifacts/native-interview/luna-prefix-gate-final-v58';
const final=await record(`${finalDirectory}/interview.json`);
assert.equal(final.data.status,'complete');assert.equal(final.data.stoppedCleanly,true);
assert.equal(final.data.rows.length,native.data.rows.length);
assert.equal(final.data.nativeBinarySha256,native.data.nativeBinarySha256);
assert.deepEqual(final.data.sourceHashes,native.data.sourceHashes);
assert.deepEqual(final.data.intentSourceHashes,native.data.intentSourceHashes);
assert.equal(final.data.intentMode,'final');
for(const key of ['backend','chunkMs','device','deviceName','remoteOnly'])assert.deepEqual(final.data.speechConfiguration[key],native.data.speechConfiguration[key]);
for(const [index,row] of native.data.rows.entries()){
 assert.equal(final.data.rows[index].question,row.question);
 assert.equal(final.data.rows[index].audio.sha256,row.audio.sha256);
}
const finalStages=await record(`${finalDirectory}/latency-stage-audit.json`);
const describe=rows=>{
 const words=rows.map(row=>row.firstWordFromSpeechEndMs);assert(words.every(Number.isFinite));
 const sorted=[...words].sort((a,b)=>a-b),middle=sorted.length/2;
 return {words,mean:words.reduce((a,b)=>a+b,0)/words.length,median:(sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(middle)])/2,min:sorted[0],max:sorted.at(-1)};
};
const expectedDistinct=(draws,p)=>-Math.expm1(draws*Math.log1p(-p));
const bins=1048576,lanes=32;
const uniform=bins*expectedDistinct(lanes,1/bins);
const skewed=expectedDistinct(lanes,.9)+(bins-1)*expectedDistinct(lanes,.1/(bins-1));
const release=await record('.local/latency-app-refresh-proof.json');
assert.equal(release.data.debug,false);assert.equal(release.data.active,false);assert.equal(release.data.settingsPreserved,true);
assert.equal(release.data.model,'gpt-6-luna');assert.equal(release.data.effort,'low');assert.equal(release.data.tier,'fast');
assert(release.data.output.includes('T24E390'));
assert.equal(release.data.binarySha256,sha(await readFile('src-tauri/target/release/meeting-copilot.exe')));
const result={scope:'Unpromoted classifier-prefix supervision experiment and native adaptive audio evidence. Synthetic assistant-reviewed labels and model grades are not human certification. No latency target or deep-interview correctness is certified.',
 metric:'Client receipt of first alphanumeric character of retained decoded and validated answer; speech-end metric includes capture/ASR. Rendering is separate, whole-sentence completion is not the primary metric.',
 previousPartialAudio:{file:oldRun.file,sha256:oldRun.sha256,status:oldRun.data.status,requestedRounds:6,recordedRounds:1,failure:oldRun.data.failure,
  audit:{file:audit.file,sha256:audit.sha256,summary:audit.data.summary},contextAblation:{file:ablation.file,sha256:ablation.sha256,summary:ablation.data.summary},
  stages:stages.data.rows,recoveredExaminer:{file:recovered.file,sha256:recovered.sha256,review:recovered.data.review,
   scope:'Examiner-only retry after original run stopped. Does not complete or resume the failed six-round interview.'}},
 supervision:{training:{file:training.file,sha256:training.sha256,cases:training.data.cases.length,groups:groups.size,
  ambiguousExcluded:training.data.ambiguousExcluded,overlapsExcluded:training.data.validationExactTextOverlapsExcluded,review:training.data.review},
  validation:{file:validation.file,sha256:validation.sha256,cases:validation.data.cases.length,ambiguousExcluded:validation.data.ambiguousExcluded,review:validation.data.review},
  constraints:'Prefixes are character cuts, not recorded ASR corruption. No future words or source labels reach the signed-in Luna Fast/low labeler. Same-source prefixes never share a batch; every batch uses a fresh thread. Source groups stay disjoint; exact current-text overlaps are removed. Epoch and temperature use validation, so these validation results are diagnostics.'},
 model:{profileSha256:fp.sha256,trainedModel:fp.data.trainedModel,selectedEpoch:fp.data.selectedEpoch,
  temperature:fp.data.temperature,validationAccuracy:fp.data.validationAccuracy,maxExportLogitDifference:fp.data.maxExportLogitDifference,
  exportPredictionDisagreements:fp.data.exportPredictionDisagreements,promoted:false},
 diagnostics:{oldPrefixes:await diagnostic('old-prefix-validation-v57'),newPrefixes:await diagnostic('new-prefix-validation-v57'),
  oldOriginals:await diagnostic('old-original-validation-v57'),newOriginals:await diagnostic('new-original-validation-v57'),
  oldFreshLong:await diagnostic('old-fresh-long-heldout-v57'),newFreshLong:await diagnostic('new-fresh-long-heldout-v57')},
 policySelection:'The .95 native threshold was selected after inspecting fresh-long diagnostics. Those diagnostics are therefore not an untouched test of that threshold. The new native scenario is independently generated; no production threshold or model is changed. Group weighting, training distribution, epoch and calibration differ; no single-change causal claim.',
 adaptiveAudio:{file:native.file,sha256:native.sha256,model:native.data.model,effort:native.data.effort,tier:native.data.tier,
  classifier:native.data.intentClassifier,sourceHashes:native.data.sourceHashes,intentSourceHashes:native.data.intentSourceHashes,
  diagnosticSourceHashes:native.data.diagnosticSourceHashes,speechConfiguration:native.data.speechConfiguration,
  audit:{file:newAudit.file,sha256:newAudit.sha256,summary:newAudit.data.summary},stages:newStages.data.rows,
  contextAblation:{file:newAblation.file,sha256:newAblation.sha256,summary:newAblation.data.summary},
  firstWordTiming:describe(native.data.rows),
  rounds:native.data.rows.map(row=>({round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,answer:row.answer,
   firstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,fullRecognizedClauses:row.preservesAllRecognizedClauses,
   earlySends:row.intentEvents.filter(event=>event.name==='intent.early_sent').length,
   earlyInputs:row.intentEvents.filter(event=>event.name==='intent.early_input').map(event=>event.payload),
   examinerAttempts:row.examinerAttempts,review:row.review}))},
 finalOnlyControl:{file:final.file,sha256:final.sha256,firstWordTiming:describe(final.data.rows),stages:finalStages.data.rows,
  answers:final.data.rows.map(row=>({round:row.round,answer:row.answer,recognizedQuestion:row.recognizedQuestion})),
  scope:'Same binary/source, public questions, saved waveforms, Luna Fast/low, Nemotron 160 ms and monitor. Early run is adaptive with examiner calls between answers; final-only control is fixed replay without those calls. Generated histories and ASR can differ. No causal improvement or population p95 claim.'},
 independentReview:{scope:'Assistant review of supplied questions, recognized text and answers; arithmetic independently evaluated from the stated distributions. No complete CUDA program was supplied or executed in these six turns. Real microphone interruptions are excluded.',
  unsafeEarlyStart:'Round 3 started Luna on a fragment ending valid float, before the bin specification or requested analysis was complete. Hidden output still waited for confirmation; one job start does not mean one paid inference turn (round 3 had four steers and five follow-ups).',
  trafficMisstatement:'Round 5 says the provided input-read bound excludes index reads, although index data are part of the supplied input reads. The question does not authorize excluding that array. Model examiner marked this answer correct; that grade is not independent certification.',
  arithmetic:{assumption:'Independent lane draws, as the answer explicitly assumes; this independence is not implied by a marginal index histogram alone.',
   method:'Each bin contributes 1-(1-p)^lanes, evaluated with -expm1(lanes*log1p(-p)) to avoid cancellation.',
   bins,lanes,hotProbability:.9,uniformDistinct:uniform,uniformAtomicsEliminated:lanes-uniform,
   skewedDistinct:skewed,skewedAtomicsEliminated:lanes-skewed,reportedSkewedDistinct:4.05,reportedSkewedAtomicsEliminated:27.95,
   conclusion:'Round 6 gives an appropriate formula under its assumption but evaluates the skewed case incorrectly. The model examiner also detects this failure.'},
  profilingReference:'https://docs.nvidia.com/nsight-compute/ComputeTriage/'},
 verification:{defaultRustPassed:121,defaultRustIgnored:14,acceptanceRustPassed:122,acceptanceRustIgnored:14,
  boundedExaminerRetryTestsPassed:2,releaseBuild:'cargo build --release --features tauri/custom-protocol --bin meeting-copilot',
  runtimeSourceSha256:sha(await readFile('src-tauri/src/runtime.rs')),releaseRefresh:{file:release.file,sha256:release.sha256,...release.data}},
 runtimeProfileRestoredSha256:sha(profile),classifierEnabledInRelease:false,goalAchieved:false};
await writeFile('docs/evidence/intent-prefix-v57.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({output:'docs/evidence/intent-prefix-v57.json',recordedRounds:result.adaptiveAudio.rounds.length,goalAchieved:false}));
