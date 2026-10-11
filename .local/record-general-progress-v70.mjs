import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const root='artifacts/deep-interview-v70';
const report=JSON.parse(await readFile(`${root}/requirements-progress-after-code-validation.json`));
report.recordedAt=new Date().toISOString();
const update=(id,fields)=>Object.assign(report.requirements.find(item=>item.id===id),fields);
update(6,{state:'midpoint_runtime_probe_queued',remaining:'Run the approximately halfway 1500ms pause probe and inspect the actual waveform, native completion and visible essential-condition handling. The earlier exact pause was near 37 percent of source speech.'});
update(10,{state:'pressure_source_display_background_and_drift_audits_complete_independent_model_review_pending',
 evidence:['docs/evidence/continuous-pressure-recording-v70.json','docs/evidence/pressure-audit-findings-v70.json',
  'docs/evidence/pressure-stale-display-v70.json','docs/evidence/pressure-continuation-and-background-v70.json',
  `${root}/continuous-pressure-t/pressure-source-coverage-audit.json`],
 remaining:'Run source-bound independent reviews for all 89 actual native jobs. Text retention does not establish answer delivery: five requests were ignored after merging a background no-reply instruction; stale-display failures are recorded.'});
update('hours',{state:'dsa_and_systems_hours_complete_general_hour_live',
 evidence:[`${root}/algorithms-hour-t/duration-audit-unassigned-turn-fix.json`,
  'docs/evidence/completed-systems-recording-v70.json',`${root}/general-hour-t/interview.json`],
 remaining:'Finish the current general hour, audit final turn states, delivery and topic coverage, execute deferred selected checks, and review all recordings independently.'});
update('chatgpt-backend-comparison',{state:'prepared_queued_after_measured_playback',
 evidence:[`${root}/backend-comparison-cases.json`,'src-tauri/examples/compare-answer-backends.rs',
  'docs/evidence/normal-auth-remote-only-capture-v70.json','.local/run-chatgpt-comparison-v70.ps1'],
 remaining:'Build the source-bound helper and record exact-model access, paired final-prompt trials and native matched playback if available. Then grade the recorded outputs. No model substitution or backend winner has been inferred.'});
update('architecture-audit',{state:'recorded_read_only_diagnosis_complete',
 evidence:['docs/evidence/answer-architecture-audit-corrected-v70.json','docs/evidence/refinement-queue-analysis-v70.json',
  'docs/evidence/systems-slow-turn-outcome-v70.json','docs/evidence/completed-systems-recording-v70.json'],
 finding:'The final-input queue and once-only retry contribute to measured tails. The 77.54-second systems turn later timed out. Consumption-event processing does not measure provider-internal GPU or queue time. Production logic is unchanged.'});
const generalFile=`${root}/general-hour-t/interview.json`,generalBytes=await readFile(generalFile),general=JSON.parse(generalBytes);
assert.equal(general.model,'gpt-6.1-sol');assert.equal(general.effort,'low');
assert(general.outputDevice.includes('T24E390')&&general.speechConfiguration.remoteOnly);
assert.equal(general.speechConfiguration.selfCapture.physicalMicrophoneUsed,false);
report.currentRecording={file:generalFile,sha256AtSnapshot:hash(generalBytes),status:general.status,
 model:general.model,effort:general.effort,output:general.outputDevice,recordedRows:general.rows.length,
 recordedErrors:general.rows.filter(row=>row.error).length,pollErrors:general.pollErrors.length,
 liveOwnerVerification:'This turn directly inspected queue PID 38624, tail PID 45956, recorder PID 47736 and native PID 33076. This file itself is not proof that a process remains live later.'};
report.generalContractSnapshot='docs/evidence/general-crt-entrypoint-snapshot-v70.json';
report.generalDeferredChecks=['.local/record-general-split-question-v70.mjs','.local/check-general-crt-v70.py','.local/check-general-numerical-v70.mjs'];
report.independentAccuracyComplete=false;report.goalComplete=false;
report.currentSourceHashes={};
for(const file of ['src-tauri/examples/compare-answer-backends.rs','src-tauri/examples/assess-recorded-interview.rs',
 'scripts/summarize-deep-audio-interview.mjs','.local/record-backend-playback-v70.mjs',
 'docs/evidence/normal-auth-remote-only-capture-v70.json','docs/evidence/general-crt-entrypoint-snapshot-v70.json']){
 report.currentSourceHashes[file]=hash(await readFile(file));
}
report.comparisonHelperBuildPending=true;
report.reportingContinuityGuardTestPassed=true;
report.scope='Current requirement ledger and source hashes. Historical completed evidence is retained; live source hashes and process verification are timestamped snapshots. New Rust provenance and cleanup changes are not yet compiled or executed. Deferred checks are not reported as passed. No answer-specific production rule or expected answer injection was added.';
await writeFile(`${root}/requirements-progress-after-general-probes-v70.json`,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({generalStatus:general.status,generalTurns:general.rows.length,goalComplete:false,independentAccuracyComplete:false,comparisonHelperBuildPending:true}));
