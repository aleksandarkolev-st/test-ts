// Recording-only normal-auth playback through the existing native app.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connectNativePages} from '../scripts/lib/native-cdp.mjs';
import {installPaintedAnswerRecorder} from '../scripts/lib/painted-answer-recorder.mjs';
const root=process.cwd(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const preflight=JSON.parse(await readFile('artifacts/deep-interview-v70/chatgpt-backend-comparison/chatgpt-preflight.json'));
assert.equal(preflight.status,'available','Requested ChatGPT model must be verified before playback');
const queue=(await readFile('artifacts/deep-interview-v70/remaining-runs.jsonl','utf8')).trim().split('\n').map(s=>JSON.parse(s.replace(/^\uFEFF/,''))).at(-1);
assert.equal(queue.event,'scheduled_playback_runs_finished');
const manifest=JSON.parse(await readFile('artifacts/deep-interview-v70/backend-comparison-cases.json'));
const out=path.join(root,'artifacts/deep-interview-v70/backend-playback-comparison');
await mkdir(out);const appDir=path.join(out,'app'),dataDir=path.join(out,'data');
await mkdir(appDir);await mkdir(dataDir);
for(const file of await readdir('src-tauri/target/debug'))if(file==='meeting-copilot.exe'||file.endsWith('.dll'))await copyFile(path.join(root,'src-tauri/target/debug',file),path.join(appDir,file));
const captureProofFile='docs/evidence/normal-auth-remote-only-capture-v70.json';
const captureProofBytes=await readFile(captureProofFile),captureProof=JSON.parse(captureProofBytes);
assert.equal(captureProof.nativeBinary.sha256,hash(await readFile(path.join(appDir,'meeting-copilot.exe'))),'Normal-auth playback requires the verified remote-only debug binary');
assert.equal(captureProof.source.sha256,hash(await readFile(captureProof.source.file)));
assert.equal(captureProof.normalAuthenticationCompatibleWithRemoteOnly,true);
const cases=[];
for(const name of ['histogram-late-reversal-exact-pause','long-question-essential-tail-exact-pause','cuda-to-phantom-reads']){
 const directory=`artifacts/deep-interview-v70/hard-probes/${name}`;
 const bytes=await readFile(`${directory}/interview.json`),journal=JSON.parse(bytes);
 cases.push({name,journalSha256:hash(bytes),waves:await Promise.all(journal.rows.map(async row=>{
  const file=path.join(root,directory,row.audio.waveFile),wave=await readFile(file);
  assert.equal(hash(wave),row.audio.sha256);
  return {file,sha256:hash(wave),sourceQuestion:row.question};
 }))});
}
const env={...process.env,COPILOT_DATA_DIR:dataDir,COPILOT_ACCEPTANCE_REMOTE_ONLY:'1',WEBVIEW2_USER_DATA_FOLDER:path.join(out,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9243'};
for(const key of ['COPILOT_ACCEPTANCE','COPILOT_TEST_API','COPILOT_ACCEPTANCE_INPUT_ONLY','COPILOT_ACCEPTANCE_SELF_LOOPBACK'])delete env[key];
const result={status:'in_progress',startedAt:new Date().toISOString(),model:manifest.model,effort:manifest.effort,serviceTier:manifest.serviceTier,
 nativeBinarySha256:hash(await readFile(path.join(appDir,'meeting-copilot.exe'))),normalSavedAuthentication:true,microphoneUsed:false,
 remoteOnlyCaptureProof:{file:captureProofFile,sha256:hash(captureProofBytes)},
 scope:'Matched saved public waveforms through the existing native capture, ASR, route-specific detector/scheduler and actual overlay. Normal saved ChatGPT authentication, isolated workspace database, debug remote-only capture. New meeting per case; original selected memory is not injected. Source-to-visible-answer matching and independent accuracy review remain separate.',cases:[],productionLogicChanged:false};
let app,vite,connection,invoke,polling=false,pending=Promise.resolve(),timer;
const persist=()=>writeFile(path.join(out,'playback.json'),JSON.stringify(result,null,2));
const runChild=(file,args)=>new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',chunk=>error=(error+chunk).slice(-2000));child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Playback exited ${code}: ${error}`)));});
try{
 try{await fetch('http://127.0.0.1:1420');}catch{
  vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});
  let ready=false;
  for(let i=0;i<300;i++){try{await fetch('http://127.0.0.1:1420');ready=true;break;}catch{await sleep(100);}}
  assert(ready,'Frontend preview unavailable');
 }
 // The serial launcher checks for other native owners before invoking this file.
 app=spawn(path.join(appDir,'meeting-copilot.exe'),[],{cwd:root,windowsHide:true,env,stdio:'ignore'});result.nativeProcessId=app.pid;
 for(let i=0;i<600;i++){try{connection=await connectNativePages(9243);break;}catch{assert(app.exitCode===null,'Native app exited before CDP became available');await sleep(100);}}
 assert(connection,'Native main and overlay unavailable');
 invoke=(name,args={})=>connection.main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
 for(let i=0;i<600;i++){if(await connection.overlay.evaluate(()=>Boolean(document.querySelector('.answer-content'))))break;await sleep(100);}
 await connection.main.evaluate(async()=>{
  window.nativeInterviewEvents=[];
  await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'copilot:event',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.nativeInterviewEvents.push({...e.payload,receivedHostMs:Date.now()}))});
  await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'copilot:transcript',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.nativeInterviewEvents.push({name:'transcript',payload:e.payload,receivedHostMs:Date.now()}))});
 });
 await connection.overlay.evaluate(installPaintedAnswerRecorder);
 const initial=await invoke('bootstrap');assert(initial.debug&&!initial.snapshot.active);
 const output=initial.devices.filter(d=>d.source==='remote'&&d.name.includes('T24E390'));assert.equal(output.length,1,'T output must be unambiguous');
 result.outputDevice=output[0].name;
 let settings={...initial.settings,answerBackend:'chatgpt',model:manifest.model,reasoningEffort:manifest.effort,serviceTier:manifest.serviceTier,output:output[0].id,microphone:'',projectPath:'',speechChunkMs:160};
 await invoke('save_settings',{settings});
 const chatBoot=await invoke('bootstrap');const account=chatBoot.accounts.find(a=>a.planEnabled);assert(account,'Saved ChatGPT account missing');
 await invoke('select_account',{clientId:account.clientId});
 const models=await invoke('list_models');assert(models.some(m=>m.slug===manifest.model),'Verified model no longer available');
 for(const [caseIndex,source] of cases.entries()){
  const order=caseIndex%2?['chatgpt','codex']:['codex','chatgpt'];
  for(const backend of order){
   const record={name:source.name,backend,sourceJournalSha256:source.journalSha256,waves:[],snapshots:[],events:[],paintSamples:[],timings:null,pollErrors:[]};result.cases.push(record);
   settings={...settings,answerBackend:backend};await invoke('save_settings',{settings});
   const startBeforeHostMs=Date.now();await invoke('start_meeting',{settings});const startAfterHostMs=Date.now();
   record.sessionClockOriginHostBounds={low:startBeforeHostMs,high:startAfterHostMs,
    scope:'Broad bounds: runtime start_session creates its zero clock during the awaited start_meeting request. Includes authentication, prewarming and speech startup; not a precise clock calibration. Primary painted latency uses host/device endpoints directly.'};
   record.speechConfiguration={remoteOnly:true,microphoneCapture:{kind:'disabled',physicalMicrophoneUsed:false},speechChunkMs:settings.speechChunkMs,speechBackend:settings.speechBackend};
   let offset=await connection.main.evaluate(()=>window.nativeInterviewEvents.length),lastSnapshot=null,paintOffset=await connection.overlay.evaluate(()=>window.deepPaintSamples.length);
   const poll=async()=>{
    const hostBeforeMs=Date.now(),snapshot=await invoke('get_snapshot'),hostAfterMs=Date.now();
    const encoded=JSON.stringify(snapshot);if(encoded!==lastSnapshot){record.snapshots.push({hostBeforeMs,hostAfterMs,snapshot});lastSnapshot=encoded;}
    const events=await connection.main.evaluate(offset=>({total:window.nativeInterviewEvents.length,events:window.nativeInterviewEvents.slice(offset).filter(e=>e.name!=='answer.provisional_prefix'&&(e.name!=='transcript'||e.payload?.final)&&(e.name!=='asr.raw_boundary'||e.payload?.final))}),offset);offset=events.total;record.events.push(...events.events);
    const paints=await connection.overlay.evaluate(offset=>({total:window.deepPaintSamples.length,paints:window.deepPaintSamples.slice(offset)}),paintOffset);paintOffset=paints.total;record.paintSamples.push(...paints.paints);
    return snapshot;
   };
   polling=true;timer=setInterval(()=>{if(polling){pending=pending.then(poll);pending.catch(error=>record.pollErrors.push({hostMs:Date.now(),error:String(error)}));}},70);
   for(const [waveIndex,wave] of source.waves.entries()){
    if(waveIndex){
     const deadline=Date.now()+120000;
     while(!record.paintSamples.some(p=>p.visible&&p.visibleEnd>p.visibleStart&&/[\p{L}\p{N}_]+(?:['’_-][\p{L}\p{N}_]+)*(?=[^\p{L}\p{N}_'’_-])/u.test(p.text.slice(p.visibleStart,p.visibleEnd)))){if(Date.now()>=deadline)break;await sleep(100);}
    }
    const timingFile=path.join(out,`${source.name}-${backend}-${waveIndex+1}-playback.json`);
    const beforeHostMs=Date.now(),before=await invoke('get_snapshot'),afterHostMs=Date.now();
    record.snapshots.push({hostBeforeMs:beforeHostMs,hostAfterMs:afterHostMs,snapshot:before,origin:'before_playback_request'});
    await runChild('powershell.exe',['-NoProfile','-File',path.join(root,'scripts/play-fixture-device.ps1'),'-InputPath',wave.file,'-OutputName',result.outputDevice,'-TimingPath',timingFile]);
    record.waves.push({...wave,file:path.relative(root,wave.file),playback:JSON.parse(await readFile(timingFile)),
     visibleSnapshotBeforePlaybackRequest:{hostBeforeMs:beforeHostMs,hostAfterMs:afterHostMs,snapshot:before},
     visibleResponseBeforePlaybackRequest:before.question?.id??null,
     priorAnswerStreamingBeforePlaybackRequest:before.latency?.completedAt==null&&Boolean(before.answer)});
    await persist();
   }
   const deadline=Date.now()+130000;let settled=false;
   while(Date.now()<deadline){await pending;const snapshot=record.snapshots.at(-1)?.snapshot;
    if(snapshot?.error){record.observedError=snapshot.error;break;}
    const lastEnd=record.events.filter(e=>e.name==='speech.ended'&&e.payload?.source==='remote').at(-1)?.payload.timestamp;
    if(snapshot?.question&&snapshot.latency?.completedAt!=null&&snapshot.latency?.questionConfirmedAt>=lastEnd){settled=true;await sleep(500);break;}
    await sleep(100);
   }
   record.settledAfterPlayback=settled;polling=false;clearInterval(timer);await pending;await poll();
   record.timings=await invoke('get_answer_timings');record.finalSnapshot=record.snapshots.at(-1)?.snapshot;
   await invoke('stop_meeting');record.afterStopSnapshot=await invoke('get_snapshot');
   record.stoppedCleanly=!record.afterStopSnapshot.active&&!record.afterStopSnapshot.answer&&!record.afterStopSnapshot.questions.length;
   assert(record.stoppedCleanly,'Meeting did not stop cleanly');await persist();console.log(`Recorded actual ${backend} playback: ${source.name}`);
  }
 }
 result.status='complete';result.stoppedCleanly=result.cases.every(record=>record.stoppedCleanly);result.independentAccuracyPending=true;
}catch(error){result.status='failed';result.error=String(error);throw error;}
finally{
 polling=false;clearInterval(timer);await pending.catch(()=>{});
 if(invoke)await invoke('stop_meeting').catch(()=>{});
 connection?.close();if(app?.exitCode===null){app.kill();await new Promise(resolve=>app.once('exit',resolve));}
 if(vite?.exitCode===null)vite.kill();
 result.completedAt=new Date().toISOString();await persist();
}
