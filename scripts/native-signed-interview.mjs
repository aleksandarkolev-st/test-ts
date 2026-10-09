// Live adaptive interview through the native scheduler, context and overlay.
// Audio mode measures capture/ASR; transcript injection excludes ASR latency.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connectNativePages } from './lib/native-cdp.mjs';

const root=process.cwd(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const scenarioFile=process.env.COPILOT_NATIVE_INTERVIEW_SCENARIO?path.resolve(process.env.COPILOT_NATIVE_INTERVIEW_SCENARIO):null;
assert(!scenarioFile||scenarioFile.toLowerCase().startsWith(root.toLowerCase()+path.sep),'Provided interview scenario must be in the workspace');
assert(!scenarioFile||!process.env.COPILOT_NATIVE_INTERVIEW_CASE,'Choose a provided scenario or a regression case');
const name=process.env.COPILOT_NATIVE_INTERVIEW_CASE||(scenarioFile?'provided':'generated');
const provided=scenarioFile?JSON.parse(await readFile(scenarioFile,'utf8')):null;
let scenario=provided?(provided.scenario??provided):null;
if(!scenario&&name!=='generated'){
  const suite=JSON.parse(await readFile('tests/fixtures/gpu-interview-suite.json','utf8'));
  scenario=suite.cases.find(c=>c.name===name);
}
assert(name==='generated'||scenario,'Unknown native interview scenario');
if(scenario)for(const key of ['seed','rubric','examinerOnly'])assert(typeof scenario[key]==='string'&&scenario[key].trim(),'Scenario needs public opening and private examiner evidence');
const seedFile=process.env.COPILOT_NATIVE_INTERVIEW_QUESTION_FILE?path.resolve(process.env.COPILOT_NATIVE_INTERVIEW_QUESTION_FILE):null;
assert(seedFile===null||seedFile.toLowerCase().startsWith(root.toLowerCase()+path.sep),'Replay question must be in this workspace');
let seedQuestion=seedFile?(await readFile(seedFile,'utf8')).trim():scenario?.seed;
if(seedQuestion!==undefined)assert(seedQuestion.length>0&&seedQuestion.length<=12000,'Replay question must contain 1–12000 characters');
const seedWave=process.env.COPILOT_NATIVE_INTERVIEW_WAVE_FILE?path.resolve(process.env.COPILOT_NATIVE_INTERVIEW_WAVE_FILE):null;
if(seedWave){
  assert(seedFile&&seedWave.toLowerCase().startsWith(root.toLowerCase()+path.sep)&&seedWave.toLowerCase().endsWith('.wav'),'Wave replay requires a workspace question and waveform');
  assert.equal((await readFile(seedWave.replace(/\.wav$/i,'.txt'),'utf8')).trim(),seedQuestion,'Saved waveform question must match the replay seed');
}
const rounds=Number(process.env.COPILOT_NATIVE_INTERVIEW_ROUNDS||12);assert(Number.isInteger(rounds)&&rounds>0&&rounds<=100);
const recordedDir=process.env.COPILOT_NATIVE_INTERVIEW_REPLAY_DIR?path.resolve(process.env.COPILOT_NATIVE_INTERVIEW_REPLAY_DIR):null;
const recorded=[];
assert(!(!scenario&&(seedFile||recordedDir)),'Fixed regression replays must specify their examiner scenario');
if(recordedDir){
  assert(!seedFile&&!seedWave&&recordedDir.toLowerCase().startsWith(root.toLowerCase()+path.sep),'Choose a workspace recorded replay or a seed replay, not both');
  for(let round=1;round<=rounds;round++){
    const base=path.join(recordedDir,`round-${String(round).padStart(2,'0')}`);
    const question=(await readFile(`${base}.txt`,'utf8')).trim();
    assert(question.length>0&&question.length<=12000,'Recorded questions must contain 1–12000 characters');
    const wave=await readFile(`${base}.wav`);
    assert(wave.subarray(0,4).toString()==='RIFF'&&wave.subarray(8,12).toString()==='WAVE','Recorded audio must be a WAV file');
    recorded.push({question,waveFile:`${base}.wav`,waveSha256:createHash('sha256').update(wave).digest('hex')});
  }
}
const realAudio=process.env.COPILOT_NATIVE_INTERVIEW_AUDIO==='1';
const remoteOnly=process.env.COPILOT_ACCEPTANCE_REMOTE_ONLY==='1';
const requestedChunk=process.env.COPILOT_NATIVE_SPEECH_CHUNK_MS===undefined?null:Number(process.env.COPILOT_NATIVE_SPEECH_CHUNK_MS);
assert(requestedChunk===null||[80,160,560,1120].includes(requestedChunk),'Choose a supported speech chunk size');
const port=Number(process.env.COPILOT_CDP_PORT||9239);assert(Number.isInteger(port)&&port>1024&&port<65536);
const output=path.resolve(process.env.COPILOT_NATIVE_INTERVIEW_OUTPUT||`artifacts/native-interview/${new Date().toISOString().replace(/[:.]/g,'-')}`);
assert(output.toLowerCase().startsWith(root.toLowerCase()+path.sep),'Native artifacts must stay in this workspace');
const appDir=path.join(root,'.local/native-interview-app'),dataDir=path.join(root,'.local/native-interview-data');
const examiner=path.join(root,'src-tauri/target/debug/examples/adaptive-interview.exe');
await mkdir(output,{recursive:true});await mkdir(appDir,{recursive:true});await mkdir(dataDir,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let app,vite,connection,invoke,started=false,appError='';
const result={status:'in_progress',model:'gpt-6-luna',effort:'low',tier:'fast',scenario:name,rounds,realAudio,startedAt:new Date().toISOString(),measurement:realAudio?'Live adaptive synthetic English speech through WASAPI, local ASR, signed-in Codex, actual scheduler/context and overlay. Not human-interview certification. Model grades require independent technical review.':'Live signed-in Codex through actual native scheduler/context/rendering; simulated partial and final transcripts exclude ASR latency. Model grades require independent technical review.',rows:[]};
result.primaryLatencyMetric='firstWordFromSpeechEndMs: receipt of the first alphanumeric character of the retained answer word, after protocol decoding and question/context gating. Does not wait for word or sentence completion. Rendering is separate.';
if(remoteOnly)result.measurement+=' Acceptance/debug-only remote capture; room microphone capture is excluded. This does not test real microphone interruptions.';
if(scenarioFile)result.providedScenario={file:path.relative(root,scenarioFile),sha256:hash(await readFile(scenarioFile))};
if(seedFile)result.seedReplay={file:path.relative(root,seedFile),sha256:hash(Buffer.from(seedQuestion))};
if(seedWave)result.seedWaveReplay={file:path.relative(root,seedWave),sha256:hash(await readFile(seedWave))};
if(recordedDir){
  result.measurement+=' Questions and audio are fixed public replays, not newly adaptive follow-ups.';
  result.recordedReplay=recorded.map(({question,waveFile,waveSha256})=>({questionSha256:hash(Buffer.from(question)),waveFile:path.relative(root,waveFile),waveSha256}));
}
result.sourceHashes=Object.fromEntries(await Promise.all(['src-tauri/src/audio/mod.rs','src-tauri/src/transcription/vad.rs','src-tauri/src/transcription/nemotron.rs','src-tauri/src/meeting/questions.rs','src-tauri/src/meeting/scheduler.rs','src-tauri/src/openai/codex.rs','src-tauri/src/openai/prompts.rs','src-tauri/src/runtime.rs'].map(async file=>[file,hash(await readFile(file))])));
const persist=()=>writeFile(path.join(output,'interview.json'),JSON.stringify(result,null,2));
const runChild=(file,args,env)=>new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd:root,windowsHide:true,env,stdio:['ignore','ignore','pipe']});let error='';
  child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4000);});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Examiner exited ${code}: ${error}`)));
});
const events=()=>connection.main.evaluate(()=>window.nativeInterviewEvents);
const normalize=text=>text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
async function event(kind,text=null,isFinal=true,source='remote') {
  return invoke('acceptance_event',{kind,source,text,isFinal});
}
async function outcome(question,offset,stopped) {
  const deadline=Date.now()+135000;let first=null,firstWord=null,firstVisible=null,samples=[],responseVersion=null,completionSeen=null;
  while(Date.now()<deadline){
    const snapshot=await invoke('get_snapshot');
    if(snapshot.error)throw Error(snapshot.error);
    const turnEvents=(await events()).slice(offset);
    const lastEnd=turnEvents.filter(e=>e.name==='speech.ended'&&e.payload?.source==='remote').at(-1)?.payload.timestamp;
    const finals=turnEvents.filter(e=>e.name==='transcript'&&e.payload?.source==='remote'&&e.payload.final);
    const finalThrough=finals.at(-1)?.payload.endedAt;
    const confirmed=turnEvents.filter(e=>e.name==='question.confirmed').at(-1)?.payload;
    const audioDrained=lastEnd!=null&&finalThrough>=lastEnd&&confirmed?.timestamp>=lastEnd;
    if(realAudio&&!audioDrained){await sleep(20);continue;}
    const current=snapshot.question&&(realAudio?confirmed?.id===snapshot.question.id:normalize(snapshot.question.text).endsWith(normalize(question)));
    if(current&&snapshot.answer){
      const version=`${snapshot.question.id}:${snapshot.latency.responseRevision??0}`;
      if(version!==responseVersion){responseVersion=version;first=null;firstWord=null;firstVisible=null;completionSeen=null;}
      if(first===null)first=snapshot.latency.firstTokenAt;
      if(firstWord===null)firstWord=snapshot.latency.firstWordAt??null;
      if(firstVisible===null){
        const shown=await connection.overlay.evaluate(({id,revision})=>{
          const content=document.querySelector('.answer-content');
          if(content?.dataset.questionId!==id||Number(content.dataset.responseRevision)!==revision)return null;
          const p=document.querySelector('.answer p[aria-live="polite"]');
          if(!p?.textContent.trim())return null;
          const r=p.getBoundingClientRect(),s=getComputedStyle(p);
          return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'?p.textContent:null;
        },{id:snapshot.question.id,revision:snapshot.latency.responseRevision??0});
        if(shown&&snapshot.answer.startsWith(shown))firstVisible=Date.now();
      }
      if(samples.at(-1)?.text!==snapshot.answer)samples.push({hostMs:Date.now(),responseVersion,text:snapshot.answer});
      if(snapshot.latency?.completedAt!=null){
        // Completion can arrive before the last UI update. Give the actual
        // renderer time to acknowledge the final response version.
        completionSeen??=Date.now();
        if(firstVisible===null&&Date.now()-completionSeen<1000){await sleep(20);continue;}
        const timings=await invoke('get_answer_timings');
        const speechEnd=stopped??snapshot.latency.speechStoppedAt;
        return {answer:snapshot.answer,responseVersion,recognizedQuestion:snapshot.question.text,inputTranscript:realAudio?finals.map(e=>e.payload.text).join(' '):question,ignored:false,firstWordFromSpeechEndMs:firstWord==null?null:firstWord-speechEnd,firstWordFromLatestInputMs:firstWord==null||snapshot.latency.pipeline?.latestInputSent==null?null:firstWord-snapshot.latency.pipeline.latestInputSent,firstTokenFromSpeechEndMs:first==null?null:first-speechEnd,firstVisibleHostMs:firstVisible,firstRenderedFromSpeechEndMs:snapshot.latency.pipeline?.firstVisible==null?null:snapshot.latency.pipeline.firstVisible-speechEnd,latency:snapshot.latency,timings,samples};
      }
    }
    if(turnEvents.some(e=>e.name==='question.ignored'&&(!realAudio||e.payload?.id===confirmed?.id)))return {answer:'',inputTranscript:realAudio?finals.map(e=>e.payload.text).join(' '):question,ignored:true,firstWordFromSpeechEndMs:null,firstWordFromLatestInputMs:null,firstTokenFromSpeechEndMs:null,firstVisibleHostMs:null,samples};
    await sleep(20);
  }
  throw Error('Native interview turn did not complete');
}
let playbackName;
async function speak(question,label){
  const textFile=path.join(output,`${label}.txt`),waveFile=path.join(output,`${label}.wav`);
  await writeFile(textFile,question,'utf8');
  const replayWave=recordedDir?recorded[Number(label.replace(/^round-/,''))-1]?.waveFile:seedWave&&label==='round-01'?seedWave:null;
  if(replayWave){
    assert.notEqual(path.resolve(replayWave).toLowerCase(),path.resolve(waveFile).toLowerCase());
    await copyFile(replayWave,waveFile);
  }else await runChild('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/synthesize-interview-question.ps1'),'-TextPath',textFile,'-OutputPath',waveFile],process.env);
  await runChild('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/play-fixture.ps1'),'-InputPath',waveFile,'-OutputName',playbackName],process.env);
  return {waveFile:path.basename(waveFile),sha256:hash(await readFile(waveFile))};
}
try {
  if(!scenario){
    const request=path.join(output,'scenario-request.json');
    await writeFile(request,JSON.stringify({brief:process.env.COPILOT_NATIVE_INTERVIEW_BRIEF||'CUDA and GPU systems: vague unexpected behavior, followed by increasingly difficult quantitative reasoning, concurrency, memory ordering and exact code. Require clarification and revise hypotheses as new evidence arrives.'},null,2));
    await runChild(examiner,['--generate-scenario',request],{...process.env,COPILOT_INTERVIEW_EXAMINER_MODEL:'gpt-6-luna',COPILOT_INTERVIEW_EXAMINER_EFFORT:'high'});
    const generated=JSON.parse(await readFile(request.replace(/\.json$/,'.scenario.json'),'utf8'));
    scenario={...generated.scenario,name:'generated'};seedQuestion=scenario.seed;
    assert(typeof seedQuestion==='string'&&seedQuestion.length>0&&seedQuestion.length<=12000,'Generated opening question must contain 1–12000 characters');
    result.generatedScenario={model:generated.model,effort:generated.effort,file:'scenario-request.scenario.json'};
  }
  const build=path.join(root,'src-tauri/target/debug');
  for(const file of await readdir(build))if(file==='meeting-copilot.exe'||file.endsWith('.dll'))await copyFile(path.join(build,file),path.join(appDir,file));
  result.nativeBinarySha256=hash(await readFile(path.join(appDir,'meeting-copilot.exe')));result.examinerBinarySha256=hash(await readFile(examiner));
  try {await fetch('http://127.0.0.1:1420');} catch {
    vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1420','--strictPort'],{cwd:root,windowsHide:true,stdio:'ignore'});
    for(let i=0;i<300;i++){try{await fetch('http://127.0.0.1:1420');break;}catch{await sleep(100);}}
  }
  const env={...process.env,COPILOT_ACCEPTANCE:'1',COPILOT_DATA_DIR:dataDir,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'.local/native-interview-webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`};
  delete env.COPILOT_TEST_API;delete env.COPILOT_INTERVIEW_RESUME;
  app=spawn(path.join(appDir,'meeting-copilot.exe'),[],{cwd:root,windowsHide:true,env,stdio:['ignore','ignore','pipe']});
  app.stderr.on('data',chunk=>{appError=(appError+chunk).slice(-4000);});
  for(let i=0;i<600;i++){try{connection=await connectNativePages(port);break;}catch{if(app.exitCode!==null)throw Error(`Native app exited ${app.exitCode}: ${appError}`);await sleep(100);}}
  assert(connection,'Native main and overlay unavailable');
  let rendered=false;
  for(let i=0;i<600;i++){
    const ready=await connection.overlay.evaluate(()=>Boolean(document.querySelector('.answer-content')));
    if(ready){rendered=true;break;}await sleep(100);
  }
  assert(rendered,'Overlay frontend must mount before starting measured inference');
  invoke=(name,args={})=>connection.main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
  await connection.main.evaluate(async()=>{
    window.nativeInterviewEvents=[];
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'copilot:event',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.nativeInterviewEvents.push(e.payload))});
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'copilot:transcript',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.nativeInterviewEvents.push({name:'transcript',payload:e.payload}))});
  });
  const boot=await invoke('bootstrap');assert(boot.debug);assert(!boot.snapshot.active);assert(boot.selected?.planEnabled,'Signed-in Codex account required');
  const models=await invoke('list_models');assert(models.some(m=>m.slug==='gpt-6-luna'));
  const requestedOutput=process.env.COPILOT_NATIVE_OUTPUT;
  const outputDevice=requestedOutput?boot.devices.find(d=>d.source==='remote'&&d.name.toLowerCase().includes(requestedOutput.toLowerCase())):boot.devices.find(d=>d.source==='remote'&&d.id===boot.settings.output)||boot.devices.find(d=>d.source==='remote'&&d.default)||boot.devices.find(d=>d.source==='remote');
  assert(outputDevice,'Requested native interview playback output must be available');
  result.outputDevice=outputDevice.name;
  const settings={...boot.settings,answerBackend:'codex',model:'gpt-6-luna',reasoningEffort:'low',serviceTier:'fast',projectPath:'',microphone:boot.devices.find(d=>d.source==='self'&&d.default)?.id||boot.devices.find(d=>d.source==='self')?.id,output:outputDevice.id};
  if(requestedChunk!==null)settings.speechChunkMs=requestedChunk;
  result.speechConfiguration={backend:settings.speechBackend,chunkMs:settings.speechChunkMs,device:settings.nemotronDevice,deviceName:settings.nemotronDeviceName,acousticRefinements:process.env.COPILOT_ACOUSTIC_REFINE==='1',eagerFinalReplacement:process.env.COPILOT_EAGER_FINAL_REPLACEMENT==='1',confirmedQuestionRefinements:process.env.COPILOT_CONFIRM_QUESTION_REFINEMENTS==='1',remoteOnly};
  playbackName=boot.devices.find(d=>d.id===settings.output)?.name;assert(playbackName);
  assert(settings.microphone&&settings.output);await invoke('start_meeting',{settings});started=true;
  const intro='This is a technical interview. I will present hypothetical systems problems, ask you to analyze them, and keep drilling into your reasoning. Some challenges will be intentionally vague; ask for missing information rather than inventing it.';
  let offset=(await events()).length;await event('started');const introEnd=await event('ended');await event('transcript',intro);
  result.introduction=await outcome(intro,offset,introEnd);await invoke('action',{action:'dismiss'});
  let history=`INTERVIEWER INTRODUCTION: ${intro}\n`,question=recorded[0]?.question??seedQuestion;
  for(let round=1;round<=rounds;round++){
    offset=(await events()).length;let stoppedHostMs,stopped,audio;
    if(realAudio){audio=await speak(question,`round-${String(round).padStart(2,'0')}`);}
    else {
    await event('started');
    const words=question.split(/\s+/),parts=[Math.ceil(words.length/3),Math.ceil(2*words.length/3),words.length];let spoken=0;
    for(const count of new Set(parts)){await sleep((count-spoken)*180);await event('transcript',words.slice(0,count).join(' '),false);spoken=count;}
    stoppedHostMs=Date.now();stopped=await event('ended');await sleep(50);await event('transcript',question);
    }
    const answer=await outcome(question,offset,stopped);
    const row={round,question,speechEndNativeMs:stopped??answer.latency?.speechStoppedAt,speechEndHostMs:stoppedHostMs,audio,...answer,speechMarkers:(await events()).slice(offset).filter(e=>e.name==='speech.started'||e.name==='speech.ended')};
    if(realAudio){row.preservesAllRecognizedClauses=normalize(row.recognizedQuestion??'')===normalize(row.inputTranscript??'');}
    row.firstVisibleFromSpeechEndMs=stoppedHostMs==null?answer.firstRenderedFromSpeechEndMs:answer.firstVisibleHostMs==null?null:answer.firstVisibleHostMs-stoppedHostMs;
    result.rows.push(row);await persist();
    if(remoteOnly)assert(!row.speechMarkers.some(e=>e.payload?.source==='self'),'Remote-only capture must not emit microphone speech markers');
    if(realAudio&&process.env.COPILOT_NATIVE_REQUIRE_FULL_TURN==='1')assert(row.preservesAllRecognizedClauses,'Confirmed question lost recognized clauses');
    console.log(`Native round ${round}: ignored=${row.ignored}, first answer word ${row.firstWordFromSpeechEndMs} ms, first text ${row.firstTokenFromSpeechEndMs} ms, rendered ${row.firstVisibleFromSpeechEndMs} ms`);
    history+=`\nINTERVIEWER: ${question}\nSUGGESTED ANSWER (not necessarily correct): ${answer.answer}\n`;
    const request=path.join(output,`round-${String(round).padStart(2,'0')}.json`);
    await writeFile(request,JSON.stringify({scenario,round,history},null,2));
    await runChild(examiner,['--grade-request',request],{...env,COPILOT_INTERVIEW_EXAMINER_MODEL:'gpt-6-luna',COPILOT_INTERVIEW_EXAMINER_EFFORT:'high'});
    const judged=JSON.parse(await readFile(request.replace(/\.json$/,'.review.json'),'utf8'));row.review=judged.review;await persist();
    if(round<rounds){question=recorded[round]?.question??row.review.question;assert(typeof question==='string'&&question.length);}
  }
  result.status='complete';result.targetAchieved=false; // Broad audio/interruption target requires further evidence.
} catch(error){result.status='failed';result.failure=String(error);if(invoke){try{const snapshot=await invoke('get_snapshot');result.failureState={status:snapshot.status,error:snapshot.error};}catch{}}if(process.env.COPILOT_NEMO_DIAGNOSTICS==='1')result.nativeDiagnosticTail=appError;throw error;}
finally {
  if(connection){try{await writeFile(path.join(output,'event-log.json'),JSON.stringify(await events(),null,2));}catch{}}
  if(started&&invoke){try{await invoke('stop_meeting');const stopped=await invoke('get_snapshot');result.stoppedCleanly=!stopped.active&&!stopped.answer&&!stopped.questions.length;}catch(error){result.cleanupFailure=String(error);}}
  result.completedAt=new Date().toISOString();await persist();connection?.close();app?.kill();vite?.kill();
}
