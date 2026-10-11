import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const base='artifacts/deep-interview-v70';
const manifestFile=process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:`${base}/backend-comparison-cases.json`,manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes);
const sourceJournals=new Map(),bound=[];
for(const item of manifest.cases){
 if(!sourceJournals.has(item.sourceJournal)){
  const bytes=await readFile(item.sourceJournal),journal=JSON.parse(bytes);
  assert(journal.status==='complete'&&journal.stoppedCleanly);
  sourceJournals.set(item.sourceJournal,{journal,sha256:hash(bytes)});
 }
 const {journal,sha256}=sourceJournals.get(item.sourceJournal);assert.equal(sha256,item.journalSha256);
 const index=journal.rows.findIndex(row=>row.round===item.sourceRound);assert(index>=0);
 const source=journal.rows[index];
 assert.equal(source.question,item.spokenQuestion);assert.equal(source.recognizedQuestion,item.recognizedQuestion);
 assert.equal(source.selectedContext,item.selectedContext);
 bound.push({...item,recordedSourcePriorQuestions:journal.rows.slice(0,index).map(row=>({question:row.question,round:row.round}))});
}
if(process.argv.includes('--validate-sources-only')){
 const sources=['src-tauri/examples/assess-recorded-interview.rs','scripts/summarize-deep-audio-interview.mjs',
  'scripts/tests/deep-audio-assessment.test.mjs','.local/prepare-backend-review-v70.mjs'];
 const sourceHashes={};for(const file of sources)sourceHashes[file]=hash(await readFile(file));
 const report={recordedAt:new Date().toISOString(),manifest:{file:manifestFile,sha256:hash(manifestBytes)},sourceHashes,
  boundCases:bound.map(({sourceJournal,journalSha256,sourceRound,recordedSourcePriorQuestions})=>({sourceJournal,journalSha256,sourceRound,
   earlierSourceQuestions:recordedSourcePriorQuestions.length})),
  reviewerInputSchemaVersion:3,sourceHistoryPerCase:true,sourceQuestionContextAndRecognitionByteMatched:true,
  independentModelInferenceExecuted:false,backendComparisonExecuted:false,
  scope:'Offline preparation validates each comparison case against its completed original recording and binds only its earlier source questions. Cases from other comparisons are not treated as conversation history. Qualitative error/cancellation outcomes remain in future reviewer inputs; examiner grades and numerical timing are excluded.'};
 await writeFile('docs/evidence/backend-review-source-bindings-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
 console.log(JSON.stringify({validatedCases:bound.length,modelInferenceExecuted:false,comparisonExecutionPending:true}));
 process.exit(0);
}
const directory=process.argv[3]??`${base}/chatgpt-backend-comparison`;
const completeBytes=await readFile(`${directory}/complete.json`),complete=JSON.parse(completeBytes);
assert.equal(complete.status,'complete');assert.equal(complete.manifestSha256,hash(manifestBytes));
assert.equal(complete.cases,bound.length);assert.equal(complete.repetitions,manifest.repetitions);
const groups={codex:[],chatgpt:[]},evidence=[];
for(let repetition=1;repetition<=manifest.repetitions;repetition++)for(const [index,source] of bound.entries()){
 const pair=[];
 for(const backend of ['codex','chatgpt']){
  const file=`${directory}/repeat-${repetition}-case-${String(index+1).padStart(2,'0')}-${backend}.json`;
  const bytes=await readFile(file),trial=JSON.parse(bytes);assert.equal(trial.backend,backend);
  assert.equal(trial.repetition,repetition);assert.equal(trial.case,index+1);
  assert.equal(trial.model,manifest.model);assert.equal(trial.effort,manifest.effort);
  const {recordedSourcePriorQuestions,...originalCase}=source;assert.deepEqual(trial.source,originalCase);
  assert.equal(trial.codexContinuity,false);
  const row={round:groups[backend].length+1,question:source.spokenQuestion,recognizedQuestion:source.recognizedQuestion,
   selectedContext:source.selectedContext,answer:trial.answer,phase:trial.error?'error':'complete',error:trial.error??null,cancelled:trial.observationBudgetExhausted??false,
   recordedSourcePriorQuestions,sourceBinding:{sourceJournal:source.sourceJournal,journalSha256:source.journalSha256,sourceRound:source.sourceRound,
    recordedTrial:{file,sha256:hash(bytes)},repetition,case:index+1,inputSha256:trial.inputSha256}};
  groups[backend].push(row);evidence.push({file,sha256:hash(bytes)});pair.push(trial.inputSha256);
 }
 assert.equal(pair[0],pair[1],'Paired backend trials must have exactly the same final question/context input hash');
}
for(const backend of ['codex','chatgpt']){
 const projection={status:'complete',stoppedCleanly:true,model:manifest.model,effort:manifest.effort,backend,
  derivedFrom:{manifestFile,manifestSha256:hash(manifestBytes),completeFile:`${directory}/complete.json`,completeSha256:hash(completeBytes)},
  measurementKind:'offline_final_prompt_backend_review_projection',rows:groups[backend],
  scope:'A projection of completed diagnostic trials, not new answer executions or native audio recordings. Each trial retains its actual error and answer. Source history is taken from that case\u2019s original recorded interview, not preceding comparison cases. No waveform endpoint or actual overlay timing is inferred. Independent assessment remains pending.'};
 await writeFile(`${directory}/${backend}-review-input.json`,JSON.stringify(projection,null,2),{flag:'wx'});
}
console.log(JSON.stringify({reviewRows:Object.fromEntries(Object.entries(groups).map(([name,rows])=>[name,rows.length])),independentAssessmentPending:true}));
