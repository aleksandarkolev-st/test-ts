import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {projectNativeBackendWave} from '../scripts/lib/native-backend-projection.mjs';
const directory='artifacts/deep-interview-v70/backend-playback-comparison',file=`${directory}/playback.json`;
const bytes=await readFile(file),recording=JSON.parse(bytes),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert(recording.status==='complete'&&recording.stoppedCleanly);
assert(recording.normalSavedAuthentication&&!recording.microphoneUsed);
const groups={codex:[],chatgpt:[]},pairs=new Map();
for(const [caseIndex,record] of recording.cases.entries()){
 assert(Object.hasOwn(groups,record.backend));assert(record.stoppedCleanly);
 for(const [waveIndex,wave] of record.waves.entries()){
  const waveBytes=await readFile(wave.file);assert.equal(hash(waveBytes),wave.sha256);
  const key=`${record.name}:${waveIndex}`;
  if(pairs.has(key))assert.deepEqual(pairs.get(key),{sha256:wave.sha256,question:wave.sourceQuestion});
  else pairs.set(key,{sha256:wave.sha256,question:wave.sourceQuestion});
  const projected=projectNativeBackendWave(record,waveIndex);
  groups[record.backend].push({...projected,round:groups[record.backend].length+1,selectedContext:null,
   recordedSourcePriorQuestions:record.waves.slice(0,waveIndex).map((prior,index)=>({question:prior.sourceQuestion,round:index+1})),
   sourceBinding:{...projected.sourceBinding,recordedCaseIndex:caseIndex,waveIndex,name:record.name,
    originalSourceJournalSha256:record.sourceJournalSha256,waveformSha256:wave.sha256,
    selectedContextCapture:'Not exposed by normal-auth snapshot commands; no original context or unrelated comparison-case history is injected.'}});
 }
}
assert.equal(groups.codex.length,groups.chatgpt.length);
for(const backend of ['codex','chatgpt']){
 const projection={status:'complete',stoppedCleanly:true,model:recording.model,effort:recording.effort,
  outputDevice:recording.outputDevice,backend,derivedFrom:{file,sha256:hash(bytes)},
  measurementKind:'normal_auth_native_backend_source_review_projection',rows:groups[backend],
  scope:'Offline projection of recorded native playback, not new answer executions. Case-relative source history is kept separate. Observed visible answers are graded against full played source questions. Hidden scheduler answers and exact selected public context were not exposed by normal authentication. No future answer is assigned to the interrupted first waveform in a switch case. All absent final confirmations and missing answers remain counted; raw cases and later stale paints remain preserved.'};
 await writeFile(`${directory}/${backend}-review-input.json`,JSON.stringify(projection,null,2),{flag:'wx'});
}
console.log(JSON.stringify({rows:Object.fromEntries(Object.entries(groups).map(([backend,rows])=>[backend,rows.length])),independentAccuracyPending:true}));
