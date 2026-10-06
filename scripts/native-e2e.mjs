import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(); const soakMinutes=Number(process.env.COPILOT_SOAK_MINUTES||0);
const artifactName=process.env.COPILOT_NATIVE_ARTIFACT_NAME||(soakMinutes?'soak':'native');
assert.match(artifactName,/^[A-Za-z0-9_-]+$/,'Native artifact name must be a simple folder name');
const artifact=path.join(root,'artifacts',artifactName); await mkdir(artifact,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let requests=[];let cancelled=0;
const server=createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer fixture-token'){res.writeHead(401).end();return;}
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{slug:'fixture-mini',display_name:'Native fixture model',visibility:'list'}]}));return;}
  if(req.url!=='/v1/responses'){res.writeHead(404).end();return;}
  let body='';for await(const chunk of req)body+=chunk;let parsed=JSON.parse(body);assert.equal(parsed.store,false);assert.equal(parsed.stream,true);assert.equal(parsed.model,'fixture-mini');assert.equal(Object.hasOwn(parsed,'temperature'),false);assert.equal(Object.hasOwn(parsed,'max_output_tokens'),false);assert.equal(parsed.input[0].role,'user');requests.push(parsed);
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  let completed=false;res.on('close',()=>{if(!completed)cancelled++;});
  const slow=parsed.input[0].content.includes('first target');
  const deltas=parsed.instructions.includes('JSON')?[JSON.stringify({summary:'Synthetic fixture discussion',facts:[],decisions:[],dates:[],people:[],open_questions:[]})]:['The launch ','target is ','October 28.'];
  for(const delta of deltas){if(res.destroyed)return;res.write(`data: ${JSON.stringify({type:'response.output_text.delta',delta})}\r\n\r\n`);await sleep(slow?700:80);}
  if(!res.destroyed){completed=true;res.end(`data: ${JSON.stringify({type:'response.completed'})}\r\n\r\n`);}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port; const debugPort=Number(process.env.COPILOT_CDP_PORT||9227);
let app,browser,vite,stderr='';const results={kind:'native acceptance with local HTTP fixture',checks:[],localTranscription:[],startedAt:new Date().toISOString()};
function passed(name){results.checks.push({name,pass:true});console.log(`PASS ${name}`);}
try{
  // Windows locks loaded DLLs. An isolated copy allows builds and additional
  // tests while a long-running native acceptance session owns these files.
  const executableDir=path.join(root,soakMinutes?'.local/soak-app':'.local/native-app');await mkdir(executableDir,{recursive:true});
  const buildDir=path.join(root,'src-tauri/target/debug');
  for(const name of await readdir(buildDir)){if(name==='meeting-copilot.exe'||name.endsWith('.dll'))await copyFile(path.join(buildDir,name),path.join(executableDir,name));}
  try{await fetch('http://127.0.0.1:1420');}catch{vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:1420');break;}catch{await sleep(100);}}}
  app=spawn(path.join(executableDir,'meeting-copilot.exe'),[],{cwd:root,windowsHide:true,env:{...process.env,COPILOT_ACCEPTANCE:'1',COPILOT_TEST_API:`http://127.0.0.1:${port}/v1`,COPILOT_DATA_DIR:path.join(root,soakMinutes?'.local/soak-data':'.local/native-data'),WEBVIEW2_USER_DATA_FOLDER:path.join(root,soakMinutes?'.local/webview-soak':'.local/webview-test'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort}`},stdio:['ignore','ignore','pipe']});
  app.stderr.on('data',b=>{stderr+=b.toString();});
  for(let i=0;i<150;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);break;}catch{if(app.exitCode!==null)throw Error(`Native app exited ${app.exitCode}: ${stderr.slice(-2000)}`);await sleep(100);}}
  assert(browser,'WebView2 debug endpoint did not open');const context=browser.contexts()[0];let main,overlay;
  for(let i=0;i<100;i++){main=context.pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));overlay=context.pages().find(p=>p.url().includes('view=overlay'));if(main&&overlay)break;await sleep(100);}assert(main&&overlay,`Both native windows must load: ${context.pages().map(p=>p.url()).join(', ')}; startup: ${stderr.slice(-2000)}`);
  const invoke=(name,args={})=>main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
  const until=async(predicate,timeout=8000)=>{const start=Date.now();while(Date.now()-start<timeout){const s=await invoke('get_snapshot');if(predicate(s))return s;await sleep(30);}throw Error('Native state condition timed out');};
  const b=await invoke('bootstrap');assert(b.debug);assert(b.devices.some(d=>d.source==='remote'));assert(b.devices.some(d=>d.source==='self'));passed('WASAPI enumerates independent remote and microphone devices');
  const before=await invoke('native_diagnostics');assert(before.affinityRead&&before.affinity===17);assert(before.noActivate&&before.alwaysOnTop);passed('Native HWND affinity readback, topmost and no-activate styles');
  const settings={...b.settings,microphone:b.devices.find(d=>d.source==='self'&&d.default)?.id||b.devices.find(d=>d.source==='self').id,output:b.devices.find(d=>d.source==='remote'&&d.default)?.id||b.devices.find(d=>d.source==='remote').id,model:'fixture-mini'};
  await invoke('start_meeting',{settings});await until(s=>s.active&&s.status==='listening');const after=await invoke('native_diagnostics');assert(after.visible);assert.notEqual(after.foregroundHwnd,after.overlayHwnd);passed('Real WASAPI and Whisper start with visible non-focused overlay');
  if(process.env.COPILOT_REAL_AUDIO==='1'){
    const audioPath=path.join(root,'.local/audio/remote-question.wav');
    await new Promise((resolve,reject)=>{const playback=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/play-fixture.ps1'),'-InputPath',audioPath],{windowsHide:true,stdio:'ignore'});playback.on('error',reject);playback.on('exit',code=>code===0?resolve():reject(Error(`Fixture playback failed: ${code}`)));});
    await until(s=>s.question?.text.toLowerCase().includes('launch')&&s.answer.length>0,15000);const real=await until(s=>s.latency&&s.latency.completedAt!==null,15000);results.realAudioLatencyMs=real.latency.firstTokenAt-real.latency.speechStoppedAt;passed('Real rendered speech → WASAPI loopback → local VAD/Whisper → detected question → HTTP stream → overlay');
    await invoke('action',{action:'dismiss'});await until(s=>!s.question);requests=[];
  }
  await invoke('acceptance_event',{kind:'started',source:'self',text:null});await invoke('acceptance_event',{kind:'ended',source:'self',text:null});await invoke('acceptance_event',{kind:'transcript',source:'self',text:'What is our own launch date?'});await sleep(700);assert.equal(requests.length,0);passed('SELF speech never starts an automatic answer');
  await invoke('acceptance_event',{kind:'started',source:'remote',text:null});await invoke('acceptance_event',{kind:'ended',source:'remote',text:null});await invoke('acceptance_event',{kind:'transcript',source:'remote',text:'What is the first target?'});
  const first=await until(s=>s.answer.length>0);assert.equal(first.latency.completedAt,null);passed('Automatic remote question streams useful text before completion');
  await invoke('acceptance_event',{kind:'started',source:'remote',text:null});await until(s=>s.answer===''&&s.question===null);await invoke('acceptance_event',{kind:'ended',source:'remote',text:null});await invoke('acceptance_event',{kind:'transcript',source:'remote',text:'Assuming approval next week'});
  await until(s=>s.question?.text.includes('Assuming approval next week')&&s.answer.length>0);assert(requests[1].input[0].content.includes('What is the first target? Assuming approval next week'));assert(cancelled>=1);passed('Continued question cancels HTTP stream and regenerates with appended context');
  await until(s=>s.latency&&s.latency.completedAt!==null);
  await invoke('acceptance_event',{kind:'started',source:'remote',text:null});await invoke('acceptance_event',{kind:'ended',source:'remote',text:null});await invoke('acceptance_event',{kind:'transcript',source:'remote',text:'With the customer approval included'});
  await until(s=>s.question?.text.includes('With the customer approval included')&&s.answer.length>0);passed('Short continuation regenerates even after a fast answer has completed');
  await invoke('action',{action:'dismiss'});await until(s=>!s.question&&s.answer==='');await sleep(800);assert.equal((await invoke('get_snapshot')).answer,'');passed('Dismiss ignores all late tokens from cancelled generation');
  await invoke('ask',{question:'What did we decide?'});await until(s=>s.latency&&s.latency.completedAt!==null&&s.answer.includes('October'));assert(requests.at(-1).input[0].content.includes('SELF: What is our own launch date?'));passed('Manual ask shares meeting context and completes streaming');
  await invoke('action',{action:'expand'});await until(s=>s.expanded&&s.latency&&s.latency.completedAt!==null);assert(requests.at(-1).instructions.includes('6 short sentences'));passed('More regenerates the same question with the expanded prompt');
  await overlay.getByText('October 28.',{exact:false}).waitFor();await overlay.screenshot({path:path.join(artifact,'overlay.png')});
  await invoke('action',{action:'pause'});await until(s=>s.paused);await invoke('action',{action:'pause'});await until(s=>!s.paused);passed('Pause releases capture and resume reopens both devices');
  const visible=async(expected)=>{for(let i=0;i<100;i++){if((await invoke('native_diagnostics')).visible===expected)return;await sleep(20);}assert.fail(`Overlay visibility did not become ${expected}`);};
  await invoke('action',{action:'hide'});await visible(false);await invoke('action',{action:'hide'});await visible(true);passed('Native overlay hide/show');
  if(process.env.COPILOT_CAPTURE_TEST==='1'){
    const {testCapture}=await import('./obs-capture.mjs');results.capture=await testCapture(invoke);passed('OBS display and window capture: protected output compared with visible positive controls');
  }
  const negativeMinutes=Number(process.env.COPILOT_NEGATIVE_MINUTES||0);
  if(negativeMinutes){
    assert(negativeMinutes>=10,'False-trigger acceptance requires ten wall-clock minutes');
    const {readFile}=await import('node:fs/promises');const labels=JSON.parse(await readFile(path.join(root,'tests/fixtures/utterances.json'),'utf8'));
    const negatives=labels.map((l,i)=>({l,i})).filter(x=>!x.l.question);await invoke('action',{action:'dismiss'});requests=[];
    const started=Date.now(),deadline=started+negativeMinutes*60_000;let clips=0,summaryRequests=0;
    while(Date.now()<deadline){
      const index=negatives[clips%negatives.length].i;const audio=path.join(root,`.local/audio/corpus/${String(index).padStart(3,'0')}.wav`);
      await new Promise((resolve,reject)=>{const player=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/play-fixture.ps1'),'-InputPath',audio],{windowsHide:true,stdio:'ignore'});player.on('error',reject);player.on('exit',c=>c===0?resolve():reject(Error('Negative fixture playback failed')));});
      await sleep(1200);clips++;
      const s=await invoke('get_snapshot');assert(s.active&&!s.paused&&!s.error,`Capture failed during negative playback: ${s.error || s.status}`);
      const answers=requests.filter(r=>!r.instructions.includes('JSON'));assert.equal(answers.length,0,'A controlled negative speech clip triggered an automatic answer');summaryRequests+=requests.length;requests=[];
      if(clips%10===0)console.log(`NEGATIVE AUDIO ${Math.round((Date.now()-started)/60_000)} / ${negativeMinutes} min: zero false answer requests`);
    }
    assert(summaryRequests>0,'The long-context test did not exercise summarization');assert(summaryRequests<=Math.ceil(negativeMinutes*2)+2,'Summarization ran more often than the thirty-second cadence');
    results.falseTriggerTest={kind:'controlled synthetic statements and rhetorical questions through real WASAPI; not a human meeting certification',elapsedMs:Date.now()-started,clips,falseAnswerRequests:0,summaryRequests};
    passed('Ten-minute controlled negative audio playback produced zero automatic answer requests');
  }
  if(soakMinutes){
    assert(soakMinutes>=60,'Acceptance requires at least 60 wall-clock minutes');
    const deadline=Date.now()+soakMinutes*60_000;results.soakStartedAt=new Date().toISOString();results.soakSamples=[];
    while(Date.now()<deadline){
      await invoke('ask',{question:'What is the launch target?'});await until(s=>s.latency&&s.latency.completedAt!==null&&s.answer.length>0);
      const diag=await invoke('native_diagnostics');assert.notEqual(diag.foregroundHwnd,diag.overlayHwnd);assert(diag.affinityRead&&diag.affinity===17);
      const s=await invoke('get_snapshot');assert(s.active&&!s.paused&&!s.error);
      results.soakSamples.push({elapsedMs:Date.now()-Date.parse(results.soakStartedAt),firstTokenMs:s.latency.firstTokenAt-s.latency.requestSentAt,requests:requests.length});
      // Never retain the meeting text in the harness for the duration of a soak.
      requests=[];await writeFile(path.join(artifact,'progress.json'),JSON.stringify({...results,checks:results.checks},null,2));
      console.log(`SOAK ${Math.round((Date.now()-Date.parse(results.soakStartedAt))/60_000)} / ${soakMinutes} min: native capture and streaming healthy`);
      await sleep(Math.min(60_000,Math.max(0,deadline-Date.now())));
    }
    results.soakElapsedMs=Date.now()-Date.parse(results.soakStartedAt);passed('60 minute wall-clock native meeting: capture, repeated streaming, focus and affinity checks');
  }
  await invoke('stop_meeting');const stopped=await until(s=>!s.active);assert.equal(stopped.answer,'');assert.equal(stopped.question,null);assert.equal(stopped.latency,null);assert.equal((await invoke('native_diagnostics')).visible,false);passed('Stop releases capture, cancels requests, clears private state and hides overlay');
  await main.screenshot({path:path.join(artifact,'setup.png')});
  results.pass=true;
}catch(e){results.pass=false;results.failure=String(e);throw e;}finally{
  results.completedAt=new Date().toISOString();for(const line of stderr.split(/\r?\n/)){if(line.startsWith('local_stt ')){try{const v=JSON.parse(line.slice(10));results.localTranscription.push({source:v.source,kind:v.kind,previewReused:v.preview_reused,queueWaitMs:v.queue_wait_ms,inferenceMs:v.inference_ms});}catch{}}}await writeFile(path.join(artifact,'results.json'),JSON.stringify(results,null,2));await browser?.close();app?.kill();vite?.kill();server.closeAllConnections();server.close();
}
