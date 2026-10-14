// Live native evaluation. Computer Use performs every explicit context shortcut
// and the reading shortcuts; this harness never silently sends screen/project context.
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,rename,copyFile,readdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {interviews} from './catalog.mjs';
import {bugs} from './bugs.mjs';
import {extractCode,gradeInterview,gradeBug} from './grade.mjs';

const root=process.cwd(),local=path.join(root,'.local/interview-suite'),out=path.join(root,'artifacts/interview-suite');
const pilot=process.argv.includes('--pilot'),resume=process.argv.includes('--resume');
const selected=process.argv.find(v=>v.startsWith('--case='))?.slice(7);
const limit=Number(process.argv.find(v=>v.startsWith('--limit='))?.slice(8)??120);
const file=path.join(out,pilot?'pilot.json':'results.json');
await mkdir(out,{recursive:true});await mkdir(local,{recursive:true});
const digest=b=>createHash('sha256').update(b).digest('hex');
const frontendFiles=['src/App.tsx','src/style.css','src/overlay/Answer.tsx','src/overlay/Overlay.tsx','src/overlay/FormattedAnswer.tsx','src/overlay/answerFormat.ts','src/overlay/paintedText.ts','src/useKeyboardScroll.ts','src/ui/PixelCompanion.tsx'];
const binary=path.join(root,'src-tauri/target/debug/meeting-copilot.exe');
const fingerprint={
 binarySha256:digest(await readFile(binary)),
 frontendSha256:digest((await Promise.all(frontendFiles.map(f=>readFile(f)))).map(b=>b.toString()).join('\n')),
 contractsSha256:digest((await Promise.all(['catalog.mjs','bugs.mjs','cases.mjs','grade.mjs'].map(f=>readFile(path.join(root,'benchmarks/interviews',f))))).map(b=>b.toString()).join('\n')),
};
let report={version:1,status:'in_progress',startedAt:new Date().toISOString(),model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'fast',
 scope:'100 distinct regular + 20 distinct bug interviews, three rounds each, live signed-in Codex through native app. Audio paused; no ASR reliability claim.',
 pilot,required:{regular:100,bug:20},fingerprint,rows:[],events:[]};
if(resume){
 report=JSON.parse(await readFile(file,'utf8'));
 if(JSON.stringify(report.fingerprint)!==JSON.stringify(fingerprint))throw Error('Resume fingerprint differs. Preserve this report and start a new evaluated build explicitly.');
 if(report.error)report.events.push({at:new Date().toISOString(),event:'preserved_previous_failure',error:report.error});
 report.status='in_progress';report.resumedAt=new Date().toISOString();delete report.error;
}else{
 try{await readFile(file);throw Error('Evidence already exists. Use --resume or a separate --pilot report.');}catch(e){if(e.code!=='ENOENT')throw e;}
}
async function persist(){const temp=file+'.tmp';await writeFile(temp,JSON.stringify(report,null,2));await rename(temp,file);}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let app,vite,browser,fixtureBrowser,main,overlay,fixture,ready=null;
const acknowledgements=new Map();
const invoke=(name,args={})=>main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const server=createServer(async(req,res)=>{
 try{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready,completed:report.rows.filter(r=>r.status==='responses_complete').length,total:120,pilot}));return;}
  if(req.url==='/ack'&&req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;if(body.length>16384)throw Error('Oversized acknowledgement');
   const ack=JSON.parse(body);if(!ready||ack.token!==ready.token)throw Error('Stale handoff acknowledgement');
   acknowledgements.set(ready.token,ack);res.end('ok');return;
  }
  if(req.url==='/snapshot'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await invoke('get_snapshot')));return;}
  if(req.url==='/detect'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await invoke('detect_context')));return;}
  if(req.url==='/diagnostics'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await invoke('native_diagnostics')));return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>'+escape(ready?.title??'Interview evaluation IDE')+'</title><style>body{margin:28px;background:#f5f3ed;color:#172029;font:18px/1.5 Segoe UI;max-width:780px}h1{font-size:27px;line-height:1.25}pre{font:18px/1.5 Consolas;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#43524d}</style><h1>'+escape(ready?.title??'Preparing interview')+'</h1><pre>'+escape(ready?.content??'Synthetic benchmark workspace. Waiting for the next handoff.')+'</pre><small>Synthetic test workspace. No private files, messages, or credentials.</small>');
 }catch(e){res.statusCode=400;res.end(String(e));}
});
await new Promise(r=>server.listen(9571,'127.0.0.1',r));
async function until(predicate,timeout=240000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const s=await invoke('get_snapshot');if(s.error)throw Error(s.error);if(predicate(s))return s;await delay(80);}
 throw Error('Native state timed out');
}
async function waitForComputerUse(payload){
 ready={...payload,token:randomBytes(12).toString('hex')};
 report.events.push({at:new Date().toISOString(),event:'computer_use_requested',id:ready.id,phase:ready.phase,token:ready.token});await persist();
 console.log('COMPUTER_USE_READY',JSON.stringify(ready));
 const start=Date.now();
 while(!acknowledgements.has(ready.token)){if(Date.now()-start>1200000)throw Error('Computer Use acknowledgement timed out');await delay(150);}
 const ack=acknowledgements.get(ready.token);acknowledgements.delete(ready.token);return ack;
}
async function geometry(){
 return overlay.evaluate(()=>{const content=document.querySelector('.answer-content'),body=document.querySelector('.answer-body'),pre=document.querySelector('.code-block pre'),footer=document.querySelector('.overlay-footer');
  return{top:content?.scrollTop,height:content?.scrollHeight,viewport:content?.clientHeight,code:pre?{left:pre.scrollLeft,width:pre.scrollWidth,viewport:pre.clientWidth}:null,
   renderedText:body?.dataset.rawAnswer??'',codeBlocks:document.querySelectorAll('.code-block').length,sourceSegments:body?.querySelectorAll('[data-source-start]').length??0,
   footerBottom:footer?.getBoundingClientRect().bottom,windowHeight:innerHeight,visibility:document.visibilityState};
 });
}
async function response(question){
 // Dismiss presentation without erasing the exact accepted-answer ledger.
 await invoke('action',{action:'dismiss'});
 const start=performance.now();await invoke('ask',{question});
 const q=await until(s=>s.question?.text===question),id=q.question.id;
 const s=await until(s=>s.question?.id===id&&s.latency?.completedAt!=null);
 await delay(120);
 const g=await geometry();
 const paints=await overlay.evaluate(id=>(window.__interviewPaints??[]).filter(p=>p.id===id),id);
 return{question,id,answer:s.answer,latency:s.latency,hostCompletedMs:performance.now()-start,
  firstWordMs:s.latency.firstWordAt==null?null:s.latency.firstWordAt-s.latency.questionConfirmedAt,
  completedMs:s.latency.completedAt-s.latency.questionConfirmedAt,
  firstPaintMs:s.latency.pipeline?.firstVisible==null?null:s.latency.pipeline.firstVisible-s.latency.questionConfirmedAt,
  renderedSourceMatches:g.renderedText===s.answer,geometry:g,paints};
}
async function handoff(task,kind,index,mode,marker,patched=false){
 await invoke('action',{action:'clear_project'});await invoke('action',{action:'clear_screenshot'});await invoke('action',{action:'dismiss'});
 const folder=path.join(local,'projects',kind==='bug'?'bug-'+task.id:task.id);
 const content=kind==='bug'
  ? 'Context marker: '+marker+'\n\n'+task.title+'\n\n'+task.contract+'\n\nPublic API: exported synchronous '+task.source.match(/function solve\([^)]*\)/)[0]+'. Source: src/core.mjs. No dependencies, API changes, or test edits.'+(patched?'\nThe source contains the candidate fix from round 2. Verify this current version.':'')
  : 'Context marker: '+marker+'\n\n'+task.task+'\n\nJavaScript contract: '+task.signature+'. Return the specified result; no stdin/stdout, imports or exports.'+(task.examples?'\nExamples (arguments, result):\n'+task.examples.map(x=>JSON.stringify(x)).join('\n'):'');
 await writeFile(path.join(folder,kind==='bug'?'README.md':'TASK.md'),content+'\n');
 if(kind==='bug'&&!patched)await writeFile(path.join(folder,'src/core.mjs'),'export '+task.source+'\n');
 const payload={phase:'handoff',id:task.id,kind,index,title:'Interview '+index+' · '+task.title,folder,mode,marker,content,patched};
 ready=payload;await fixture.goto('http://127.0.0.1:9571/');
 const ack=await waitForComputerUse(payload);
 const expected=mode==='screenshot'?'screenshot':'project';
 if(ack.detected?.kind!== (mode==='screenshot'?'browser':mode==='project-vscode'?'vscode':'folder'))throw Error('Unexpected source detection: '+JSON.stringify(ack.detected));
 const attached=await until(s=>!s.attachmentBusy&&!!s[expected]);
 if(attached[expected==='project'?'screenshot':'project'])throw Error('Historical attachment survived the clear boundary');
 const auto=await until(s=>s.latency?.completedAt!=null);
 return{marker,mode,folder,ack,attachment:attached[expected],automatic:{answer:auto.answer,latency:auto.latency},at:new Date().toISOString()};
}
async function readingCheck(task,kind,index){
 const before=await geometry();
 const ack=await waitForComputerUse({phase:'reading',id:task.id,kind,index,title:'Reading check · '+task.title,
  verticalNeeded:before.height>before.viewport,horizontalNeeded:!!before.code&&before.code.width>before.code.viewport,
  directions:['end','home',...(before.code&&before.code.width>before.code.viewport?['right','left']:[])]});
 const after=await geometry();
 return{before,ack,after,footerReachable:after.footerBottom<=after.windowHeight+1};
}
try{
 await persist();
 const exeDir=path.join(local,'app');await mkdir(exeDir,{recursive:true});
 for(const name of await readdir(path.dirname(binary)))if(name==='meeting-copilot.exe'||name.endsWith('.dll'))await copyFile(path.join(path.dirname(binary),name),path.join(exeDir,name));
 try{await fetch('http://127.0.0.1:1420');}catch{
  vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1420','--strictPort'],{windowsHide:true,stdio:'ignore'});await delay(1800);
 }
 app=spawn(path.join(exeDir,'meeting-copilot.exe'),[],{cwd:root,windowsHide:true,env:{...process.env,COPILOT_DATA_DIR:path.join(local,'data'),WEBVIEW2_USER_DATA_FOLDER:path.join(local,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9570'},stdio:['ignore','ignore','pipe']});
 let stderr='';app.stderr.on('data',b=>stderr=(stderr+b).slice(-6000));
 for(let i=0;i<200;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9570');break;}catch{if(app.exitCode!==null)throw Error('Native app exited: '+stderr);await delay(100);}}
 if(!browser)throw Error('Native CDP unavailable');
 for(let i=0;i<100;i++){const pages=browser.contexts()[0].pages();main=pages.find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));overlay=pages.find(p=>p.url().includes('view=overlay'));if(main&&overlay)break;await delay(100);}
 if(!main||!overlay)throw Error('Native surfaces missing');
 await overlay.evaluate(()=>{
  const bridge=window.__TAURI_INTERNALS__,original=bridge.invoke;
  window.__interviewPaints=[];
  bridge.invoke=function(name,args={}){
   const result=original.call(this,name,args);
   if(name==='answer_displayed'){
    const p={id:args.id,revision:args.revision,start:args.visibleStart,end:args.visibleEnd,textLength:args.text.length,source:args.text.slice(args.visibleStart,args.visibleEnd),paintHostMs:args.paintHostMs,accepted:false};
    window.__interviewPaints.push(p);if(window.__interviewPaints.length>12000)window.__interviewPaints.splice(0,4000);
    result.then(()=>p.accepted=true,()=>p.accepted=false);
   }
   return result;
  };
 });
 const boot=await invoke('bootstrap');if(!boot.selected?.planEnabled)throw Error('A signed-in Codex account is required');
 const models=await invoke('list_models');if(!models.some(m=>m.slug===report.model))throw Error('GPT-6.1 Sol absent from live catalog');
 report.liveCatalogVerified=true;report.shortcutErrors=boot.shortcutErrors;
 if(boot.shortcutErrors.length)throw Error('Shortcut registration failed: '+boot.shortcutErrors.join('; '));
 const settings={...boot.settings,model:report.model,reasoningEffort:'low',answerBackend:'codex',serviceTier:'fast',answerObjective:'detailed',speechBackend:'whisper',projectPath:'',
  modelPath:path.join(root,'models/ggml-tiny.en.bin'),
  microphone:boot.devices.find(d=>d.source==='self'&&d.default)?.id??boot.devices.find(d=>d.source==='self')?.id,
  output:boot.devices.find(d=>d.source==='remote'&&d.default)?.id??boot.devices.find(d=>d.source==='remote')?.id};
 await invoke('start_meeting',{settings});await invoke('action',{action:'pause'});await until(s=>s.paused);
 report.actualSettings={model:settings.model,reasoningEffort:settings.reasoningEffort,answerBackend:settings.answerBackend,serviceTier:settings.serviceTier,answerObjective:settings.answerObjective,speechBackend:settings.speechBackend,paused:true};
 fixtureBrowser=await chromium.launch({channel:'msedge',headless:false,args:['--remote-debugging-port=9572']});
 fixture=await fixtureBrowser.newPage({viewport:null});
 const all=[...interviews.map((task,i)=>({task,kind:'regular',index:i+1,mode:['screenshot','project-vscode','project-explorer'][i%3]})),
  ...bugs.map((task,i)=>({task,kind:'bug',index:101+i,mode:i%2?'project-explorer':'project-vscode'}))];
 let processed=0;
 for(const item of all){
  if(selected&&item.task.id!==selected)continue;if(processed>=limit)break;
  const existing=report.rows.find(r=>r.id===item.task.id&&r.kind===item.kind);
  if(existing?.status==='responses_complete')continue;
  const {task,kind,index,mode}=item;
  const row=existing??{id:task.id,kind,index,title:task.title,source:task.source??'Injected synthetic project defect',attempts:[],status:'pending'};
  if(!existing)report.rows.push(row);
  const attempt={startedAt:new Date().toISOString(),marker:'INTERVIEW-'+index+'-'+randomBytes(8).toString('hex'),rounds:[]};
  row.attempts.push(attempt);row.status='running';await persist();
  attempt.handoff=await handoff(task,kind,index,mode,attempt.marker);
  for(let r=0;r<3;r++){
   const question=task.rounds[r]+'\nUse only the current application attachments; earlier tasks are historical. Identify the exact current marker '+(r===2&&attempt.patchHandoff?attempt.patchHandoff.marker:'from the attachment')+'.';
   const answer=await response(question);
   const currentMarker=r===2&&attempt.patchHandoff?attempt.patchHandoff.marker:attempt.marker;
   answer.markerCorrect=answer.answer.includes(currentMarker);
   if(r>0){
    answer.code=extractCode(answer.answer,kind==='bug');
    answer.grade=kind==='bug'?gradeBug(task,answer.code):gradeInterview(task.id,answer.code);
    await writeFile(path.join(out,kind+'-'+task.id+'-attempt-'+row.attempts.length+'-round-'+(r+1)+'.mjs'),answer.code);
   }else answer.diagnosisNeedsReview=kind==='bug';
   attempt.rounds.push(answer);await persist();
   console.log('ROUND_RESULT',JSON.stringify({id:task.id,kind,round:r+1,markerCorrect:answer.markerCorrect,passed:answer.grade?.passed,firstWordMs:answer.firstWordMs,completedMs:answer.completedMs}));
   if(kind==='bug'&&r===1&&answer.grade?.contractOkay){
    await writeFile(path.join(local,'projects','bug-'+task.id,'src/core.mjs'),answer.code+'\n');
    attempt.patchHandoff=await handoff(task,kind,index,mode,attempt.marker+'-PATCH',true);await persist();
   }
  }
  attempt.reading=await readingCheck(task,kind,index);
  attempt.completedAt=new Date().toISOString();
  attempt.functionalPassed=attempt.rounds.every(r=>r.markerCorrect&&r.renderedSourceMatches)&&attempt.rounds.slice(1).every(r=>r.grade?.passed);
  attempt.paintObserved=attempt.rounds.every(r=>r.paints.some(p=>p.accepted&&p.end>p.start));
  row.status='responses_complete';row.manualContractReview='pending';row.diagnosisReview=kind==='bug'?'pending':null;processed++;await persist();
  console.log('INTERVIEW_RESULT',JSON.stringify({id:task.id,kind,functionalPassed:attempt.functionalPassed,paintObserved:attempt.paintObserved,reading:attempt.reading.footerReachable}));
 }
 report.status=report.rows.filter(r=>r.status==='responses_complete').length===120?'responses_complete_pending_contract_review':'partial';
 report.stoppedAt=new Date().toISOString();ready=null;await persist();
}catch(error){report.status='failed';report.error=String(error);await persist();console.error(error);process.exitCode=1;}
finally{
 if(main)try{await invoke('stop_meeting');}catch{}
 await browser?.close();await fixtureBrowser?.close();app?.kill();vite?.kill();server.closeAllConnections();server.close();
}
