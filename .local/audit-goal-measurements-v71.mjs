// Require the entire completed recording/review scope. Manual outcome labels
// remain descriptive; this collector cannot turn coverage into a behavior pass.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordedCohort} from './lib/recorded-cohort.mjs';
const [root='artifacts/deep-interview-v71',output]=process.argv.slice(2);assert(output);
const hash=value=>createHash('sha256').update(value).digest('hex'),evidence=[];
async function load(file){const bytes=await readFile(file);evidence.push({file,sha256:hash(bytes)});return JSON.parse(bytes);}
async function bind(source){const bytes=await readFile(source.file);assert.equal(hash(bytes),source.sha256,source.file+' changed');evidence.push(source);return bytes;}
const preparation=await load(root+'/preparation.json');
const attachment=preparation.sources.find(source=>path.resolve(source.file)===path.resolve(preparation.attachment));assert(attachment);
const specification=(await bind(attachment)).toString('utf8');
const numbered=[...specification.matchAll(/(?:^|\n)(\d+)\.\s/g)].map(match=>Number(match[1]));assert(numbered.length);
const mapping=await load('docs/evidence/attached-requirement-evidence-v71.json');
assert.deepEqual(mapping.requirements.map(entry=>entry.number),numbered,'Every attached numbered requirement needs evidence');
const audit=await load(root+'/review-cohort-audit.json');assert.equal(audit.status,'recorded_review_inputs_verified');
assert.equal(audit.pendingInputCohorts,0);assert.equal(audit.auditedInputCohorts,audit.expectedInputCohorts);
const published=await readFile('docs/evidence/full-independent-review-audit-v71.json');
assert.equal(hash(published),evidence.at(-1).sha256,'Published full review audit must match completed source audit');
evidence.push({file:'docs/evidence/full-independent-review-audit-v71.json',sha256:hash(published)});
const recorded=await recordedCohort(root),hourLatencies=await load('docs/evidence/all-trial-hour-word-latency-v71.json');
const hours=[];
for(const entry of recorded.hours){
 const reviewed=audit.cohorts.find(cohort=>path.resolve(cohort.file)===path.resolve(entry.file));assert(reviewed&&reviewed.kind==='elapsed_hour');
 const duration=await load(path.dirname(entry.file)+'/duration-audit.json');
 assert(duration.durationVerified);assert.equal(duration.requestedDurationMs,entry.requestedDurationMs);
 assert(duration.actualInterviewDurationMs>=entry.requestedDurationMs);assert.equal(duration.journalSha256,reviewed.journalSha256);
 const word=hourLatencies.hours.find(hour=>path.resolve(hour.file)===path.resolve(entry.file));assert(word);
 assert.equal(word.journalSha256,reviewed.journalSha256);assert.equal(word.turns,reviewed.turns);
 hours.push({name:entry.name,journalSha256:reviewed.journalSha256,actualDurationMs:duration.actualInterviewDurationMs,
  requestedDurationMs:entry.requestedDurationMs,turns:reviewed.turns,independentModelVerdicts:reviewed.independentModelVerdicts,
  firstRetainedVisibleWord:word.finiteObservedRetainedWordLatencyMs,allTrialWordP95:word.allRecordedTrialsRetainedWordP95,
  deliverySummary:reviewed.deliverySummary});
}
const covered=new Set(),requirements=[];
for(const entry of mapping.requirements){
 const cohorts=entry.cohorts.map(name=>{
  assert(!covered.has(name),'Duplicate requirement cohort');covered.add(name);
  const cohort=audit.cohorts.find(cohort=>cohort.name===name);assert(cohort);
  assert(['specified_probe','continuous_pressure_jobs'].includes(cohort.kind));
  return {name,kind:cohort.kind,journal:{file:cohort.file,sha256:cohort.journalSha256},
   turns:cohort.turns,independentModelVerdicts:cohort.independentModelVerdicts,cancelled:cohort.cancelled,errors:cohort.errors};
 });
 const links=[];for(const file of entry.evidence){await load(file);links.push(evidence.at(-1));}
 requirements.push({...entry,executionAndReviewCovered:true,cohorts,evidence:links});
}
assert.deepEqual([...covered].sort(),audit.cohorts.filter(cohort=>['specified_probe','continuous_pressure_jobs'].includes(cohort.kind)).map(cohort=>cohort.name).sort());
const pressure=await load('docs/evidence/continuous-pressure-measurements-v71.json');
assert(pressure.duration.durationVerified&&pressure.duration.stoppedCleanly);
assert(pressure.duration.actualInterviewDurationMs>=pressure.duration.requestedDurationMs);
const policy=await load('docs/evidence/matched-policy-controls-final-audit-v71.json');
const architecture=await load('docs/evidence/matched-architecture-controls-assessed-v71.json');
for(const control of [policy,architecture]){
 assert.equal(control.independentAccuracyPending,false);assert.equal(control.reviewAudit.status,'recorded_review_inputs_verified');
 assert.equal(control.reviewAudit.pendingOtherInputCohorts,0);
 assert.equal(control.rows.length,control.summaries.reduce((sum,group)=>sum+group.recordedTrials,0));
 for(const group of control.summaries)assert.equal(Object.values(group.independentModelVerdicts).reduce((a,b)=>a+b,0),group.recordedTrials);
}
const collector=fileURLToPath(import.meta.url);evidence.push({file:collector,sha256:hash(await readFile(collector))});
const result={recordedAt:new Date().toISOString(),status:'recording_and_review_scope_verified',
 configuration:{model:preparation.model,effort:preparation.effort,output:preparation.output,microphone:preparation.microphone},
 attachment,hours,requirements,reviewCohorts:audit.auditedInputCohorts,reviewJudgments:audit.auditedReviewCount,
 pressureDurationMs:pressure.duration.actualInterviewDurationMs,matchedControlSummaries:{policy:policy.summaries,architecture:architecture.summaries},
 allSpecifiedTestsExecutedAndReviewed:true,allRequiredProductBehaviorsDemonstrated:false,
 candidateUniversalImprovementEstablished:false,goalComplete:false,evidence,
 scope:'Completion of this measured recording/review scope is separate from achieving every required product behavior or the full thread goal. Manual findings and contradictions remain explicit. No universal correctness, latency, no-degradation, hardware or Git push success certificate is created.'};
await writeFile(output,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({output,status:result.status,hours:hours.length,attachedRequirements:requirements.length,reviewCohorts:result.reviewCohorts,reviewJudgments:result.reviewJudgments,allRequiredProductBehaviorsDemonstrated:false,goalComplete:false}));
