// Consolidation validates recorded inputs and preserves negative outcomes.
// No candidate inference, answer rules, repairs, or performance thresholds.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root='artifacts/deep-interview-v70',final=process.argv.includes('--final'),auditExisting=final||process.argv.includes('--audit-existing');
assert(process.argv.slice(2).every(arg=>['--final','--snapshot','--audit-existing'].includes(arg)));
const attachment='C:/Users/polek/.codex/attachments/da3ba127-66ce-4d6d-817e-22210b6a9528/pasted-text-1.txt';
const sources=new Map(),pending=[],reviewerProvenance=new Map(),historicalPreparationSourceRevisions=[];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(file){
 const absolute=path.resolve(file),known=sources.get(absolute);if(known)return known.sha256;
 const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);
 const sha256=hash.digest('hex');sources.set(absolute,{file:file.replaceAll('\\','/'),sha256});return sha256;
}
async function load(file,optional=false){
 try{const bytes=await readFile(file);const sha256=digest(bytes);sources.set(path.resolve(file),{file:file.replaceAll('\\','/'),sha256});return {data:JSON.parse(bytes),sha256};}
 catch(error){if(optional&&error.code==='ENOENT'){pending.push(file);return null;}throw error;}
}
async function verifyPairs(pairs){
 for(const pair of pairs??[]){if(typeof pair.file==='string'&&typeof pair.sha256==='string')assert.equal(await fileHash(pair.file),pair.sha256,`Changed evidence: ${pair.file}`);}
}
const attachmentSha256=await fileHash(attachment);
const preferences={candidateModel:'gpt-6.1-sol',candidateEffort:'low',examinerModel:'gpt-6.1-sol',examinerEffort:'low',reviewerModel:'gpt-6.1-sol',reviewerEffort:'low',output:'T24E390',microphoneUsed:false,productionLogicChanged:false};
function assertConfiguration(data,examiner=false){
 assert.equal(data.model,preferences.candidateModel);assert.equal(data.effort,preferences.candidateEffort);
 const output=data.outputDevice??data.output;assert(typeof output==='string'&&output.includes('T24E390'));
 assert.equal(data.status,'complete');assert.equal(data.stoppedCleanly,true);
 if(examiner){assert.equal(data.examinerModel,preferences.examinerModel);assert.equal(data.examinerEffort,preferences.examinerEffort);}
 const speech=data.speechConfiguration;
 if(speech){assert.equal(speech.remoteOnly,true);assert.equal(speech.selfCapture?.physicalMicrophoneUsed??speech.microphoneCapture?.physicalMicrophoneUsed,false);}
}
async function auditReviewInput(directory,journal,assessment,backend=false){
 const counts={correct:0,incorrect:0,incomplete:0,unverified:0,missing:0};
 for(const [index,row] of journal.rows.entries()){
  const file=directory+'/trial-'+String(index+1).padStart(3,'0')+'.json';
  const record=await load(file,true);if(!record){counts.missing++;continue;}
  const reviewed=record.data;
  assert.equal(reviewed.model,preferences.reviewerModel);assert.equal(reviewed.effort,preferences.reviewerEffort);
  assert.equal(reviewed.inputSchemaVersion,3);assert.equal(reviewed.reviewerContinuity,false);
  assert.equal(reviewed.trial,index+1);assert.equal(reviewed.round,row.round??null);
  assert(Object.hasOwn(counts,reviewed.review.verdict)&&reviewed.review.verdict!=='missing');
  const input={answer:row.answer??null,cancelled:row.cancelled??null,error:row.error??null,phase:row.phase??null,
   publicPriorContext:row.selectedContext??null,recognizedQuestion:row.recognizedQuestion??null,
   sourcePriorQuestions:row.recordedSourcePriorQuestions??journal.rows.slice(0,index).map(prior=>({question:prior.question??null,round:prior.round??null})),spokenQuestion:row.question??null};
  assert.equal(reviewed.inputSha256,digest(JSON.stringify(input)),`Reviewer input mismatch: ${file}`);
  const phrase=reviewed.review.usefulPhrase;
  assert(phrase===null||(typeof phrase==='string'&&phrase.length>0&&(row.answer??'').includes(phrase)));
  for(const attempt of reviewed.reviewerAttempts??[]){
   const loaded=await load(attempt.file);assert.equal(loaded.sha256,attempt.sha256);
   assert.equal(loaded.data.inputSha256,reviewed.inputSha256);
   assert.equal(loaded.data.model,reviewed.model);assert.equal(loaded.data.effort,reviewed.effort);
   assert.equal(loaded.data.reviewerContinuity,false);
  }
  const key=reviewed.reviewerBinarySha256+':'+reviewed.reviewerSourceSha256;
  const provenance=reviewerProvenance.get(key)??{binarySha256:reviewed.reviewerBinarySha256,sourceSha256:reviewed.reviewerSourceSha256,judgments:0};
  provenance.judgments++;reviewerProvenance.set(key,provenance);
  if(assessment){
   const retained=assessment.rows[index];assert(retained);
   assert.equal(retained.independentReviewSha256,record.sha256);
   assert.deepEqual(retained.independentReview,reviewed.review);
   assert.equal(retained.answer,row.answer);
   if(!backend)assert.equal(retained.question,row.question);
  }
  counts[reviewed.review.verdict]++;
 }
 if(assessment)assert.equal(assessment.rows.length,journal.rows.length);
 return counts;
}
const hours=[],hardProbes=[];
const dsaTopics=(await load('docs/evidence/delivery-and-topic-coverage-v70.json')).data.dsaTopicAnnotations;
const generalTopics=(await load('docs/evidence/completed-general-recording-v70.json')).data.manuallyAnnotatedActualTopicFamilies;
const systemsTopics=[
 {topic:'GPU investigation, kernel synchronization, reductions, histograms and memory layout',rounds:[1,2,3,4,8,9,10,11,12,13,14,15,16,25,26,29,37,38,49,50]},
 {topic:'Diagnostic probability and dependence between tests',rounds:[5,6,7]},
 {topic:'Error-correcting codes, interpolation, corruption and ambiguity',rounds:[17,18,19,20,21,22,23,24]},
 {topic:'C++20 publication, memory ordering and concurrent ownership',rounds:[27,28,30,31]},
 {topic:'Durable transfers, deduplication, retirement and fencing',rounds:[32,33,34,35,36,39,40]},
 {topic:'RSA common-modulus algebra and nonunique message recovery',rounds:[41,42,43]},
 {topic:'PostgreSQL booking transactions, lock ordering and exclusion constraints',rounds:[44,45,46,47,48]},
 {topic:'Raft elections and commitment rules',rounds:[51,52]},
 {topic:'Combinatorial optimization',rounds:[53]}
];
const hardNames=(await readdir(root+'/hard-probes',{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort();
for(const name of ['algorithms-hour-t','systems-hour-t','general-hour-t',...hardNames.map(name=>'hard-probes/'+name)]){
 const directory=root+'/'+name;
 const duration=await load(directory+'/'+(name==='algorithms-hour-t'?'duration-audit-unassigned-turn-fix.json':'duration-audit.json'));
 const audit=duration.data;assertConfiguration(audit,!name.startsWith('hard-probes/'));
 assert.equal(await fileHash(directory+'/interview.json'),audit.journalSha256);
 let delivery=null,topics=null;
 if(!name.startsWith('hard-probes/')){
  delivery=(await load(directory+'/delivery-coverage-audit.json')).data;
  assert.equal(delivery.journal.sha256,audit.journalSha256);
  assert.equal(delivery.summary.allQuestionAndBackgroundWaveHashesValidated,true);
  assert.equal(delivery.rows.length,audit.rows.length);
  for(const [index,row] of delivery.rows.entries()){
   assert.equal(row.question,audit.rows[index].question);assert.equal(row.round,audit.rows[index].round);
   assert.equal(await fileHash(row.wave.file),row.wave.sha256);
  }
  if(name==='algorithms-hour-t')topics=dsaTopics.map(group=>({topic:group.topic,rounds:group.sourceRows.map(row=>row.round)}));
  if(name==='general-hour-t')topics=generalTopics.map(group=>({topic:group.name,rounds:group.rounds}));
  if(name==='systems-hour-t')topics=systemsTopics;
  assert.deepEqual([...new Set(topics.flatMap(group=>group.rounds))].sort((a,b)=>a-b),audit.rows.map(row=>row.round));
  if(name==='algorithms-hour-t')for(const group of dsaTopics)for(const source of group.sourceRows){
   const actual=audit.rows.find(row=>row.round===source.round);assert.equal(source.question,actual.question);
   assert.equal(source.sourceQuestionSha256,digest(source.question));
  }
  if(name==='general-hour-t')for(const group of generalTopics)for(const source of group.sourceQuestions)assert.equal(source.question,audit.rows.find(row=>row.round===source.round).question);
 }
 const assessment=await load(directory+'/independent-assessment-v70/assessment.json',true);
 let verdicts=null;
 if(assessment){
  assert.equal(assessment.data.journal.sha256,audit.journalSha256);
  assert.equal(assessment.data.model,preferences.candidateModel);assert.equal(assessment.data.effort,preferences.candidateEffort);
 }
 if(auditExisting){
  const journal=(await load(directory+'/interview.json')).data;
  assertConfiguration(journal,!name.startsWith('hard-probes/'));
  verdicts=await auditReviewInput(directory+'/independent-model-review-v70',journal,assessment?.data);
  assert.equal(journal.rows.length,audit.rows.length);
 }else if(assessment){
  verdicts=Object.fromEntries(['correct','incorrect','incomplete','unverified','missing'].map(verdict=>[verdict,assessment.data.rows.filter(row=>(row.independentReview?.verdict??'missing')===verdict).length]));
 }
 const record={name,journalSha256:audit.journalSha256,durationMinutes:audit.actualInterviewDurationMs/60000,turns:audit.rows.length,
  firstRetainedVisibleWordMs:audit.summary.firstRetainedVisibleWordMs??audit.summary.firstVisibleWordMs,
  missingVisibleWords:audit.summary.turnsWithoutVisibleWord,cancelled:audit.summary.cancelled,errors:audit.summary.errors,
  independentModelVerdicts:verdicts,independentUsefulPhraseSummary:assessment?.data.summary??null,
  sourceQuestions:audit.rows.map(row=>({round:row.round,question:row.question})),
  actualTopicFamilies:topics,topicAnnotationScope:topics?'Manual grouping of actual played source questions; not random population sampling.':null,
  actualDeliverySummary:delivery?.summary??null,
  actualStreamingOverlapLaunches:audit.summary.actualStreamingOverlapLaunches,
  lexicalSourceComparison:audit.summary.asr,
  resourceSamples:{native:audit.summary.nativeProcessResources,recorder:audit.summary.recordingProcessResources,nativeTree:audit.summary.nativeProcessTreeResources},
  descriptiveHalves:{first:audit.summary.firstHalfVisibleWordMs,second:audit.summary.secondHalfVisibleWordMs}};
 if(name.startsWith('hard-probes/'))hardProbes.push(record);else{assert(audit.durationVerified&&audit.actualInterviewDurationMs>=audit.requestedDurationMs);hours.push(record);}
 globalThis.gc?.();
}
const pressureRecording=await load('docs/evidence/continuous-pressure-recording-v70.json');
const pressureTiming=await load(root+'/continuous-pressure-t/pressure-audit.json');
const pressureProjection=await load(root+'/continuous-pressure-t/pressure-review-input.json');
const pressureAssessment=await load(root+'/continuous-pressure-t/independent-assessment-v70/assessment.json',true);
assert.equal(await fileHash(pressureRecording.data.source.file),pressureRecording.data.source.sha256);
assert.equal(pressureTiming.data.journalSha256,pressureRecording.data.source.sha256);
assert.equal(pressureProjection.data.derivedFrom.journalSha256,pressureRecording.data.source.sha256);
assert.equal(pressureProjection.data.rows.length,pressureTiming.data.summary.nativeJobs);
assert(pressureRecording.data.playbackMs>=30*60*1000&&pressureRecording.data.microphoneUsed===false);
if(pressureAssessment)await verifyPairs(pressureAssessment.data.evidence);
const pressureCounts=auditExisting?await auditReviewInput(root+'/continuous-pressure-t/independent-model-review-v70',pressureProjection.data,pressureAssessment?.data):pressureAssessment?.data.summary.modelVerdicts??null;
const pressure={durationMinutes:pressureRecording.data.playbackMs/60000,sourceSegments:pressureRecording.data.sourceSegments,
 uniqueClips:pressureRecording.data.uniqueSourceClips,repeatedCycles:pressureRecording.data.repeatedSourceCycles,
 recordedNativeJobs:pressureTiming.data.summary,independentModelVerdicts:pressureCounts,independentPhraseSummary:pressureAssessment?.data.summary??null,
 timingEndpoint:'Native job speech-end signal, calibrated to host time. Not physical per-source-utterance playback endpoint.'};
const backends=[];
for(const name of ['chatgpt-backend-comparison','chatgpt-backend-comparison-no-tier','backend-playback-comparison']){
 const directory=root+'/'+name,native=name==='backend-playback-comparison';
 const complete=await load(directory+'/'+(native?'playback.json':'complete.json'));
 assert.equal(complete.data.status,'complete');
 const summary=await load(directory+'/'+(native?'independent-native-comparison-v70.json':'independent-comparison-v70.json'),true);
 if(summary)await verifyPairs(summary.data.sources);
 const routeCounts={};
 for(const backend of ['codex','chatgpt']){
  const projection=await load(directory+'/'+backend+'-review-input.json',true);
  if(!projection){assert(!final,'Final consolidation requires every backend source projection');continue;}
  assert.equal(projection.data.model,preferences.candidateModel);assert.equal(projection.data.effort,preferences.candidateEffort);
  assert.equal(projection.data.backend,backend);
  assert.equal(native?projection.data.derivedFrom.sha256:projection.data.derivedFrom.completeSha256,complete.sha256);
  if(auditExisting){
   const subset=summary?{rows:summary.data.rows.filter(row=>row.backend===backend)}:null;
   routeCounts[backend]=await auditReviewInput(directory+'/'+backend+'-independent-model-review-v70',projection.data,subset,true);
  }
 }
 backends.push({name,configurationVariant:complete.data.configurationVariant??null,completionSha256:complete.sha256,
  summary:summary?{summaries:summary.data.summaries,pairs:summary.data.pairs,pairCounts:summary.data.pairCounts,
   switchLaunches:summary.data.switchLaunches?.map(row=>({backend:row.backend,name:row.name,priorAnswerObservedStreamingOnBothSidesOfSubmission:row.priorAnswerObservedStreamingOnBothSidesOfSubmission,heldVisibleCaretAtSubmission:row.heldVisibleCaretAtSubmission})),scope:summary.data.scope}:null,
  auditedModelVerdicts:auditExisting?routeCounts:null});
 globalThis.gc?.();
}
const evidenceNames=[
 'cuda-nineteen-lane-execution','atomic-free-histogram-compile','exact-pause-histogram-compile','hard-probe-recordings',
 'delivery-and-topic-coverage',
 'exact-pause-recordings','midpoint-pause-recording','streaming-topic-switch','older-code-retention','older-sql-reference',
 'completed-memory-binding','continuous-pressure-recording','pressure-audit-findings','pressure-stale-display',
 'pressure-continuation-and-background','completed-systems-recording','systems-substantive-checks','systems-finite-fold-check',
 'completed-general-recording','general-numerical-checks','general-split-question','speech-source-accuracy-scope',
 'window-median-execution','selective-dsa-execution','tcp-parser-execution','rollback-parity-execution','field-witness-execution',
 'cleanup-schedule-execution','reconstruction-execution','bit-sampler-execution','sampler-listing-syntax',
 'answer-architecture-audit-corrected','refinement-queue-analysis','backend-routing-differences','backend-runtime-findings',
 'no-tier-backend-request-timing','normal-auth-remote-only-capture','independent-review-failure-resume','independent-review-isolation',
 'backend-quality-claim-checks'
];
const evidence={};
for(const name of evidenceNames){
 const record=await load('docs/evidence/'+name+'-v70.json');evidence[name]={file:'docs/evidence/'+name+'-v70.json',sha256:record.sha256};
 if(name==='independent-review-isolation'){
  // This is a dated PREPARATION record. Later measured captures and reviews
  // retain their own bindings. Do not pretend its source hashes are current.
  const revisionReasons={
   'src-tauri/examples/assess-recorded-interview.rs':'Generic grader timeout-attempt preservation and bounded same-input retries; earlier cached judgments remain preserved.',
   'scripts/summarize-deep-audio-interview.mjs':'Error/cancellation-aware phrase measurement and explicit measurement scope.',
   'scripts/summarize-answer-backend-comparison.mjs':'Actual reported backend tier and cached-input fields added to the comparison report.',
   '.local/record-backend-playback-v70.mjs':'Preparation preceded the final native capture helper; measured playback has its own source and binary evidence.',
   '.local/run-backend-assessments-v70.ps1':'Separate omitted-tier assessment stage added after the original transport failures.'
  };
  for(const pair of record.data.sources){
   const currentSha256=await fileHash(pair.file);
   if(currentSha256!==pair.sha256){
    assert(Object.hasOwn(revisionReasons,pair.file),`Unexplained preparation source revision: ${pair.file}`);
    historicalPreparationSourceRevisions.push({file:pair.file,preparationSha256:pair.sha256,currentSha256,reason:revisionReasons[pair.file],scope:'Original dated preparation hash is historical. Current-source equality is not claimed; actual recorded execution and review input bindings are audited separately.'});
   }
  }
 }else await verifyPairs(record.data.evidence??record.data.sources);
 if(record.data.productionSourceHashes)await verifyPairs(record.data.productionSourceHashes);
 if(typeof record.data.rawEvidence==='string'){
  const raw=await load(record.data.rawEvidence);
  if(raw.data.journalSha256&&record.data.sourceJournalSha256)assert.equal(raw.data.journalSha256,record.data.sourceJournalSha256);
  evidence[name].rawEvidence={file:record.data.rawEvidence,sha256:raw.sha256};
 }
 if(name==='refinement-queue-analysis')assert.equal(await fileHash(record.data.source.file),record.data.source.sha256);
 if(name==='backend-routing-differences')for(const [file,sha256]of Object.entries(record.data.sourceHashes))assert.equal(await fileHash(file),sha256);
}
const extraChecks=[
 root+'/hard-probes/fp32-association/fp32-execution-evidence.json',
 root+'/continuous-pressure-t/pressure-source-coverage-audit.json',
 root+'/general-hour-t/code-review/crt-execution-evidence.json',
 root+'/general-hour-t/code-review/erasure-execution-evidence.json',
 root+'/general-hour-t/code-review/publication-execution-evidence.json'
];
for(const file of extraChecks){const record=await load(file);evidence[file]={file,sha256:record.sha256};await verifyPairs(record.data.evidence??record.data.sources);}
const requirements=[
 {id:1,recording:'warp-followups',observedOutcome:'Dependent five-turn warp/mask/shuffle chain recorded. Original 19-lane reduction compiled; generated PTX contribution tracing checked all 19 lanes. No NVIDIA device execution.',evidence:['cuda-nineteen-lane-execution']},
 {id:2,recording:'divergent-block-barrier',observedOutcome:'Rejects the safety guarantee and explains block-wide participation. The separate comparison exposes an unqualified 16/112 split: this numerical split assumes a one-dimensional block, whereas the source does not specify dimensions. Original judgments and this manual qualification remain separate. No GPU runtime certificate.',evidence:['hard-probe-recordings','backend-quality-claim-checks']},
 {id:3,recording:'never-recorded-event',observedOutcome:'Rejects retroactive dependency: an earlier wait on a never-recorded event is a no-op. Recognized event identifier spelling differs; semantic event state is retained.',evidence:['hard-probe-recordings']},
 {id:4,recording:'fp32-association',observedOutcome:'Actual binary32 evaluations yield 1 and 0. Recorded answer distinguishes association; selected numerical check is separate from full model judgments.',evidence:['hard-probe-recordings']},
 {id:5,recording:'histogram-late-reversal-exact-pause',observedOutcome:'Exact 1500ms pause response follows no-atomics requirement, and untouched CUDA listing compiles. Pressure repetitions retain an obsolete atomic proposal briefly and then unrelated stale text: display requirement fails there.',evidence:['exact-pause-recordings','exact-pause-histogram-compile','pressure-continuation-and-background']},
 {id:6,recording:'long-question-essential-tail-midpoint-pause',observedOutcome:'Actual 1500ms zero-PCM gap at 48.10% of voiced span, about 30.16 seconds outside gap. Recorded visible revisions and completion follow the full source endpoint; retained answer includes final signed64 overflow rejection. Hidden early work is permitted.',evidence:['midpoint-pause-recording']},
 {id:7,recording:'exact-launch-numbers',observedOutcome:'Retains 10000 elements and 192 rather than 128 threads and returns 53 blocks.',evidence:['hard-probe-recordings']},
 {id:8,recording:'cuda-to-phantom-reads',observedOutcome:'Switch recorded while prior answer streamed. Final database answer avoids CUDA assumptions, but stale CUDA remained visible approximately 1.87 seconds after the new confirmation: display requirement fails.',evidence:['streaming-topic-switch']},
 {id:9,recording:'deep-code-memory',observedOutcome:'27-turn implementation/refinement recording completed. Explicit request for the original function after 21 intervening turns did not reproduce it. Systems old-code and DSA old-SQL cases also lose the requested artifact. Honest clarification can be content-correct while memory retention fails.',evidence:['older-code-retention','completed-memory-binding','older-sql-reference']},
 {id:10,recording:'continuous-pressure-t',observedOutcome:'Uninterrupted playback-only 30-minute recording includes the requested speech patterns. Recognized clauses appear in final native-job union, but five foreground requests were cancelled by merged background no-reply instructions. Stale answer held up to 51.216 seconds after initial new-question confirmation. Resource growth and descriptive latency halves are reported; no causal leak or statistical degradation certificate.',evidence:['continuous-pressure-recording','pressure-audit-findings','pressure-stale-display','pressure-continuation-and-background']}
];
for(const requirement of requirements){
 assert(requirement.id>=1&&requirement.id<=10);
 if(requirement.id!==10)assert(hardNames.includes(requirement.recording));
 requirement.evidence=requirement.evidence.map(name=>evidence[name]);
}
const checkpoint=(await load('docs/evidence/architecture-and-backend-checkpoint-v70.json')).data;
const hourModelVerdicts=Object.fromEntries(['correct','incorrect','incomplete','unverified','missing'].map(verdict=>[verdict,hours.reduce((total,hour)=>total+(hour.independentModelVerdicts?.[verdict]??0),0)]));
const completedReviewCount=auditExisting?[...reviewerProvenance.values()].reduce((sum,record)=>sum+record.judgments,0):null;
if(final){
 assert.equal(pending.length,0,'Full consolidation requires every independent assessment');
 assert.equal(completedReviewCount,hours.reduce((sum,row)=>sum+row.turns,0)+hardProbes.reduce((sum,row)=>sum+row.turns,0)+pressureProjection.data.rows.length+backends.reduce((sum,item)=>sum+Object.values(item.auditedModelVerdicts).reduce((count,route)=>count+Object.values(route).reduce((a,b)=>a+b,0),0),0));
}
const result={recordedAt:new Date().toISOString(),status:final?'evaluation_recorded_and_verified':'accuracy_reviews_pending',goalComplete:final,
 objective:{attachment,attachmentSha256,scope:'Record and assess the ten supplied tests, three full hour interviews with rapid and incomplete follow-ups across topics, DSA rounds, accuracy, latency, resource observations and backend architecture. Negative app outcomes are results; this task does not modify production behavior.'},
 preferences,hours,allHourIndependentModelVerdicts:hourModelVerdicts,hardProbes,pressure,backends,requirements,
 architecture:checkpoint.architecture,workingVariantRequestTiming:checkpoint.backendFixedPromptTiming,
 selectiveChecks:evidence,reviewerProvenance:[...reviewerProvenance.values()],historicalPreparationSourceRevisions,auditedReviewCount:completedReviewCount,
 pendingArtifacts:pending,sources:[...sources.values()],
 corrections:[
  'Use canonical DSA unassigned-turn correction; the old 1155122ms row borrowed another response and is not latency evidence.',
  'The normal saved-auth HTTP client already has 10s connect and 120s total deadlines. Historical no-timeout audit is superseded.',
  'Original ChatGPT fast-tier HTTP400 trials remain failures. Working omitted-tier trials are separate observations.',
  'Native ChatGPT cases started no question jobs and therefore did not reach the answer POST. The attempted topic switch did not interrupt a streaming ChatGPT answer.',
  'Pressure phases and cancellation flags differ on five ignored jobs. Retained recognized clauses do not prove delivered answers.'
  ,'Dated evidence reports retain their historical pending/preparation fields. The source-bound completed assessments and this final audit determine current evaluation completion.'
 ],
 accuracyScope:'Independent content judgments against intended source text are provisional model reviews, not verified population accuracy or pure model capability. Selected untouched-code tests, mathematical checks and compilation are linked separately. Strict sentinel/identifier failures are preserved separately from diagnostic representation translations. Phonetic ground truth of every synthetic WAV is not independently certified.',
 latencyScope:'Hours and hard probes use last-nonzero physical playback endpoint to actual retained visible complete word. Pressure uses calibrated native-job speech end. Fixed-prompt backend comparison starts after authentication and preparation, excludes ASR/live updates/overlay and uses differing native protocol. Finite sample percentiles describe retained measurements; every missing, errored and retired turn remains counted.',
 resourceScope:'Native process, recorder and current descendants are separate. Summed working sets double-count shared pages; GPU allocations and non-child services are excluded. DSA descendant observer starts partway through. Growth and half-run differences are observations, not isolated leak or degradation proofs.',
 completionScope:'Evaluation complete means requested recordings, independent recorded-answer assessments, selective source-bound checks, architecture diagnosis and report verification are complete. Failed product assertions remain failed. No production changes, model/backend deployment decision, exhaustive code proof or GPU hardware execution is claimed.'};
if(final)result.workingVariantRequestTiming.accuracyPending=false;
const file='docs/evidence/'+(final?'deep-interview-results-v70.json':'deep-interview-results-progress-v70.json');
if(auditExisting&&!final){
 const auditDirectory=root+'/consolidation-audits';await mkdir(auditDirectory,{recursive:true});
 result.immutableAuditSnapshot=auditDirectory+'/'+result.recordedAt.replaceAll(':','-')+'.json';
 await writeFile(result.immutableAuditSnapshot,JSON.stringify(result,null,2),{flag:'wx'});
}
await writeFile(file,JSON.stringify(result,null,2),{flag:final?'wx':'w'});
console.log(JSON.stringify({file,status:result.status,hourTurns:hours.reduce((sum,row)=>sum+row.turns,0),hardProbeTurns:hardProbes.reduce((sum,row)=>sum+row.turns,0),pressureJobs:pressureProjection.data.rows.length,allHourIndependentModelVerdicts:hourModelVerdicts,auditedReviewCount:completedReviewCount,pendingArtifactCount:pending.length,pendingArtifactExamples:pending.slice(0,5)}));
