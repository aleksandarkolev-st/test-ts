import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const root='artifacts/deep-interview-v70';
const file=`${root}/systems-hour-t/interview.json`,bytes=await readFile(file),j=JSON.parse(bytes),index=15,r=j.rows[index];
const prior=j.rows.slice(0,index).map(p=>({question:p.question,round:p.round}));
const input={answer:r.answer??null,cancelled:r.cancelled??null,error:r.error??null,phase:r.phase??null,publicPriorContext:r.selectedContext??null,
 recognizedQuestion:r.recognizedQuestion??null,sourcePriorQuestions:prior,spokenQuestion:r.question??null};
const logFile=`${root}/final-tail-runs.jsonl`,log=await readFile(logFile),last=JSON.parse(log.toString().trim().split('\n').at(-1));
assert(last.event==='failed'&&last.stage==='recorded_interview_independent_reviews');
const cached=[];for(let i=0;i<15;i++){
 const f=`${root}/systems-hour-t/independent-model-review-v70/trial-${String(i+1).padStart(3,'0')}.json`,b=await readFile(f),v=JSON.parse(b);
 assert(v.model==='gpt-6.1-sol'&&v.effort==='low'&&v.reviewerContinuity===false);cached.push({file:f,sha256:hash(b),inputSha256:v.inputSha256});
}
const absentFile=`${root}/systems-hour-t/independent-model-review-v70/trial-016.json`;
let absent=false;try{await stat(absentFile);}catch(e){if(e.code!=='ENOENT')throw e;absent=true;}
assert(absent,'Record failure provenance before the missing review is resumed');
const report={recordedAt:new Date().toISOString(),journal:{file,sha256:hash(bytes)},failure:{stage:'independent_model_review',sourceRound:r.round,
 reviewerModel:'gpt-6.1-sol',reviewerEffort:'low',reviewerContinuity:false,inputSha256:hash(Buffer.from(JSON.stringify(input))),
 recordedTerminalError:'Codex answer timed out',terminalExecSession:76300,terminalExecExitCode:1,sourceLog:{file:logFile,sha256:hash(log)},
 missingCompletedReviewFile:absentFile,partialReviewerOutputSaved:false,
 scope:'The stderr was directly observed on the terminal exec session. The reviewer aborted before saving review 16. This is a grader failure, separate from the candidate recording outcomes; the helper did not retain any partial reviewer output.'},
 preservedCachedSystemsReviews:cached,existingDsaReviews:49,
 resume:{script:'.local/resume-final-reviews-v70.ps1',execSession:24407,ownerPid:2532,comparisonPidAtObservation:47984,
 order:['separate_no_tier_paired_requests','remaining_recorded_reviews_using_completed_caches','all_backend_reviews'],
 identicalRecordedInput:true,completedCandidateRecordingsReplayed:false,completedReviewsOverwritten:false},
 goalComplete:false,scope:'Records a terminal grader failure and the authorized cached continuation. No candidate answer, source waveform, model choice or accuracy verdict is replaced; reviewer retry is not an additional candidate trial.'};
await writeFile('docs/evidence/independent-review-failure-resume-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({failedReviewerRound:r.round,preservedSystemsReviews:cached.length,graderFailureDistinctFromCandidate:true}));
