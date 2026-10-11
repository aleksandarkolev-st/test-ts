// Run only after measured playback and deferred independent reviews finish.
// Verify every recorded review input; retain all outcomes and source files.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,access} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {recordedCohort} from './lib/recorded-cohort.mjs';
const root=process.argv[2]??'artifacts/deep-interview-v71',sources=new Map(),cohorts=[];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function load(file){const bytes=await readFile(file);sources.set(path.resolve(file),{file,sha256:digest(bytes)});return JSON.parse(bytes);}
async function fileHash(file){
 const known=sources.get(path.resolve(file));if(known)return known.sha256;
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 const sha256=hash.digest('hex');sources.set(path.resolve(file),{file,sha256});return sha256;
}
async function terminal(file,event){const rows=(await readFile(file,'utf8')).trim().replace(/^\uFEFF/,'').split('\n').map(JSON.parse);assert.equal(rows.at(-1).event,event);await fileHash(file);}
await terminal(root+'/recording-queue.jsonl','recordings_terminal');
const recorded=await recordedCohort(root);
const codeSelections=await load('docs/evidence/recorded-code-selections-v71.json');
await terminal(root+'/deferred-queue.jsonl','reviews_terminal');
const playback=await load(root+'/policy-playback/playback.json');assert.equal(playback.status,'complete');assert(playback.stoppedCleanly);
const controls=await load(root+'/policy-playback/manifest.json');assert.equal(playback.trials.length,controls.cases.length*controls.repetitions*controls.policies.length);
const inputs=[...recorded.hours];
for(const item of (await readdir(root+'/hard-probes',{withFileTypes:true})).filter(item=>item.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)))
 inputs.push({kind:'specified_probe',name:item.name,file:root+'/hard-probes/'+item.name+'/interview.json'});
inputs.push({kind:'continuous_pressure_jobs',name:'continuous-pressure-t',file:root+'/continuous-pressure-t/pressure-review-input.json'});
for(const trial of playback.trials)inputs.push({kind:'selected_policy_control',name:path.basename(trial.outputDirectory),file:trial.outputDirectory+'/interview.json'});
const architectureFile=root+'/architecture-comparison/comparison.json';
if(await access(architectureFile).then(()=>true,()=>false)){
 const architecture=await load(architectureFile);assert.equal(architecture.status,'complete');assert(architecture.stoppedCleanly);
 assert.equal(architecture.trials.length,controls.cases.length*controls.repetitions*architecture.variants.length);
 assert.equal(architecture.manifestSha256,await fileHash(root+'/policy-playback/manifest.json'));
 const protocol=await load(architecture.protocolTests.file);
 assert.equal(await fileHash(architecture.protocolTests.file),architecture.protocolTests.sha256);
 assert.equal(protocol.exitCode,0);assert.deepEqual(protocol.sourceChangedDuringCompilation,[]);
 assert.equal(protocol.sourceFingerprint,architecture.protocolTests.sourceFingerprint);
 assert.deepEqual(protocol.sourceFiles,architecture.candidateSourceFiles);
 assert.equal(architecture.build.exitCode,0);
 for(const log of [architecture.build.stdout,architecture.build.stderr])assert.equal(await fileHash(log.file),log.sha256);
 const combinations=new Set();
 for(const trial of architecture.trials){
  const combination=JSON.stringify([trial.caseIndex,trial.repetition,trial.variant]);assert(!combinations.has(combination),'Duplicate architecture trial');combinations.add(combination);
  assert(Number.isInteger(trial.caseIndex)&&trial.caseIndex>=0&&trial.caseIndex<controls.cases.length);
  assert(Number.isInteger(trial.repetition)&&trial.repetition>=0&&trial.repetition<controls.repetitions);
  assert(architecture.variants.some(variant=>variant.name===trial.variant));
  assert.equal(await fileHash(trial.recording),trial.journalSha256);assert.equal(await fileHash(trial.playback),trial.playbackSha256);
  inputs.push({kind:'selected_architecture_control',name:path.basename(path.dirname(trial.recording)),file:trial.recording});
 }
}
const verdictNames=['correct','incorrect','incomplete','unverified'];
const reviewerProvenance=new Map();
for(const entry of inputs){
 const directory=path.dirname(entry.file),journal=await load(entry.file),journalSha256=await fileHash(entry.file);
 assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
 for(const selection of codeSelections.checks.filter(check=>path.resolve(check.file)===path.resolve(entry.file))){
  assert.equal(selection.journalSha256,journalSha256);
  const check=await load(selection.outputDirectory+'/source-bound-check.json');
  assert.equal(check.journal.sha256,journalSha256);assert.equal(check.row.round,selection.round);
  assert.equal(check.row.exactSha256,selection.rowSha256);assert.equal(check.row.answerSha256,selection.answerSha256);
  assert.equal(await fileHash(check.code.file),check.code.sha256);
  if(check.oracle){assert.equal(await fileHash(check.oracle.file),check.oracle.sha256);assert.equal(check.oracle.sourceCodeSha256,check.code.sha256);}
  for(const log of Object.values(check.executionLogs))assert.equal(await fileHash(log.file),log.sha256);
 }
 if(journal.olderCodeProbe){
  const older=await load(directory+'/older-code-reference-audit.json');assert.equal(older.journal.sha256,journalSha256);
  assert.equal(older.recordedReference.sourceAnswerSha256,journal.olderCodeProbe.sourceAnswerSha256);
  assert.equal(older.probe.round,journal.olderCodeProbe.probeRound);
  const originalIndex=journal.rows.findIndex(row=>row.round===journal.olderCodeProbe.sourceRound);
  const probeIndex=journal.rows.findIndex(row=>row.round===journal.olderCodeProbe.probeRound);
  assert.equal(older.probe.interveningTurns,probeIndex<0?null:probeIndex-originalIndex-1);
 }
 assert.equal(journal.model,recorded.configuration.model);assert.equal(journal.effort,recorded.configuration.effort);assert(journal.outputDevice?.includes(recorded.configuration.output));
 if(journal.speechConfiguration){assert.equal(journal.speechConfiguration.remoteOnly,true);assert.equal(journal.speechConfiguration.selfCapture?.physicalMicrophoneUsed??journal.speechConfiguration.microphoneCapture?.physicalMicrophoneUsed,false);}
 const assessmentFile=directory+'/independent-assessment-v71/assessment.json',assessment=await load(assessmentFile);
 assert.equal(assessment.model,journal.model);assert.equal(assessment.effort,journal.effort);assert.equal(assessment.rows.length,journal.rows.length);
 if(assessment.journal)assert.equal(assessment.journal.sha256,journalSha256);
 else assert(assessment.evidence.some(source=>path.resolve(source.file)===path.resolve(entry.file)&&source.sha256===journalSha256));
 const verdicts=Object.fromEntries(verdictNames.map(name=>[name,0])),rows=[];
 for(const [index,row] of journal.rows.entries()){
  const reviewFile=directory+'/independent-model-review-v71/trial-'+String(index+1).padStart(3,'0')+'.json',record=await load(reviewFile);
  assert.equal(record.model,journal.model);assert.equal(record.effort,journal.effort);assert.equal(record.inputSchemaVersion,3);assert.equal(record.reviewerContinuity,false);
  assert.equal(record.trial,index+1);assert.equal(record.round,row.round??null);assert(verdictNames.includes(record.review.verdict));
  const input={answer:row.answer??null,cancelled:row.cancelled??null,error:row.error??null,phase:row.phase??null,
   publicPriorContext:row.selectedContext??null,recognizedQuestion:row.recognizedQuestion??null,
   sourcePriorQuestions:row.recordedSourcePriorQuestions??journal.rows.slice(0,index).map(prior=>({question:prior.question??null,round:prior.round??null})),spokenQuestion:row.question??null};
  assert.equal(record.inputSha256,digest(JSON.stringify(input)),reviewFile+' changed recorded input');
  const phrase=record.review.usefulPhrase;assert(phrase===null||(typeof phrase==='string'&&phrase.length>0&&(row.answer??'').includes(phrase)));
  const retained=assessment.rows[index];assert.equal(retained.independentReviewSha256,await fileHash(reviewFile));assert.deepEqual(retained.independentReview,record.review);
  for(const field of ['question','recognizedQuestion','answer','phase'])assert.equal(retained[field],row[field]);
  for(const attempt of record.reviewerAttempts??[]){const raw=await load(attempt.file);assert.equal(await fileHash(attempt.file),attempt.sha256);assert.equal(raw.inputSha256,record.inputSha256);assert.equal(raw.model,record.model);assert.equal(raw.effort,record.effort);assert.equal(raw.reviewerContinuity,false);}
  const key=record.reviewerBinarySha256+':'+record.reviewerSourceSha256;
  const provenance=reviewerProvenance.get(key)??{binarySha256:record.reviewerBinarySha256,sourceSha256:record.reviewerSourceSha256,judgments:0};provenance.judgments++;reviewerProvenance.set(key,provenance);
  verdicts[record.review.verdict]++;
  rows.push({trial:index+1,round:row.round,question:row.question,sourceQuestionSha256:digest(row.question??''),responseVersion:row.responseVersion,
   answerSha256:digest(row.answer??''),phase:row.phase,cancelled:row.cancelled??false,error:row.error??null,verdict:record.review.verdict,reviewFile,inputSha256:record.inputSha256});
 }
 let duration=null,architecture=null,delivery=null;
 if(entry.kind!=='continuous_pressure_jobs'){
  const compilation=await load(directory+'/code-review/nvcc-compilation-v71/compilation.json');assert.equal(compilation.journal.sha256,journalSha256);
  assert.equal(await fileHash(compilation.toolchain.file),compilation.toolchain.sha256);
  for(const block of compilation.blocks){
   assert.equal(await fileHash(block.code.file),block.code.sha256);
   for(const log of [block.stdout,block.stderr])assert.equal(await fileHash(log.file),log.sha256);
   if(block.object)assert.equal(await fileHash(block.object.file),block.object.sha256);
  }
  architecture=await load(directory+'/architecture-audit-v71.json');assert.equal(architecture.source.sha256,journalSha256);
  delivery=await load(directory+'/delivery-coverage-audit.json');assert.equal(delivery.journal.sha256,journalSha256);assert(delivery.summary.allQuestionAndBackgroundWaveHashesValidated);
  const visibility=await load(directory+'/interview-visibility-audit-v71.json');assert.equal(visibility.journal.sha256,journalSha256);
  assert.equal(visibility.windows.length,journal.rows.length);
  assert.equal(delivery.rows.length,journal.rows.length);
  for(const delivered of [...delivery.rows,...delivery.background])assert.equal(await fileHash(delivered.wave.file),delivered.wave.sha256);
 }
 if(entry.kind==='elapsed_hour'||entry.kind==='specified_probe'){
  duration=await load(directory+'/duration-audit.json');assert.equal(duration.journalSha256,journalSha256);
  if(entry.kind==='elapsed_hour'){assert(duration.durationVerified);assert.equal(duration.requestedDurationMs,entry.requestedDurationMs);assert(duration.actualInterviewDurationMs>=entry.requestedDurationMs);}
 }
 cohorts.push({...entry,journalSha256,turns:rows.length,independentModelVerdicts:verdicts,correctFractionOfAllRecordedRows:rows.length?verdicts.correct/rows.length:null,
  cancelled:rows.filter(row=>row.cancelled).length,errors:rows.filter(row=>row.error).length,
  durationMinutes:duration?.actualInterviewDurationMs/60000||null,primaryWordMeasurements:duration?.summary??architecture?.summary.all??assessment.summary,
  independentUsefulPhraseSummary:assessment.summary,deliverySummary:delivery?.summary??null,rows});
 globalThis.gc?.();
}
const totals=Object.fromEntries(verdictNames.map(verdict=>[verdict,cohorts.filter(cohort=>cohort.kind==='elapsed_hour').reduce((sum,cohort)=>sum+cohort.independentModelVerdicts[verdict],0)]));
const report={recordedAt:new Date().toISOString(),status:'recorded_review_inputs_verified',cohorts,allHourIndependentModelVerdicts:totals,
 auditedReviewCount:cohorts.reduce((sum,cohort)=>sum+cohort.turns,0),reviewerProvenance:[...reviewerProvenance.values()],sources:[...sources.values()],
 scope:'Every independent model review binds its original recorded question, recognized wording, public context, prior source questions and untouched answer. Cancelled, erroneous, incomplete and unverified rows remain in denominators. Correct fractions are descriptive provisional model judgments, not population estimates or executable correctness certificates. Useful-phrase timing excludes cancelled/error outcomes by the existing summarizer; primary first-word timing does not use accuracy filtering. Pressure timing uses native-job endpoints, while hour/control playback uses physical recorded endpoints. Selected policy controls are dependent diagnostic cases. Topic and ten-requirement coverage, substantive code checks, tail interpretation and final goal completion require separate source-bound audits.',
 goalComplete:false};
await writeFile(root+'/review-cohort-audit.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:root+'/review-cohort-audit.json',cohorts:cohorts.length,auditedReviewCount:report.auditedReviewCount,allHourIndependentModelVerdicts:totals}));
