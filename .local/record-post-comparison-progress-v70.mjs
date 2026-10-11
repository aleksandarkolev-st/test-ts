import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='artifacts/deep-interview-v70',hash=b=>createHash('sha256').update(b).digest('hex');
const previous=JSON.parse(await readFile(`${root}/requirements-progress-during-final-reviews-v70.json`)),report=structuredClone(previous);
report.recordedAt=new Date().toISOString();
const update=(id,fields)=>Object.assign(report.requirements.find(r=>r.id===id),fields);
report.completedHours=[];
for(const name of ['algorithms-hour-t','systems-hour-t','general-hour-t']){
 const directory=`${root}/${name}`,file=`${directory}/interview.json`,bytes=await readFile(file),j=JSON.parse(bytes);
 assert(j.status==='complete'&&j.stoppedCleanly&&j.model==='gpt-6.1-sol'&&j.effort==='low');
 let count=0;try{count=(await readdir(`${directory}/independent-model-review-v70`)).filter(f=>/^trial-\d+\.json$/u.test(f)).length;}catch(e){if(e.code!=='ENOENT')throw e;}
 let assessment=null;try{const b=await readFile(`${directory}/independent-assessment-v70/assessment.json`);assessment={sha256:hash(b),summary:JSON.parse(b).summary};}catch(e){if(e.code!=='ENOENT')throw e;}
 report.completedHours.push({file,sha256:hash(bytes),minutes:j.actualInterviewDurationMs/60000,turns:j.rows.length,independentReviewRowsAtSnapshot:count,assessment});
}
const complete=JSON.parse(await readFile(`${root}/chatgpt-backend-comparison-no-tier/complete.json`));assert.equal(complete.status,'complete');
const timingFile='docs/evidence/no-tier-backend-request-timing-v70.json',timingBytes=await readFile(timingFile),timing=JSON.parse(timingBytes);
update('chatgpt-backend-comparison',{state:'both_fixed_prompt_configurations_and_native_playback_complete_backend_accuracy_pending',
 evidence:[`${root}/chatgpt-backend-comparison/complete.json`,`${root}/backend-playback-comparison/playback.json`,
 'docs/evidence/backend-runtime-findings-v70.json',`${root}/chatgpt-backend-comparison-no-tier/complete.json`,timingFile],
 finding:'Original fast-tier trials retain 24 HTTP400 ChatGPT failures. The separate omitted-tier comparison produced 24 answers per route with no errors or observation cutoffs. ChatGPT first words were earlier in 23/24 pairs; request-clock medians are 3430.5ms ChatGPT and 5679.5ms Codex. Full-operation medians are 10301.5ms ChatGPT and 9451.5ms Codex. Accuracy and native end-to-end behavior are separate; the original native ChatGPT detector started zero jobs.',
 remaining:'Grade all original and omitted-tier fixed-prompt answers and native visible recordings, then consolidate the distinct scopes. Do not replace failed original trials with successful variants or infer a production winner from first-word latency.'});
update(5,{state:'exact_pause_recording_and_untouched_cuda_compilation_complete_model_review_pending',
 evidence:['docs/evidence/exact-pause-recordings-v70.json','docs/evidence/exact-pause-histogram-compile-v70.json',
 'docs/evidence/pressure-continuation-and-background-v70.json'],
 remaining:'Finish independent reviews; preserve the pressure-run obsolete-proposal display failure separately. Exact-pause code compiled and linked, with no NVIDIA device execution.'});
update('hours',{state:report.completedHours.every(h=>h.assessment)?'all_three_hour_independent_assessments_complete':'all_three_hours_complete_remaining_accuracy_reviews_live',
 evidence:report.completedHours.map(h=>h.file),remaining:'Consolidate all completed hour assessments, primary word timing, selected checks, resource and cutoff qualifications with the hard-probe and pressure results.'});
report.noTierRequestTiming={file:timingFile,sha256:hash(timingBytes),summaries:timing.summaries,pairCounts:timing.pairCounts,accuracyPending:true};
report.supplementalChecks=['docs/evidence/systems-finite-fold-check-v70.json','docs/evidence/exact-pause-histogram-compile-v70.json'];
report.accuracyQualifications=['docs/evidence/speech-source-accuracy-scope-v70.json'];
const failure=JSON.parse(await readFile('docs/evidence/independent-review-failure-resume-v70.json'));
for(const cached of failure.preservedCachedSystemsReviews)assert.equal(hash(await readFile(cached.file)),cached.sha256);
const resumed=JSON.parse(await readFile(`${root}/systems-hour-t/independent-model-review-v70/trial-016.json`));
assert.equal(resumed.inputSha256,failure.failure.inputSha256);assert.equal(resumed.reviewerContinuity,false);
assert.equal(resumed.reviewerSourceSha256,hash(await readFile('src-tauri/examples/assess-recorded-interview.rs')));
report.graderTimeoutResolved={sourceRound:16,sameRecordedInput:true,original15CachedSystemsReviewsUnchanged:true,validResumedVerdict:resumed.review.verdict,
 reviewerBinarySha256:resumed.reviewerBinarySha256,reviewerSourceSha256:resumed.reviewerSourceSha256,
 newAttemptOutputAndTransportStatusSaved:true,timeoutRetryBranchExecuted:false,
 scope:'The original grader failure remains recorded. One resumed request completed successfully. The generic bounded timeout-retry branch has compiled but has not been needed in the resumed run.'};
const logFile=`${root}/final-tail-resume-v70.jsonl`,log=await readFile(logFile,'utf8');
report.activeTail={log:logFile,lastStage:JSON.parse(log.trim().split('\n').at(-1)),ownerPowerShellPid:2532,execSessionId:24407,
 scope:'Timestamped stage snapshot. Verify the actual owner/process before waiting or resuming. Original failed tail and all caches remain preserved.'};
report.nextConsolidationWork=['Finish and verify all remaining hard-probe, pressure and backend model reviews',
 'Audit review input hashes, isolated history, candidate and reviewer model/effort and source/executable bindings',
 'Assemble all 10 requirement outcomes, the 3 completed hours and DSA checks, preserving failures and scope qualifications',
 'Report primary word timing separately from correctness, useful-phrase timing, errors, cancellations, missing jobs and source-audio ambiguities'];
report.independentAccuracyComplete=false;report.goalComplete=false;
report.scope='Current evidence after complete omitted-tier measurements and recovery from a terminal grader timeout. All original recordings and failed comparisons are preserved. Every judgment is source-bound and remains distinct from app requirement fulfillment; accurate missing-artifact clarification does not prove code memory retention. No candidate replay, production fixes or answer-specific rules.';
await writeFile(`${root}/requirements-progress-after-no-tier-trials-v70.json`,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({hours:report.completedHours.map(({turns,independentReviewRowsAtSnapshot,assessment})=>({turns,independentReviewRowsAtSnapshot,assessed:Boolean(assessment)})),pairedTrials:48,graderTimeoutResolved:true,goalComplete:false}));
