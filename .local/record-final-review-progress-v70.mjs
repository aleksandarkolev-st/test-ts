import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='artifacts/deep-interview-v70',hash=b=>createHash('sha256').update(b).digest('hex');
const previous=JSON.parse(await readFile(`${root}/requirements-progress-after-general-probes-v70.json`));
const report=structuredClone(previous);report.recordedAt=new Date().toISOString();
const update=(id,fields)=>Object.assign(report.requirements.find(r=>r.id===id),fields);
update(6,{state:'midpoint_runtime_recording_and_audit_complete_independent_review_pending',evidence:['docs/evidence/midpoint-pause-recording-v70.json'],
 remaining:'Finish the source-bound independent model review. Actual 1500ms gap is at 48.10 percent of the voiced span; all recorded visible revisions and native completion follow the full source endpoint.'});
update('hours',{state:'all_three_hours_complete_independent_accuracy_reviews_running',evidence:[`${root}/algorithms-hour-t/duration-audit-unassigned-turn-fix.json`,
 'docs/evidence/completed-systems-recording-v70.json','docs/evidence/completed-general-recording-v70.json'],
 remaining:'Finish systems and general independent reviews, then consolidate all original-turn accuracy, primary word latency, missing/cancelled/error outcomes and resource observations.'});
update('chatgpt-backend-comparison',{state:'original_prompt_and_native_trials_complete_configuration_variant_queued',evidence:[`${root}/chatgpt-backend-comparison/complete.json`,
 `${root}/backend-playback-comparison/playback.json`,'docs/evidence/backend-runtime-findings-v70.json',`${root}/backend-comparison-no-tier-cases.json`,'.local/run-backend-no-tier-v70.ps1'],
 finding:'All original 24 ChatGPT final-prompt requests returned HTTP400. Untimed actual body reports Unsupported service_tier: fast; omitting that field accepts HTTP200. Native playback transcribed four waveforms but started zero ChatGPT question jobs. These are distinct failures, with no comparative answer-speed claim.',
 remaining:'Finish original independent reviews and native projections. The existing tail runner will then measure and grade separate matched no-tier final-prompt trials, retaining all original failed trials. No-tier HTTP200 diagnostic has not certified a complete answer.'});
update('architecture-audit',{state:'read_only_architecture_diagnosis_and_transport_audit_correction_recorded',evidence:['docs/evidence/refinement-queue-analysis-v70.json',
 'docs/evidence/completed-systems-recording-v70.json','docs/evidence/backend-runtime-findings-v70.json'],
 finding:'The 77.54s systems word follows 37.261s confirmation-to-final-input wait and 33.454s send-to-consumption-event wait; the response later timed out. Native ChatGPT intent detection and optional tier incompatibility are separately recorded. Earlier HTTP-deadline audit was incorrect: the unchanged normal-auth client already has 10s connect/120s total timeout.'});
report.completedHours=[];
for(const name of ['algorithms-hour-t','systems-hour-t','general-hour-t']){
 const file=`${root}/${name}/interview.json`,bytes=await readFile(file),j=JSON.parse(bytes);
 assert(j.status==='complete'&&j.stoppedCleanly&&j.model==='gpt-6.1-sol'&&j.effort==='low');
 assert(j.outputDevice.includes('T24E390')&&j.speechConfiguration.remoteOnly&&!j.speechConfiguration.selfCapture.physicalMicrophoneUsed);
 const directory=`${root}/${name}/independent-model-review-v70`;let count=0;
 try{count=(await readdir(directory)).filter(f=>/^trial-\d+\.json$/u.test(f)).length;}catch(e){if(e.code!=='ENOENT')throw e;}
 let assessment=null;try{const b=await readFile(`${root}/${name}/independent-assessment-v70/assessment.json`);assessment={sha256:hash(b),summary:JSON.parse(b).summary};}catch(e){if(e.code!=='ENOENT')throw e;}
 report.completedHours.push({file,sha256:hash(bytes),minutes:j.actualInterviewDurationMs/60000,turns:j.rows.length,independentReviewRowsAtSnapshot:count,assessment});
}
report.currentRecording=null;report.generalDeferredChecks=[];report.comparisonHelperBuildPending=false;
report.completedGeneralEvidence='docs/evidence/completed-general-recording-v70.json';
report.midpointEvidence='docs/evidence/midpoint-pause-recording-v70.json';
report.activeTail={log:`${root}/final-tail-runs.jsonl`,lastStage:JSON.parse((await readFile(`${root}/final-tail-runs.jsonl`,'utf8')).trim().split('\n').at(-1)),
 ownerPowerShellPid:45956,execSessionId:76300,scope:'PID and stage are timestamped observations, not future liveness guarantees. Do not restart completed recordings or overwrite partial review/comparison evidence.'};
report.independentAccuracyComplete=false;report.goalComplete=false;
report.scope='Updated requirement ledger after all candidate playback completed. General selected checks, delivery and midpoint runtime audit are complete. DSA independent assessment is complete; remaining independent reviews and the separate omitted-tier comparison are serially owned by the existing tail runner. Original failed requests remain preserved. No production fixes or expected-answer injection.';
await writeFile(`${root}/requirements-progress-during-final-reviews-v70.json`,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({hours:report.completedHours.map(({minutes,turns,independentReviewRowsAtSnapshot})=>({minutes,turns,independentReviewRowsAtSnapshot})),goalComplete:false}));
