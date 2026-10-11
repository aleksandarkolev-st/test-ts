import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const reportFile='docs/evidence/deep-interview-results-v70.json';
const bytes=await readFile(reportFile),report=JSON.parse(bytes);
const attachment=await readFile(report.objective.attachment);
assert.equal(hash(attachment),report.objective.attachmentSha256);
const requiredIds=[...attachment.toString('utf8').matchAll(/^(\d+)\.\s/gm)].map(match=>Number(match[1]));
assert.deepEqual(report.requirements.map(row=>row.id),requiredIds);
assert.equal(report.status,'evaluation_recorded_and_verified');assert.equal(report.goalComplete,true);
assert.equal(report.pendingArtifacts.length,0);
assert.equal(report.hours.length,3);assert(report.hours.every(row=>row.durationMinutes>=60));
assert(report.hours.every(row=>row.actualDeliverySummary.allQuestionAndBackgroundWaveHashesValidated));
assert(report.hours.every(row=>row.actualDeliverySummary.shortestQuestions.some(question=>question.question==='Why?')));
assert(report.hours.every(row=>row.actualStreamingOverlapLaunches>0));
assert.equal(report.preferences.candidateModel,'gpt-6.1-sol');assert.equal(report.preferences.candidateEffort,'low');
assert.equal(report.preferences.output,'T24E390');assert.equal(report.preferences.microphoneUsed,false);
assert(report.pressure.durationMinutes>=30);
const failure=JSON.parse(await readFile('docs/evidence/independent-review-failure-resume-v70.json'));
for(const preserved of failure.preservedCachedSystemsReviews)assert.equal(hash(await readFile(preserved.file)),preserved.sha256);
const resumed=JSON.parse(await readFile('artifacts/deep-interview-v70/systems-hour-t/independent-model-review-v70/trial-016.json'));
assert.equal(resumed.inputSha256,failure.failure.inputSha256);
const consolidationSource='.local/consolidate-deep-interviews-v70.mjs';
const audit={recordedAt:new Date().toISOString(),report:{file:reportFile,sha256:hash(bytes)},
 consolidationSource:{file:consolidationSource,sha256:hash(await readFile(consolidationSource))},
 objectiveAttachmentSha256:hash(attachment),numberedRequirements:requiredIds,
 verifiedHours:report.hours.map(row=>({name:row.name,minutes:row.durationMinutes,turns:row.turns,
  firstWordMedianMs:row.firstRetainedVisibleWordMs.median,sampleP95Ms:row.firstRetainedVisibleWordMs.sampleP95,
  modelVerdicts:row.independentModelVerdicts,actualTopicFamilies:row.actualTopicFamilies.map(group=>group.topic)})),
 auditedReviewInputs:report.auditedReviewCount,pendingAssessments:report.pendingArtifacts.length,
 original15SystemsJudgmentsUnchanged:true,resumedGraderInputUnchanged:true,
 evaluationWorkComplete:true,productAssertionsAllPassed:false,
 scope:'The complete evaluation report and its 396 original recorded-input checks are verified. Source-bound selected execution and numerical checks remain separate from provisional model verdicts. Product display, memory and background-delivery failures remain results. No production fixes or universal code/accuracy certificate.'};
await writeFile('docs/evidence/deep-interview-completion-audit-v70.json',JSON.stringify(audit,null,2),{flag:'wx'});
console.log(JSON.stringify(audit));
