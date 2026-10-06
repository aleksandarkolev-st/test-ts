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
  const requestText=typeof parsed.input[0].content==='string'?parsed.input[0].content:parsed.input[0].content.find(c=>c.type==='input_text').text;
  const slow=requestText.includes('first target');
  const deltas=parsed.instructions.includes('JSON')?[JSON.stringify({summary:'Synthetic fixture discussion',facts:[],decisions:[],dates:[],people:[],open_questions:[]})]:['The launch ','target is ','October 28.'];
  for(const delta of deltas){if(res.destroyed)return;res.write(`data: ${JSON.stringify({type:'response.output_text.delta',delta})}\r\n\r\n`);await sleep(slow?700:80);}
  if(!res.destroyed){completed=true;res.end(`data: ${JSON.stringify({type:'response.completed'})}\r\n\r\n`);}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port; const debugPort=Number(process.env.COPILOT_CDP_PORT||9227);
let app,browser,vite,main,stderr='';const results={kind:'native acceptance with local HTTP fixture',checks:[],localTranscription:[],startedAt:new Date().toISOString()};
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
  assert(browser,'WebView2 debug endpoint did not open');const context=browser.contexts()[0];let overlay;
  for(let i=0;i<100;i++){main=context.pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));overlay=context.pages().find(p=>p.url().includes('view=overlay'));if(main&&overlay)break;await sleep(100);}assert(main&&overlay,`Both native windows must load: ${context.pages().map(p=>p.url()).join(', ')}; startup: ${stderr.slice(-2000)}`);
  const invoke=(name,args={})=>main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
  await main.evaluate(async()=>{window.fixtureTranscripts=[];await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'copilot:transcript',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.fixtureTranscripts.push(e.payload))});});
  const until=async(predicate,timeout=8000)=>{const start=Date.now();while(Date.now()-start<timeout){const s=await invoke('get_snapshot');if(predicate(s))return s;await sleep(30);}throw Error('Native state condition timed out');};
  const b=await invoke('bootstrap');assert(b.debug);assert(b.devices.some(d=>d.source==='remote'));assert(b.devices.some(d=>d.source==='self'));passed('WASAPI enumerates independent remote and microphone devices');
  const before=await invoke('native_diagnostics');assert(before.affinityRead&&before.affinity===17);assert(before.noActivate&&before.alwaysOnTop);passed('Native HWND affinity readback, topmost and no-activate styles');
  const settings={...b.settings,microphone:b.devices.find(d=>d.source==='self'&&d.default)?.id||b.devices.find(d=>d.source==='self').id,output:b.devices.find(d=>d.source==='remote'&&d.default)?.id||b.devices.find(d=>d.source==='remote').id,model:'fixture-mini',projectPath:path.join(root,'.local/context-fixture')};
  results.speechBackend=settings.speechBackend;results.speechChunkMs=settings.speechChunkMs;results.speechGpu=settings.nemotronDevice;
  if(settings.speechBackend==='nemotron'){
    const pending=invoke('start_meeting',{settings}).then(()=>({started:true}),error=>({error:String(error)}));
    await until(s=>s.active&&s.status==='loading');await invoke('stop_meeting');
    const cancelledStartup=await pending;assert.match(cancelledStartup.error||'',/cancelled/i);
    await sleep(1200);const cancelledState=await invoke('get_snapshot');assert.equal(cancelledState.active,false);assert.equal(cancelledState.status,'off');
    passed('Cancel during Nemotron loading stays responsive and late startup cannot reactivate capture');
  }
  const contextShortcut=async letter=>{
    assert(['p','{F8}'].includes(letter));const key=`Ctrl+Shift+${letter==='p'?'P':'F8'}`;
    assert(!b.shortcutErrors.some(e=>e.startsWith(`${key} is unavailable;`)),`${key} must be registered by this isolated app before sending the chord`);
    await new Promise((resolve,reject)=>{const keys=spawn('powershell.exe',['-NoProfile','-Command',`$copilotShortcutShell=New-Object -ComObject WScript.Shell; $copilotShortcutShell.SendKeys('^+${letter}')`],{windowsHide:true,stdio:'ignore'});keys.on('error',reject);keys.on('exit',code=>code===0?resolve():reject(Error(`Shortcut injection failed: ${code}`)));});
  };
  await invoke('start_meeting',{settings});await until(s=>s.active&&s.status==='listening');const after=await invoke('native_diagnostics');assert(after.visible);assert.notEqual(after.foregroundHwnd,after.overlayHwnd);passed(`Real WASAPI and ${settings.speechBackend} start with visible non-focused overlay`);
  if(process.env.COPILOT_REAL_AUDIO==='1'){
    const audioCases=[{file:'remote-question.wav',word:'launch',category:'direct_wh'}, {file:'corpus/012.wav',word:'approve',category:'yes_no'}, {file:'corpus/015.wav',word:'outage',category:'quantity'}];
    results.realAudioSamples=[];
    for(let sample=0;sample<audioCases.length;sample++){
    const audioCase=audioCases[sample];const audioPath=path.join(root,'.local/audio',audioCase.file);
    await new Promise((resolve,reject)=>{const playback=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/play-fixture.ps1'),'-InputPath',audioPath],{windowsHide:true,stdio:'ignore'});playback.on('error',reject);playback.on('exit',code=>code===0?resolve():reject(Error(`Fixture playback failed: ${code}`)));});
    try{await until(s=>s.question?.text.toLowerCase().includes(audioCase.word)&&s.answer.length>0,15000);}catch(e){results.realAudioFailureState=await invoke('get_snapshot');results.syntheticAudioTranscripts=await main.evaluate(()=>window.fixtureTranscripts);throw e;}const real=await until(s=>s.latency&&s.latency.completedAt!==null,15000);results.realAudioLatencyMs=real.latency.firstTokenAt-real.latency.speechStoppedAt;passed(`Real ${audioCase.category} speech → WASAPI loopback → local VAD/${settings.speechBackend} → detected question → HTTP stream → overlay`);
    results.realAudioSamples.push({index:sample+1,category:audioCase.category,speechEndToFirstTokenMs:real.latency.firstTokenAt-real.latency.speechStoppedAt});
    await invoke('action',{action:'dismiss'});await until(s=>!s.question);requests=[];
    await sleep(1000);
    }
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
  const projectPath=path.join(root,'.local/context-fixture');await mkdir(path.join(projectPath,'src'),{recursive:true});
  await writeFile(path.join(projectPath,'.gitignore'),'ignored.txt\n');await writeFile(path.join(projectPath,'ignored.txt'),'ignored fixture');
  await writeFile(path.join(projectPath,'.env'),'SYNTHETIC_SECRET=exclude_me');await writeFile(path.join(projectPath,'src/main.ts'),'export const projectFact = "synthetic-cobalt-719";\n');
  await writeFile(path.join(projectPath,'README.md'),'A complete synthetic project.\n');await writeFile(path.join(projectPath,'image.bin'),Buffer.from([0,1,2]));
  await contextShortcut('p');await until(s=>s.project?.files===3&&!s.attachmentBusy&&s.latency?.completedAt!==null);passed('Actual Windows Ctrl Shift P shortcut sends the selected project');
  const projectRequest=requests.at(-1).input[0].content;assert(projectRequest.includes('synthetic-cobalt-719'));assert(projectRequest.includes('A complete synthetic project.'));assert(!projectRequest.includes('exclude_me'));assert(!projectRequest.includes('ignored fixture'));
  assert.equal((await invoke('get_snapshot')).project.skipped[0].path,'image.bin');passed('Complete nested project contents reach Responses, ignored and credential files excluded, binary omission reported');
  await invoke('ask',{question:'What is the project fact?'});await until(s=>s.question?.text==='What is the project fact?'&&s.latency?.completedAt!==null);assert(requests.at(-1).input[0].content.includes('synthetic-cobalt-719'));passed('Follow-up answer retains project source in RAM');
  await invoke('action',{action:'clear_project'});await until(s=>s.project===null);await invoke('ask',{question:'What remains after removal?'});await until(s=>s.question?.text==='What remains after removal?'&&s.latency?.completedAt!==null);assert(!requests.at(-1).input[0].content.includes('synthetic-cobalt-719'));passed('Remove project excludes source from subsequent requests');
  const focusBefore=await invoke('native_diagnostics');
  await contextShortcut('{F8}');const screen=await until(s=>s.screenshot&&!s.attachmentBusy&&s.latency?.completedAt!==null);passed('Actual Windows Ctrl Shift F8 shortcut captures a screenshot');
  const imageInput=requests.at(-1).input[0].content.find(c=>c.type==='input_image');assert(imageInput);assert.match(imageInput.image_url,/^data:image\/png;base64,/);
  const png=Buffer.from(imageInput.image_url.split(',')[1],'base64');assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),screen.screenshot.width);assert.equal(png.readUInt32BE(20),screen.screenshot.height);
  const focusAfter=await invoke('native_diagnostics');assert.equal(focusAfter.foregroundHwnd,focusBefore.foregroundHwnd);assert.equal(focusAfter.visible,focusBefore.visible);passed('Real native monitor capture sends a full-size lossless PNG through Responses without stealing focus');
  await invoke('ask',{question:'Explain the same screenshot again'});await until(s=>s.question?.text==='Explain the same screenshot again'&&s.latency?.completedAt!==null);assert.equal(requests.at(-1).input[0].content.find(c=>c.type==='input_image').image_url,imageInput.image_url);passed('Follow-up answer retains the latest screenshot in RAM');
  await invoke('action',{action:'clear_screenshot'});await until(s=>s.screenshot===null);await invoke('ask',{question:'What remains without the screenshot?'});await until(s=>s.question?.text==='What remains without the screenshot?'&&s.latency?.completedAt!==null);assert.equal(typeof requests.at(-1).input[0].content,'string');passed('Remove screenshot excludes image data from subsequent requests');
  await invoke('action',{action:'expand'});await until(s=>s.expanded&&s.latency&&s.latency.completedAt!==null);assert(requests.at(-1).instructions.includes('6 short sentences'));passed('More regenerates the same question with the expanded prompt');
  await overlay.getByText('October 28.',{exact:false}).waitFor();await overlay.screenshot({path:path.join(artifact,'overlay.png')});
  await invoke('action',{action:'pause'});await until(s=>s.paused);await invoke('action',{action:'pause'});await until(s=>!s.paused);passed('Pause releases capture and resume reopens both devices');
  const visible=async(expected)=>{for(let i=0;i<100;i++){if((await invoke('native_diagnostics')).visible===expected)return;await sleep(20);}assert.fail(`Overlay visibility did not become ${expected}`);};
  await invoke('action',{action:'hide'});await visible(false);await invoke('action',{action:'hide'});await visible(true);passed('Native overlay hide/show');
  if(process.env.COPILOT_CAPTURE_TEST==='1'){
    const {testCapture}=await import('./obs-capture.mjs');results.capture=await testCapture(invoke);passed('OBS display and window capture: protected output compared with visible positive controls');
  }
  if(process.env.COPILOT_ASR_CORPUS==='1'){
    const {readFile}=await import('node:fs/promises');
    const labels=JSON.parse(await readFile(path.join(root,'tests/fixtures/utterances.json'),'utf8'));
    const corpus={scope:'Synthetic English through actual WASAPI/Nemotron and question detector; not a human meeting accuracy or WER benchmark',clips:[],speechDetected:0,questionsDetected:0,negativeFalseTriggers:0};
    results.corpus=corpus;
    for(let index=0;index<labels.length;index++){
      await invoke('action',{action:'dismiss'});await until(s=>!s.question&&!s.answer);
      requests=[];const offset=await main.evaluate(()=>window.fixtureTranscripts.length);
      const audio=path.join(root,`.local/audio/corpus/${String(index).padStart(3,'0')}.wav`);
      await new Promise((resolve,reject)=>{const player=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/play-fixture.ps1'),'-InputPath',audio],{windowsHide:true,stdio:'ignore'});player.on('error',reject);player.on('exit',c=>c===0?resolve():reject(Error('Corpus fixture playback failed')));});
      // Allow both independently ordered VAD/final events to settle, rather
      // than counting partial candidates as completed automatic requests.
      await sleep(1600);
      const state=await invoke('get_snapshot');assert(state.active&&!state.paused&&!state.error);
      const finals=await main.evaluate(offset=>window.fixtureTranscripts.slice(offset).filter(s=>s.source==='remote'&&s.final&&s.text.trim()),offset);
      const automatic=requests.some(r=>!r.instructions.includes('JSON'));
      corpus.speechDetected+=Number(finals.length>0);
      if(labels[index].question)corpus.questionsDetected+=Number(automatic);else corpus.negativeFalseTriggers+=Number(automatic);
      // Only public synthetic fixture transcripts are retained by this opt-in
      // diagnostic. This event hook does not exist in the release build.
      corpus.clips.push({index,expectedQuestion:labels[index].question,automaticAnswer:automatic,finals:finals.map(s=>s.text)});
      await writeFile(path.join(artifact,'corpus-progress.json'),JSON.stringify(corpus,null,2));
      console.log(`CORPUS ${index+1}/${labels.length}: speech=${finals.length>0}, automatic=${automatic}, expected=${labels[index].question}`);
    }
    const questionCount=labels.filter(l=>l.question).length;
    assert(corpus.speechDetected/labels.length>.95,'Synthetic speech recognition missed the corpus gate');
    assert(corpus.questionsDetected/questionCount>.85,'Synthetic automatic question detection missed the corpus gate');
    assert.equal(corpus.negativeFalseTriggers,0,'A negative synthetic clip triggered an automatic answer');
    passed('Actual audio corpus passes speech/question gates with zero negative automatic requests');
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
  await invoke('send_project',{path:projectPath});await until(s=>s.project&&!s.attachmentBusy&&s.latency?.completedAt!==null);
  await invoke('action',{action:'screenshot'});await until(s=>s.attachmentBusy);await invoke('stop_meeting');const requestCount=requests.length;
  const stopped=await until(s=>!s.active);assert.equal(stopped.answer,'');assert.equal(stopped.question,null);assert.equal(stopped.latency,null);assert.equal(stopped.project,null);assert.equal(stopped.screenshot,null);assert.equal(stopped.attachmentBusy,false);
  await sleep(700);assert.equal(requests.length,requestCount);assert.equal((await invoke('native_diagnostics')).visible,false);passed('Stop clears project and screenshot context, ignores late capture work, cancels requests and hides overlay');
  await main.screenshot({path:path.join(artifact,'setup.png')});
  if(process.env.COPILOT_CRASH_TEST==='1'){
    await invoke('start_meeting',{settings});await until(s=>s.active&&s.status==='listening');
    const devices=await invoke('gaze_devices');
    const camera=devices.cameras.find(c=>c.allowed),gpu=devices.gpus.find(g=>/RX 9070 XT/.test(g.name));
    assert(camera&&gpu,'Crash-lifetime check requires an eligible camera and RX 9070 XT');
    await invoke('gaze_start',{settings:{camera:camera.index,device:gpu.index,strength:12}});
    const deadline=Date.now()+45000;let gaze;
    while(Date.now()<deadline){gaze=await invoke('gaze_snapshot');assert(!gaze.error,gaze.error);if(gaze.running&&gaze.preview)break;await sleep(50);}
    assert(gaze.running&&gaze.preview,'Camera must actually run before testing unexpected app exit');
    const processList=async()=>JSON.parse(await new Promise((resolve,reject)=>{
      // IDs/names only: never inspect sidecar command lines or private keys.
      const query=spawn('powershell.exe',['-NoProfile','-Command','@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
      let output='';query.stdout.on('data',b=>output+=b);query.on('error',reject);query.on('exit',c=>c===0?resolve(output):reject(Error('Process lifetime query failed')));
    }));
    const all=await processList(),owned=new Set([app.pid]);let added=true;
    while(added){added=false;for(const p of all)if(owned.has(p.ParentProcessId)&&!owned.has(p.ProcessId)){owned.add(p.ProcessId);added=true;}}
    const sidecars=all.filter(p=>owned.has(p.ProcessId)&&/^(nemo-speech|python|gaze-worker)\.exe$/i.test(p.Name));
    assert(sidecars.some(p=>p.Name==='nemo-speech.exe'),'Nemotron sidecar must be owned by the tested app');
    assert(sidecars.some(p=>/^(python|gaze-worker)\.exe$/i.test(p.Name)),'Camera sidecar must be owned by the tested app');
    await browser.close();browser=null;main=null;
    app.kill();await sleep(500);
    const exitDeadline=Date.now()+15000;let remaining;
    do{remaining=(await processList()).filter(p=>sidecars.some(s=>s.ProcessId===p.ProcessId));if(!remaining.length)break;await sleep(250);}while(Date.now()<exitDeadline);
    assert.equal(remaining.length,0,'Unexpected app exit left an owned speech/camera sidecar alive');
    results.crashLifetime={scope:'Forced termination of the isolated fixture app with actual speech and camera workers running',ownedSidecars:sidecars.map(p=>({pid:p.ProcessId,name:p.Name})),remainingSidecars:0};
    passed('Unexpected parent termination releases actual Nemotron and camera sidecars');
  }
  results.pass=true;
}catch(e){results.pass=false;results.failure=String(e);throw e;}finally{
  if(main){try{await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('stop_meeting'));}catch{}}
  results.completedAt=new Date().toISOString();for(const line of stderr.split(/\r?\n/)){if(line.startsWith('local_stt ')){try{const v=JSON.parse(line.slice(10));results.localTranscription.push({source:v.source,kind:v.kind,previewReused:v.preview_reused,queueWaitMs:v.queue_wait_ms,inferenceMs:v.inference_ms});}catch{}}}await writeFile(path.join(artifact,'results.json'),JSON.stringify(results,null,2));await browser?.close();app?.kill();vite?.kill();server.closeAllConnections();server.close();
}
