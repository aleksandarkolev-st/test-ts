// Evidence only; never imported by the runtime or used for semantic routing.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const read=async file=>{const raw=await readFile(file);return {file,sha256:sha(raw),data:JSON.parse(raw)};};
const native=async name=>{
 const directory=`artifacts/native-interview/${name}`;
 const r=await read(`${directory}/interview.json`);
 assert.equal(r.data.status,'complete');assert.equal(r.data.stoppedCleanly,true);
 assert.equal(r.data.rows.length,3);assert.equal(r.data.reviewAttemptLimit,1);
 assert(r.data.rows.every(row=>row.reviewSkipped&&row.preservesAllRecognizedClauses));
 const cadence=await read(`${directory}/intent-cadence-audit.json`);
 const input=await read(`${directory}/intent-stream-audit.json`);
 const stages=await read(`${directory}/latency-stage-audit.json`);
 assert.equal(cadence.data.source.sha256,r.sha256);assert.equal(input.data.source.sha256,r.sha256);
 const words=r.data.rows.map(row=>row.firstWordFromSpeechEndMs);assert(words.every(Number.isFinite));
 const sorted=[...words].sort((a,b)=>a-b);
 return {raw:r.data,evidence:{file:r.file,sha256:r.sha256,binarySha256:r.data.nativeBinarySha256,
  sourceHashes:r.data.sourceHashes,intentSourceHashes:r.data.intentSourceHashes,diagnosticSourceHashes:r.data.diagnosticSourceHashes,
  classifier:r.data.intentClassifier,speechConfiguration:r.data.speechConfiguration,
  firstWordMs:{values:words,mean:words.reduce((a,b)=>a+b,0)/words.length,median:sorted[1],max:sorted.at(-1)},
  cadence:{file:cadence.file,sha256:cadence.sha256,...cadence.data},
  inputSummary:{file:input.file,sha256:input.sha256,summary:input.data.summary},stages:stages.data.rows,
  answers:r.data.rows.map(row=>({round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,answer:row.answer,
   earlyInputs:row.intentEvents.filter(event=>event.name==='intent.early_input').map(event=>event.payload)}))}};
};
const baseline=await native('luna-quiet-cadence-baseline-v59');
const priority=await native('luna-quiet-cadence-priority-v60');
assert.equal(baseline.raw.nativeBinarySha256,priority.raw.nativeBinarySha256);
assert.deepEqual(baseline.raw.sourceHashes,priority.raw.sourceHashes);
assert.deepEqual(baseline.raw.intentSourceHashes,priority.raw.intentSourceHashes);
assert.deepEqual(baseline.raw.diagnosticSourceHashes,priority.raw.diagnosticSourceHashes);
assert.deepEqual(baseline.raw.speechConfiguration,priority.raw.speechConfiguration);
assert.equal(baseline.raw.intentClassifier.quietPriority,false);assert.equal(priority.raw.intentClassifier.quietPriority,true);
const {quietPriority:_,...a}=baseline.raw.intentClassifier,{quietPriority:__,...b}=priority.raw.intentClassifier;
assert.deepEqual(a,b);
assert.equal(a.threshold,.95);assert.equal(baseline.evidence.cadence.summary.quietPriorityBypasses,0);
assert(priority.evidence.cadence.summary.quietPriorityBypasses>0);
for(const [index,row] of baseline.raw.rows.entries()){
 assert.equal(row.question,priority.raw.rows[index].question);
 assert.equal(row.audio.sha256,priority.raw.rows[index].audio.sha256);
}
const role=await read('artifacts/native-interview/luna-prefix-gate-adaptive-v57/intent-role-ablation.json');
const previous=await read('artifacts/native-interview/luna-prefix-gate-adaptive-v57/intent-stream-audit.json');
assert.equal(role.data.auditSha256,previous.sha256);
const profile=sha(await readFile('.local/intent-encoder/profile.json'));
assert.equal(profile,sha(await readFile('.local/intent-encoder/profile.before-finetuned-v35.json')));
const release=await read('.local/latency-app-refresh-proof.json');
assert.equal(release.data.debug,false);assert.equal(release.data.active,false);assert.equal(release.data.settingsPreserved,true);
assert.equal(release.data.model,'gpt-6-luna');assert.equal(release.data.effort,'low');assert.equal(release.data.tier,'fast');
assert(release.data.output.includes('T24E390'));
assert.equal(release.data.binarySha256,sha(await readFile('src-tauri/target/release/meeting-copilot.exe')));
const result={scope:'Unpromoted CPU classification timing experiment. Three fixed public audio replays, not newly adaptive follow-ups or population latency/correctness certification. User edits, Luna Fast/low and Nemotron remain preserved.',
 metric:'First client-received alphanumeric character of retained decoded and validated answer, measured from speech end including capture/ASR. Rendering is separate; not full-word or sentence completion or pure model compute.',
 policy:'Opt-in acceptance/debug COPILOT_INTENT_QUIET_PRIORITY=1 permits one cadence bypass per acoustic pause for text stable at least 100 ms, while keeping normal 250 ms cadence otherwise. Only CPU classification is expedited. No prediction, intent, confirmation, one-job-per-floor or output gate is bypassed. No topic rules, canned replies or live context changes.',
 contextRoleDiagnostic:{file:role.file,sha256:role.sha256,scope:role.data.scope,identity:role.data.identity,summary:role.data.summary,skipped:role.data.skipped,
  fullRecognizedInputs:role.data.rows.filter(row=>row.exactFinalRecognizedText).map(row=>({round:row.round,originalReady:row.scores.ready,labeledReady:row.labeledResult.scores.ready})),
  conclusion:'Role labels lower the valid-float fragment from .9559 to .9459, but also push two complete recognized requests below .95. Bootstrap provenance is excluded. No evidence supports live context replacement without matching supervision.'},
 baseline:baseline.evidence,priority:priority.evidence,
 interpretation:'The priority path ran four times. The median first-word decrease does not establish a policy benefit: rounds 1/2 still waited for confirmation, round 1 ASR varied by 113 ms, and round 2 post-consumption latency varied by 761 ms. Both round-3 answers restarted once. ASR and generated histories differ despite identical waveforms and source; no observations are excluded.',
 correctnessScope:'Both runs start speculative work on setup before the final analysis request. Priority starts after a grammatically complete setup; its later conditions cannot serve as clairvoyant labels that the earlier words were incomplete. Hidden output waits for confirmation and then updates/restarts. These three answers do not verify deep code, corrections or real microphone interruptions, and no CUDA execution is claimed.',
 verification:{defaultRustPassed:123,defaultRustIgnored:14,acceptanceRustPassed:124,acceptanceRustIgnored:14,
  releaseBuild:'cargo build --release --features tauri/custom-protocol --bin meeting-copilot',
  releaseRefresh:{file:release.file,sha256:release.sha256,...release.data}},
 runtimeProfileRestoredSha256:profile,quietPriorityEnabledInRelease:false,classifierEnabledInRelease:false,goalAchieved:false};
await writeFile('docs/evidence/quiet-cadence-v60.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({output:'docs/evidence/quiet-cadence-v60.json',baselineMedian:baseline.evidence.firstWordMs.median,priorityMedian:priority.evidence.firstWordMs.median,goalAchieved:false}));
