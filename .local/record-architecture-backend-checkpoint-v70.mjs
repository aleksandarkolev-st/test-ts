import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='artifacts/deep-interview-v70';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const load=async file=>{const bytes=await readFile(file);return {file,sha256:hash(bytes),data:JSON.parse(bytes)};};
const sources=[];
const bound=async file=>{const record=await load(file);sources.push({file,sha256:record.sha256});return record.data;};
const queue=await bound('docs/evidence/refinement-queue-analysis-v70.json');
const systems=await bound('docs/evidence/completed-systems-recording-v70.json');
const routing=await bound('docs/evidence/backend-routing-differences-v70.json');
const runtime=await bound('docs/evidence/backend-runtime-findings-v70.json');
const timing=await bound('docs/evidence/no-tier-backend-request-timing-v70.json');
const pressure=await bound('docs/evidence/pressure-continuation-and-background-v70.json');
const stale=await bound('docs/evidence/pressure-stale-display-v70.json');
for(const [file,expected] of Object.entries(routing.sourceHashes)){
 assert.equal(hash(await readFile(file)),expected,`Architecture source changed: ${file}`);
}
assert.equal(hash(await readFile(queue.source.file)),queue.source.sha256);
const hours=[];
for(const name of ['algorithms-hour-t','systems-hour-t','general-hour-t']){
 const directory=root+'/'+name;
 const duration=await bound(directory+'/'+(name==='algorithms-hour-t'?'duration-audit-unassigned-turn-fix.json':'duration-audit.json'));
 const assessment=await bound(directory+'/independent-assessment-v70/assessment.json');
 assert.equal(assessment.journal.sha256,duration.journalSha256);
 assert(duration.status==='complete'&&duration.stoppedCleanly&&duration.durationVerified);
 assert(duration.actualInterviewDurationMs>=duration.requestedDurationMs);
 assert.equal(assessment.model,'gpt-6.1-sol');assert.equal(assessment.effort,'low');
 assert.equal(assessment.rows.length,duration.rows.length);
 const verdicts={correct:0,incorrect:0,incomplete:0,unverified:0};
 for(const [index,row] of assessment.rows.entries()){
  const review=await load(directory+'/independent-model-review-v70/trial-'+String(index+1).padStart(3,'0')+'.json');
  assert.equal(review.sha256,row.independentReviewSha256);
  assert.equal(review.data.model,'gpt-6.1-sol');assert.equal(review.data.effort,'low');
  assert.equal(review.data.inputSchemaVersion,3);assert.equal(review.data.reviewerContinuity,false);
  assert.deepEqual(review.data.review,row.independentReview);
  assert(Object.hasOwn(verdicts,review.data.review.verdict));verdicts[review.data.review.verdict]++;
 }
 hours.push({name,minutes:duration.actualInterviewDurationMs/60000,turns:duration.rows.length,
  firstRetainedVisibleWordMs:duration.summary.firstRetainedVisibleWordMs,
  missingVisibleWords:duration.summary.turnsWithoutVisibleWord,cancelled:duration.summary.cancelled,
  errors:duration.summary.errors,independentModelVerdicts:verdicts,
  independentPhraseTimingAndDelivery:assessment.summary,
  resourceObservations:{native:duration.summary.nativeProcessResources,recorder:duration.summary.recordingProcessResources,
   nativeTree:duration.summary.nativeProcessTreeResources},
  descriptiveLatencyHalves:{first:duration.summary.firstHalfVisibleWordMs,second:duration.summary.secondHalfVisibleWordMs},
  orthographicSourceComparison:duration.summary.asr});
}
const hourVerdicts=Object.fromEntries(['correct','incorrect','incomplete','unverified'].map(key=>[key,hours.reduce((sum,row)=>sum+row.independentModelVerdicts[key],0)]));
const progress=[];
for(const name of (await readdir(root+'/hard-probes',{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort()){
 const directory=root+'/hard-probes/'+name;
 const audit=await bound(directory+'/duration-audit.json');
 let reviews=[];try{reviews=(await readdir(directory+'/independent-model-review-v70')).filter(file=>/^trial-\d+\.json$/.test(file));}catch(error){if(error.code!=='ENOENT')throw error;}
 progress.push({name,recordedTurns:audit.rows.length,completedReviewRows:reviews.length});
}
const logFile=root+'/final-tail-path-resume-v70.jsonl';
const logBytes=await readFile(logFile);sources.push({file:logFile,sha256:hash(logBytes)});
const latestRunnerRecord=JSON.parse(logBytes.toString('utf8').trim().split(/\r?\n/).at(-1).replace(/^\uFEFF/,''));
const record={recordedAt:new Date().toISOString(),status:'partial_accuracy_reviews_pending',goalComplete:false,sources,
 configuration:{candidateModel:'gpt-6.1-sol',candidateEffort:'low',reviewerModel:'gpt-6.1-sol',reviewerEffort:'low',
  output:'T24E390',microphoneUsed:false,productionLogicChanged:false},
 architecture:{
  conclusion:'The measured tail includes delayed final-question updates in the application lifecycle. Source and trace identify a pending-update gate and a disabled refinement deadline on the second attempt. Backend choice also changes question detection and steering, so faster fixed-prompt responses do not establish better live behavior.',
  original77SecondTrace:queue.representativeTrace,
  hourReplica:systems.finalSlowTurnBinding,
  mechanisms:queue.references,
  distinctBackendRouting:routing.findings,
  nativeChatgptDetection:runtime.detectionFinding,
  transportCompatibility:runtime.transportDiagnosis,
  correctedHttpDeadline:runtime.correction.actualNormalAuthHttpClient,
  uncertainties:queue.uncertainties,
  interpretation:'Send-to-consumption measures when the app processes a matching consumption event. It is not a measured provider GPU or reasoning interval. Shared queue backpressure is a source-supported possibility, not an isolated cause.',
  displayAndBackgroundEvidence:['docs/evidence/streaming-topic-switch-v70.json','docs/evidence/pressure-stale-display-v70.json','docs/evidence/pressure-continuation-and-background-v70.json'],
  staleDisplayScope:stale.scope??null,backgroundScope:pressure.scope??null},
 backendFixedPromptTiming:{configuration:'Optional service_tier omitted in a separate comparison; original fast-tier failures preserved.',
  measurements:timing.summaries,pairs:timing.pairCounts,
  accuracyPending:true,
  scope:'12 captured questions, two dependent repetitions per route, same recognized question and captured context. Clock excludes authentication, thread preparation, ASR, live updates and native overlay. Native protocol differs. ChatGPT reports default; Codex does not report its actual tier.'},
 hours,allHourModelVerdicts:hourVerdicts,
 accuracyScope:'Provisional independent model judgments against intended source text. Selected executable/manual checks are separate. Honest clarification when code is absent can be content-correct while the app fails the memory requirement. Source spelling and symbol pronunciation have no independently verified phonetic ground truth. All missing, cancelled, incorrect, incomplete and unverified outcomes remain counted.',
 reviewProgress:{hardProbes:progress,latestRunnerRecord,runnerExecSession:70827,
  ownerLiveness:'This is a timestamped stage snapshot, not a current process-liveness assertion.'},
 remaining:['Finish hard-probe, pressure and backend reviews','Validate all source bindings and consolidate all ten requirements, accuracy, latency, resource and failure scopes'],
 recordingScope:'Playback-only synthetic speech on T24E390, microphone disabled. No answer-specific candidate rules or production behavior changes. No population accuracy certificate, latency target or hardware CUDA runtime certificate.'};
const file='docs/evidence/architecture-and-backend-checkpoint-v70.json';
await writeFile(file,JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({file,status:record.status,allHourModelVerdicts:hourVerdicts,hourTurns:hours.reduce((sum,row)=>sum+row.turns,0),hardProbeProgress:progress,latestRunnerRecord}));
