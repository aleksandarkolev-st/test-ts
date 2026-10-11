// Authenticated native validation. Explicit opt-in artifacts; production
// conversations remain RAM-only. This collector never selects assistant policy.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connectNativePages} from './lib/native-cdp.mjs';
import {installPaintedAnswerRecorder} from './lib/painted-answer-recorder.mjs';
import {changedJobObservation} from './lib/deep-observations.mjs';
import {streamedWordLatency} from './lib/streamed-word-latency.mjs';
import {servedRenderer} from './lib/served-renderer.mjs';
if(process.argv[2]==='--stop'){
 const connection=await connectNativePages(9251);
 try{await connection.main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('stop_meeting'));}finally{connection.close();}
 process.exit(0);
}
const [manifestFile,applicationDir,outputDir,backend='codex']=process.argv.slice(2);
assert(manifestFile&&applicationDir&&outputDir&&['codex','chatgpt'].includes(backend));
const root=process.cwd(),out=path.resolve(outputDir),sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=x=>createHash('sha256').update(x).digest('hex');
for(const file of [manifestFile,applicationDir,outputDir])assert(path.resolve(file).startsWith(root+path.sep),'Keep all artifacts inside the workspace');
const bytes=await readFile(manifestFile),plan=JSON.parse(bytes);assert.equal(plan.model,'gpt-6.1-sol');assert.equal(plan.effort,'low');
await mkdir(out,{recursive:true});
const journal={status:'in_progress',evaluationKind:'authenticated_native_session_replay',model:plan.model,effort:plan.effort,tier:plan.serviceTier??null,backend,
 manifestSha256:hash(bytes),nativeBinarySha256:hash(await readFile(path.join(applicationDir,'meeting-copilot.exe'))),
 scope:'Synthetic saved audio through T24E390, local ASR, real signed-in backend, production conversation controller and overlay. Typed probes explicitly exclude audio/ASR. No human-interview certification.',
 rows:[],deepObservations:[],overlayPaintSamples:[],pollErrors:[],resourceSamples:[],startedAt:new Date().toISOString()};
let app,vite,connection,invoke,active=false,sampling=false,sampler;
const persist=()=>writeFile(path.join(out,'interview.json'),JSON.stringify(journal,null,2));
const env={...process.env,COPILOT_ACCEPTANCE:'1',COPILOT_ACCEPTANCE_REMOTE_ONLY:'1',COPILOT_INTENT_MODE:'existing',COPILOT_TRACE_PROVISIONAL:'1',COPILOT_DATA_DIR:path.join(out,'data'),WEBVIEW2_USER_DATA_FOLDER:path.join(out,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9251'};
for(const key of ['COPILOT_TEST_API','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_ACCEPTANCE_SELF_LOOPBACK','COPILOT_INTENT_PROFILE','COPILOT_EAGER_FINAL_REPLACEMENT','COPILOT_CONFIRM_QUESTION_REFINEMENTS','COPILOT_AGE_FINAL_WAIT'])delete env[key];
const child=(file,args)=>new Promise((resolve,reject)=>{const p=spawn(file,args,{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let error='',stdout='';p.stderr.on('data',x=>error=(error+x).slice(-4000));p.stdout.on('data',x=>stdout+=x);p.once('error',reject);p.once('exit',code=>code===0?resolve(stdout):reject(Error(`${file} exited ${code}: ${error}`)));});
try {
 try{await fetch('http://127.0.0.1:1420');}catch{vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});for(let i=0;i<300;i++){try{await fetch('http://127.0.0.1:1420');break;}catch{await sleep(100);}}}
 journal.renderer=await servedRenderer();
 journal.collectorSha256=hash(await readFile(new URL(import.meta.url)));
 try{journal.buildEvidence=JSON.parse(await readFile(path.join(applicationDir,'build.json')));}catch(error){if(error.code!=='ENOENT')throw error;}
 await mkdir(path.join(out,'data'),{recursive:true});
 app=spawn(path.join(root,applicationDir,'meeting-copilot.exe'),[],{cwd:root,windowsHide:true,env,stdio:'ignore'});journal.nativeProcessId=app.pid;
 for(let i=0;i<600;i++){try{connection=await connectNativePages(9251);break;}catch{assert.equal(app.exitCode,null);await sleep(100);}}assert(connection);
 invoke=(name,args={})=>connection.main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
 await connection.main.evaluate(async()=>{window.replayEvents=[];for(const [event,name]of [['copilot:event',null],['copilot:transcript','transcript']])await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event,target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.replayEvents.push(name?{name,payload:e.payload,receivedHostMs:Date.now()}:{...e.payload,receivedHostMs:Date.now()}))});});
 for(let i=0;i<600;i++){if(await connection.overlay.evaluate(()=>Boolean(document.querySelector('.answer-content'))))break;await sleep(100);}await connection.overlay.evaluate(installPaintedAnswerRecorder);
 let boot=await invoke('bootstrap');assert(boot.debug&&!boot.snapshot.active);
 const outputs=boot.devices.filter(d=>d.source==='remote'&&d.name.includes('T24E390'));assert.equal(outputs.length,1);journal.outputDevice=outputs[0].name;
 const settings={...boot.settings,answerBackend:backend,answerObjective:plan.objective??'detailed',model:plan.model,reasoningEffort:plan.effort,serviceTier:plan.serviceTier??null,output:outputs[0].id,microphone:'',projectPath:'',speechChunkMs:160};
 await invoke('save_settings',{settings});
 if(backend==='chatgpt'){boot=await invoke('bootstrap');const account=boot.accounts.find(a=>a.planEnabled);assert(account,'No saved authorized direct-plan account');await invoke('select_account',{clientId:account.clientId});}
 const models=await invoke('list_models');assert(models.some(m=>m.slug===plan.model));journal.capabilities={availableModel:true,effort:plan.effort,validatedBy:'Startup completes a real stream using these settings. Codex additionally checks supportedReasoningEfforts.',billedApiFallback:false};
 await invoke('start_meeting',{settings});active=true;
 const start=Date.now();journal.sessionStartedAt=new Date(start).toISOString();
 const fingerprints=new Map(),latest=new Map();let paintOffset=0;
 const pollOnce=async()=>{
  const hostBeforeMs=Date.now(),state=await invoke('acceptance_jobs'),hostAfterMs=Date.now();journal.archive=state.archive;
  for(const job of state.jobs)latest.set(job.question.id,job);
  const observation=changedJobObservation(state,fingerprints,{hostBeforeMs,hostAfterMs});if(observation.jobs.length)journal.deepObservations.push(observation);
  const paint=await connection.overlay.evaluate(offset=>window.deepPaintSamples.slice(offset),paintOffset);paintOffset+=paint.length;journal.overlayPaintSamples.push(...paint);
 };
 let pendingPoll=null;
 const poll=()=>pendingPoll??=(async()=>{try{await pollOnce();}finally{pendingPoll=null;}})();
 sampling=true;sampler=(async()=>{while(sampling){try{await poll();}catch(e){journal.pollErrors.push(String(e));}await sleep(70);}})();
 const anchor=async()=>{const hostBeforeMs=Date.now(),state=await invoke('acceptance_jobs'),hostAfterMs=Date.now();return{hostBeforeMs,hostAfterMs,nativeMs:state.nativeNow};};
 const collect=async(row,before,after,eventOffset,settle=true)=>{
  if(settle){if(row.audio)await sleep(2500);const end=Date.now()+(row.observationBudgetMs??120000);while(Date.now()<end){await poll();const jobs=[...latest.values()].filter(j=>j.question.detectedAt>=before.nativeMs).sort((a,b)=>a.question.detectedAt-b.question.detectedAt);const job=jobs.at(-1);if(job&&(job.error||job.latency.completedAt!=null))break;await sleep(70);}}
  await poll();const jobs=[...latest.values()].filter(j=>j.question.detectedAt>=before.nativeMs);const job=jobs.filter(j=>j.confirmed&&!j.cancelled).at(-1)??jobs.at(-1);
  Object.assign(row,{recognizedQuestion:job?.question.text??null,answer:job?.answer??'',phase:job?.phase??'no_job',error:job?.error??null,cancelled:job?.cancelled??false,selectedContext:job?.selectedContext??null,responseVersion:job?`${job.question.id}:${job.latency.responseRevision??0}`:null,latency:job?.latency??null,
   events:await connection.main.evaluate(offset=>window.replayEvents.slice(offset),eventOffset),archive:journal.archive});
  if(row.audio){row.audio.clockAnchors=[before,after];row.firstStreamedWordMeasurement=streamedWordLatency(journal,row);}
  journal.rows.push(row);await persist();console.log(JSON.stringify({row:journal.rows.length,name:row.name,phase:row.phase,error:row.error,firstWord:row.firstStreamedWordMeasurement?.firstRetainedVisibleStreamedWord?.latencyMs??null,archive:journal.archive}));
  return row;
 };
 for(const [index,item]of plan.turns.entries()){
  if(item.atMs!=null){while(Date.now()-start<item.atMs)await sleep(Math.min(1000,item.atMs-(Date.now()-start)));}
  if(item.afterDisplayed){const previous=journal.rows.at(-1),end=Date.now()+120000;let met=false;while(Date.now()<end){const state=await invoke('acceptance_jobs');const target=state.jobs.filter(j=>j.confirmed&&j.question.detectedAt>=previous.nativeStartedAt).at(-1);if(target&&await connection.overlay.evaluate(id=>window.deepPaintSamples.some(p=>p.questionId===id&&p.visible&&p.visibleEnd-p.visibleStart>25),target.question.id)){met=true;break;}await sleep(50);}item.displayedConditionMet=met;}
  const before=await anchor(),eventOffset=await connection.main.evaluate(()=>window.replayEvents.length),row={round:index+1,...item,question:item.question,sourceBinding:item.sourceBinding??null,startedHostMs:Date.now(),applicationAgeMs:Date.now()-Date.parse(journal.startedAt),nativeStartedAt:before.nativeMs,runningAtSubmission:(await invoke('acceptance_jobs')).jobs.filter(j=>j.running).map(j=>j.question.id)};
  if(item.fixedContext!=null){await invoke('action',{action:'dismiss'});await invoke('acceptance_freeze_context',{context:item.fixedContext,policy:'existing'});}
  if(item.clearFixedContext){await invoke('action',{action:'dismiss'});await invoke('acceptance_freeze_context',{context:'',policy:'existing'});}
  if(item.disconnectBackend)await invoke('acceptance_disconnect_answers');
  if(item.waveFile){const wave=await readFile(item.waveFile);assert.equal(hash(wave),item.waveSha256);const playing=(await invoke('acceptance_jobs')).jobs.filter(j=>j.running).map(j=>j.question.id);const playbackFile=path.join(out,`round-${String(index+1).padStart(2,'0')}.playback.json`);
   await child('powershell.exe',['-NoProfile','-File',path.resolve('scripts/play-fixture-device.ps1'),'-InputPath',path.resolve(item.waveFile),'-OutputName',journal.outputDevice,'-TimingPath',playbackFile]);row.audio={waveFile:item.waveFile,sha256:item.waveSha256,playback:JSON.parse(await readFile(playbackFile)),runningAtPlaybackLaunch:playing};
  } else {await invoke('ask',{question:item.question});row.measurement='Typed native request: no audio, ASR or automatic endpoint delay.';}
  const after=await anchor();row.clockAnchors=[before,after];await collect(row,before,after,eventOffset,item.settle!==false);
  if(item.sampleResources){try{journal.resourceSamples.push(JSON.parse(await child('powershell.exe',['-NoProfile','-File',path.resolve('scripts/sample-interview-process.ps1'),'-ProcessId',String(app.pid)])));}catch(e){journal.pollErrors.push(String(e));}}
 }
 if(plan.minimumDurationMs){while(Date.now()-start<plan.minimumDurationMs)await sleep(Math.min(1000,plan.minimumDurationMs-(Date.now()-start)));}
 journal.actualInterviewDurationMs=Date.now()-start;await poll();
 for(let i=0;i<journal.rows.length;i++){
  const row=journal.rows[i],next=journal.rows[i+1]?.nativeStartedAt??Infinity;
  const jobs=[...latest.values()].filter(j=>j.question.detectedAt>=row.nativeStartedAt&&j.question.detectedAt<next);
  const job=jobs.filter(j=>j.confirmed&&!j.cancelled).at(-1)??jobs.at(-1);
  if(job){Object.assign(row,{recognizedQuestion:job.question.text,answer:job.answer,phase:job.phase,error:job.error,cancelled:job.cancelled,selectedContext:job.selectedContext,responseVersion:`${job.question.id}:${job.latency.responseRevision??0}`,latency:job.latency});if(row.audio)row.firstStreamedWordMeasurement=streamedWordLatency(journal,row);}
 }
journal.timings=await invoke('get_answer_timings');
 await invoke('stop_meeting');active=false;journal.stoppedCleanly=!(await invoke('get_snapshot')).active;journal.status='complete';
}catch(e){journal.status='failed';journal.failure=String(e);console.error(String(e));process.exitCode=1;}
finally{sampling=false;if(sampler)await sampler;if(active&&invoke)await invoke('stop_meeting').catch(()=>{});connection?.close();if(app?.exitCode===null){app.kill();await new Promise(r=>app.once('exit',r));}vite?.kill();journal.completedAt=new Date().toISOString();await persist();}
