import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connectNativePages} from './lib/native-cdp.mjs';
import {installPaintedAnswerRecorder} from './lib/painted-answer-recorder.mjs';
import {changedJobObservation} from './lib/deep-observations.mjs';
import {streamedWordLatency} from './lib/streamed-word-latency.mjs';
import {servedRenderer} from './lib/served-renderer.mjs';
import {nativeBuildProvenance} from './lib/native-build-provenance.mjs';

const root=process.cwd(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hash=b=>createHash('sha256').update(b).digest('hex');
const [runRoot,applicationDirectory,sourceDirectory,outputDirectory,caseArgument,repetitionArgument,variant]=process.argv.slice(2);
assert(runRoot&&applicationDirectory&&sourceDirectory&&outputDirectory&&variant,'RUN_ROOT APPLICATION_DIRECTORY SOURCE_DIRECTORY OUTPUT_DIRECTORY CASE_INDEX REPETITION VARIANT');
const caseIndex=Number(caseArgument),repetitionIndex=Number(repetitionArgument);
assert(Number.isSafeInteger(caseIndex)&&caseIndex>=0&&Number.isSafeInteger(repetitionIndex)&&repetitionIndex>=0);
const sourceRoot=path.resolve(sourceDirectory),binaryRoot=path.resolve(applicationDirectory);
for(const directory of [sourceRoot,binaryRoot,path.resolve(outputDirectory)])assert(directory===root||directory.startsWith(root+path.sep),'Variant inputs and outputs must remain in the workspace');
const recorded={configuration:{model:'gpt-6.1-sol',effort:'low',output:'T24E390'}};
const out=path.resolve(outputDirectory),manifestFile=path.resolve(runRoot,'policy-playback/manifest.json'),manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes);
assert(caseIndex<manifest.cases.length&&repetitionIndex<manifest.repetitions);
const sourceCase=manifest.cases[caseIndex];manifest.cases=[sourceCase];
assert.equal(manifest.model,recorded.configuration.model);assert.equal(manifest.effort,recorded.configuration.effort);
assert(Number.isInteger(manifest.repetitions)&&manifest.repetitions>0);
const appDir=path.join(out,'app'),dataDir=path.join(out,'data'),trialsDir=path.join(out,'trials');
await mkdir(out,{recursive:true});await mkdir(trialsDir);await mkdir(appDir);await mkdir(dataDir);
for(const file of await readdir(binaryRoot))if(file==='WmiPrvSE.exe'||file.endsWith('.dll'))await copyFile(path.join(binaryRoot,file),path.join(appDir,file==='WmiPrvSE.exe'?'WmiPrvSE.exe':file));
const binarySha256=hash(await readFile(path.join(appDir,'WmiPrvSE.exe')));
assert.equal(binarySha256,hash(await readFile(path.join(binaryRoot,'WmiPrvSE.exe'))),'Use the declared variant binary');
const sourceFiles=['src-tauri/src/audio/mod.rs','src-tauri/src/openai/codex.rs','src-tauri/src/runtime.rs','src-tauri/src/meeting/scheduler.rs'];
const buildEvidence=await nativeBuildProvenance(binaryRoot,sourceRoot,sourceFiles);
// Validate large source journals before launching the measured app. Do not
// keep a whole hour's observation history resident during a control trial.
async function validateSource(file,cases){
 const bytes=await readFile(path.resolve(file)),original=JSON.parse(bytes);
 for(const source of cases){assert.equal(hash(bytes),source.source.sha256);assert.equal(original.rows[source.source.index].question,source.sourceQuestion);assert.equal(original.rows[source.source.index].selectedContext,source.selectedContext);}
}
for(const file of new Set(manifest.cases.map(c=>c.source.file))){await validateSource(file,manifest.cases.filter(c=>c.source.file===file));globalThis.gc?.();}
const env={...process.env,COPILOT_ACCEPTANCE:'1',COPILOT_ACCEPTANCE_REMOTE_ONLY:'1',COPILOT_INTENT_MODE:'existing',COPILOT_TRACE_PROVISIONAL:'1',COPILOT_NEMO_DIAGNOSTICS:'1',COPILOT_DATA_DIR:dataDir,WEBVIEW2_USER_DATA_FOLDER:path.join(out,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9245'};
for(const key of ['COPILOT_TEST_API','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_ACCEPTANCE_SELF_LOOPBACK','COPILOT_INTENT_PROFILE','COPILOT_EAGER_FINAL_REPLACEMENT','COPILOT_CONFIRM_QUESTION_REFINEMENTS','COPILOT_AGE_FINAL_WAIT','COPILOT_REPLACE_COMPLETED_DRAFT'])delete env[key];
const result={status:'in_progress',startedAt:new Date().toISOString(),manifestFile,manifestSha256:hash(manifestBytes),nativeBinarySha256:binarySha256,variant,sourceRoot,binaryRoot,caseIndex,repetitionIndex,
 model:manifest.model,effort:manifest.effort,serviceTier:manifest.serviceTier,buildEvidence,scope:'One source-bound controller comparison using identical saved audio and frozen context. Controller endpoints may differ; model, effort and full answer objective are held fixed. No microphone, correctness selection, population p95 or provider-compute isolation.',protocol:manifest.protocol,
 collectorSourceHashes:{'scripts/controller-native-control.mjs':hash(await readFile(new URL(import.meta.url))),'scripts/lib/deep-observations.mjs':hash(await readFile('scripts/lib/deep-observations.mjs')),'scripts/lib/native-build-provenance.mjs':hash(await readFile('scripts/lib/native-build-provenance.mjs'))},
 trials:[],independentAccuracyPending:true,goalComplete:false};
let app,vite,connection,invoke,active=false;
const persist=()=>writeFile(path.join(out,'playback.json'),JSON.stringify(result,null,2));
const runChild=(file,args)=>new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd:root,windowsHide:true,env,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',x=>error=(error+x).slice(-2000));child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Playback exited ${code}: ${error}`)));});
try{
 try{await fetch('http://127.0.0.1:1420');}catch{
  vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});
  let ready=false;for(let i=0;i<300;i++){try{await fetch('http://127.0.0.1:1420');ready=true;break;}catch{await sleep(100);}}assert(ready);
 }
 result.renderer=await servedRenderer();
 app=spawn(path.join(appDir,'WmiPrvSE.exe'),[],{cwd:root,windowsHide:true,env,stdio:'ignore'});result.nativeProcessId=app.pid;
 for(let i=0;i<600;i++){try{connection=await connectNativePages(9245);break;}catch{assert(app.exitCode===null);await sleep(100);}}assert(connection);
 invoke=(name,args={})=>connection.main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
 await connection.main.evaluate(async()=>{
  window.nativeInterviewEvents=[];
  for(const [event,name] of [['copilot:event',null],['copilot:transcript','transcript']])await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event,target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.nativeInterviewEvents.push(name?{name,payload:e.payload,receivedHostMs:Date.now()}:{...e.payload,receivedHostMs:Date.now()}))});
 });
 for(let i=0;i<600;i++){if(await connection.overlay.evaluate(()=>Boolean(document.querySelector('.answer-content'))))break;await sleep(100);}
 await connection.overlay.evaluate(installPaintedAnswerRecorder);
 const initial=await invoke('bootstrap');assert(initial.debug&&!initial.snapshot.active);
 const output=initial.devices.filter(d=>d.source==='remote'&&d.name.includes(recorded.configuration.output));assert.equal(output.length,1);
 result.outputDevice=output[0].name;
 const settings={...initial.settings,answerBackend:process.env.COPILOT_CONTROLLER_BACKEND||'codex',answerObjective:'detailed',model:manifest.model,reasoningEffort:manifest.effort,serviceTier:manifest.serviceTier,output:output[0].id,microphone:'',projectPath:'',speechChunkMs:160};
 await invoke('save_settings',{settings});
 if(settings.answerBackend==='chatgpt'){const boot=await invoke('bootstrap');const account=boot.accounts.find(a=>a.planEnabled);assert(account,'No saved authorized direct-plan account');await invoke('select_account',{clientId:account.clientId});}
 const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,hash(await readFile(path.join(sourceRoot,file)))])));
 const timingFile='src-tauri/src/openai/timing.rs',diagnosticSourceHashes={[timingFile]:hash(await readFile(path.join(sourceRoot,timingFile))),'scripts/controller-native-control.mjs':hash(await readFile('scripts/controller-native-control.mjs'))};
 for(const repetition of [repetitionIndex])for(const [index,source] of manifest.cases.entries()){
  const order=['existing'];
  for(const policy of order){
   const label=`${source.name}-rep-${repetition+1}-${variant}`,directory=path.join(trialsDir,label);await mkdir(directory);
   const record={name:source.name,label,policy,variant,repetition:repetition+1,status:'in_progress',source,outputDirectory:path.relative(root,directory)};result.trials.push(record);await persist();
   const waveFile=path.resolve(source.wave.file),wave=await readFile(waveFile);assert.equal(hash(wave),source.wave.sha256);
   assert.equal(hash(source.selectedContext),source.contextSha256);
   await writeFile(path.join(directory,'round-01.txt'),source.sourceQuestion,{flag:'wx'});await writeFile(path.join(directory,'round-01.wav'),wave,{flag:'wx'});
   await invoke('start_meeting',{settings});active=true;
   await invoke('action',{action:'dismiss'});
   await invoke('acceptance_freeze_context',{context:source.selectedContext,policy});
   const journal={status:'in_progress',startedAt:new Date().toISOString(),model:manifest.model,effort:manifest.effort,tier:manifest.serviceTier,
    outputDevice:result.outputDevice,sourceHashes,sourceHashesScope:'Observed checkout file bytes; do not bind these to the frozen binary. See buildEvidence for its declared commit Git blobs.',buildEvidence,diagnosticSourceHashes,nativeBinarySha256:binarySha256,
    speechConfiguration:{remoteOnly:true,selfCapture:{kind:'disabled',physicalMicrophoneUsed:false},speechChunkMs:160,speechBackend:settings.speechBackend},
    endpointDefinition:'Last nonzero PCM frame in the unchanged synthetic source waveform, timed by the actual waveOut device-position crossing interval. Host/native anchors calibrate native timestamps; overlay paint samples measure actual viewport-visible text. No microphone or room-acoustic ground truth.',
    primaryLatencyMetric:'Physical synthetic playback speech end to first complete word visibly painted in the actual overlay; independent accuracy and first correct useful phrase assessed after recording.',
    evaluationKind:'matched_fresh_meeting_architecture_control',variant,sourceRoot,policy,sourceCase:source.source,deepObservationFormat:'changed_jobs_sparse_context',
    deepObservations:[],overlayPaintSamples:[],pollErrors:[],recorderResources:[],rows:[]};
   let paintOffset=await connection.overlay.evaluate(()=>window.deepPaintSamples.length),eventOffset=await connection.main.evaluate(()=>window.nativeInterviewEvents.length);
   const fingerprints=new Map(),latest=new Map();let sampling=true,pending=null,lastResource=0;
   const poll=()=>{if(pending)return pending;pending=(async()=>{
    const hostBeforeMs=Date.now(),state=await invoke('acceptance_jobs'),hostAfterMs=Date.now();
    for(const job of state.jobs)latest.set(job.question.id,job);
    const observation=changedJobObservation(state,fingerprints,{hostBeforeMs,hostAfterMs});journal.deepObservations.push(observation);
    const paints=await connection.overlay.evaluate(offset=>({total:window.deepPaintSamples.length,paints:window.deepPaintSamples.slice(offset)}),paintOffset);paintOffset=paints.total;journal.overlayPaintSamples.push(...paints.paints);
    if(hostAfterMs-lastResource>=10000){lastResource=hostAfterMs;journal.recorderResources.push({hostMs:hostAfterMs,pollMs:hostAfterMs-hostBeforeMs,...process.memoryUsage(),scope:'Control recorder process; excludes native descendants, GPU and provider resources.'});}
    return state;
   })().finally(()=>{pending=null;});return pending;};
   const sampler=(async()=>{while(sampling){try{await poll();}catch(error){journal.pollErrors.push(String(error));}await sleep(70);}})();
   const anchor=async()=>{const hostBeforeMs=Date.now(),s=await invoke('acceptance_jobs'),hostAfterMs=Date.now();return {hostBeforeMs,hostAfterMs,nativeMs:s.nativeNow};};
   try{
    const before=await anchor(),playbackFile=path.join(directory,'round-01.playback.json');
    await runChild('powershell.exe',['-NoProfile','-File',path.resolve('scripts/play-fixture-device.ps1'),'-InputPath',path.join(directory,'round-01.wav'),'-OutputName',result.outputDevice,'-TimingPath',playbackFile]);
    const after=await anchor(),playback=JSON.parse(await readFile(playbackFile));
    // A completed prefix before the final ASR arrives is not the final trial.
    await sleep(2500);
    const deadline=Date.now()+manifest.observationBudgetMs;let job=null,settled=false;
    while(Date.now()<deadline){
     await poll();const ev=await connection.main.evaluate(offset=>window.nativeInterviewEvents.slice(offset).filter(e=>e.name==='speech.ended'||e.name==='question.confirmed'),eventOffset);
     const lastEnd=ev.filter(e=>e.name==='speech.ended'&&e.payload?.source==='remote').at(-1)?.payload.timestamp;
     job=[...latest.values()].filter(j=>j.confirmed&&!j.cancelled&&(lastEnd==null||j.latency.questionConfirmedAt>=lastEnd)).sort((a,b)=>a.question.detectedAt-b.question.detectedAt).at(-1)??null;
     if(job&&(job.error||job.latency.completedAt!=null)){settled=true;await sleep(500);break;}await sleep(100);
    }
    await poll();if(job)job=latest.get(job.question.id)??job;
    const row={round:1,trial:1,policy,variant,question:source.sourceQuestion,recognizedQuestion:job?.question.text??null,
     answer:job?.answer??'',phase:job?.phase??'no_job',error:job?.error??null,cancelled:job?.cancelled??false,
     selectedContext:job?.selectedContext??null,recordedSourcePriorQuestions:source.sourcePriorQuestions,
     responseVersion:job?`${job.question.id}:${job.latency.responseRevision??0}`:null,latency:job?.latency??null,
     audio:{waveFile:'round-01.wav',sha256:source.wave.sha256,playback,clockAnchors:[before,after],runningAtPlaybackLaunch:[]},
     events:await connection.main.evaluate(offset=>window.nativeInterviewEvents.slice(offset),eventOffset),
     observationWindowExpired:!settled,sourceBinding:source.source};
    if(row.selectedContext!=null)assert.equal(row.selectedContext,source.selectedContext,'Matched frozen context changed');
    journal.rows.push(row);journal.timings=await invoke('get_answer_timings');journal.actualInterviewDurationMs=Date.now()-Date.parse(journal.startedAt);
    row.firstStreamedWordMeasurement=streamedWordLatency(journal,row);
    record.settledAfterPlayback=settled;record.word=row.firstStreamedWordMeasurement.firstRetainedVisibleStreamedWord;record.phase=row.phase;record.error=row.error;record.recognizedQuestion=row.recognizedQuestion;
   }catch(error){journal.status='failed';journal.failure=String(error);await writeFile(path.join(directory,'interview.json'),JSON.stringify(journal,null,2),{flag:'wx'});throw error;}
   finally{sampling=false;await sampler;await poll();}
   try{
    await invoke('stop_meeting');active=false;const stopped=await invoke('get_snapshot');
    journal.stoppedCleanly=!stopped.active&&!stopped.answer&&!stopped.questions.length;assert(journal.stoppedCleanly);
   }catch(error){journal.status='failed';journal.failure=String(error);await writeFile(path.join(directory,'interview.json'),JSON.stringify(journal,null,2),{flag:'wx'});throw error;}
   journal.status='complete';journal.completedAt=new Date().toISOString();journal.stopReason='single_matched_wave_observation_finished';
   await writeFile(path.join(directory,'interview.json'),JSON.stringify(journal,null,2),{flag:'wx'});
   record.status='complete';record.stoppedCleanly=true;record.journalSha256=hash(await readFile(path.join(directory,'interview.json')));await persist();
   console.log(`Architecture control ${label}: ${record.phase}, retained word ${record.word?.latencyMs.high??'missing'} ms`);
  }
 }
 result.status='complete';result.stoppedCleanly=result.trials.every(t=>t.stoppedCleanly);
}catch(error){result.status='failed';result.error=String(error);throw error;}
finally{
 if(active&&invoke)await invoke('stop_meeting').catch(()=>{});
 connection?.close();if(app?.exitCode===null){app.kill();await new Promise(resolve=>app.once('exit',resolve));}if(vite?.exitCode===null)vite.kill();
 result.completedAt=new Date().toISOString();await persist();
}
