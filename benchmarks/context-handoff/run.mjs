// Live native benchmark. UI handoffs are performed separately with Computer Use.
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {problems} from './catalog.mjs';
import {gradeCode} from './oracles.mjs';
const root=process.cwd(),out=path.join(root,'artifacts/context-handoff'),local=path.join(root,'.local/context-handoff');
await mkdir(out,{recursive:true});await mkdir(local,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let app,vite,browser,screenBrowser,main,overlay,screen,ready=null,ack=false;
const report={startedAt:new Date().toISOString(),model:'gpt-6.1-sol',reasoningEffort:'low',scope:'Live signed-in Codex through the native app; manual typed follow-up; no ASR or audio latency claim.',rows:[],interview:[]};
const persist=()=>writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
const invoke=(name,args={})=>main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready,report:{rows:report.rows.length,interview:report.interview.length}}));return;}
  if(req.url==='/ack'&&req.method==='POST'){ack=true;res.end('ok');return;}
  if(req.url==='/snapshot'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await invoke('get_snapshot')));return;}
  if(req.url==='/detect'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await invoke('detect_context')));return;}
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Context Handoff Benchmark IDE</title><style>body{background:#f8f5ef;color:#151515;font:24px Segoe UI;margin:50px;max-width:1350px}h1{font-size:40px}pre{white-space:pre-wrap;font:23px Consolas}small{color:#555}</style><h1>${escape(ready?.title??'Preparing benchmark')}</h1><pre>${escape(ready?.content??'Please wait')}</pre><small>Synthetic test workspace. No private files or messages.</small>`);
 }catch(e){res.statusCode=500;res.end(String(e));}
});
await new Promise(r=>server.listen(9561,'127.0.0.1',r));
async function until(predicate,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){const s=await invoke('get_snapshot');if(s.error)throw Error(s.error);if(predicate(s))return s;await sleep(25);}throw Error('Native state timed out');}
async function answer(question){
 await invoke('action',{action:'dismiss'});
 const begin=performance.now();let firstVisible=null,visibleLower=0;
 await invoke('ask',{question});
 const questionState=await until(s=>s.question?.text===question);const id=questionState.question.id;
 const end=Date.now()+180000;let s;
 while(Date.now()<end){
  s=await invoke('get_snapshot');
  if(s.error)throw Error(s.error);
  const t0=performance.now()-begin;
  const text=await overlay.locator('.answer p[aria-live="polite"]').textContent().catch(()=>'');
  const t1=performance.now()-begin;
  if(firstVisible===null&&text?.trim())firstVisible={lowerMs:visibleLower,upperMs:t1};
  if(!text?.trim())visibleLower=t0;
  if(s.question?.id===id&&s.latency?.completedAt!==null&&s.latency?.completedAt!==undefined){
   return {question,answer:s.answer,hostCompletedMs:performance.now()-begin,firstVisible,latency:s.latency,firstWordMs:s.latency.firstWordAt===null?null:s.latency.firstWordAt-s.latency.questionConfirmedAt,completedMs:s.latency.completedAt-s.latency.questionConfirmedAt};
  }
  await sleep(25);
 }
 throw Error('Answer timed out');
}
function codeFrom(text){const blocks=[...text.matchAll(/```(?:javascript|js|typescript)?\s*\n([\s\S]*?)```/g)].map(m=>m[1]);return blocks.find(b=>/\b(?:function\s+solve|(?:const|let|var)\s+solve\s*=)/.test(b))??blocks[0]??text;}
async function handoff(task,index,mode){
 await invoke('action',{action:'clear_project'});await invoke('action',{action:'clear_screenshot'});await invoke('action',{action:'dismiss'});
 const marker=`CTX-${index}-${randomBytes(6).toString('hex')}`;
 const content=`Context marker: ${marker}\n\n${task.task}\n\nJavaScript contract: ${task.signature}. Return the result; no input/output wrapper.\nExamples (arguments, result):\n${task.examples.map(x=>JSON.stringify(x)).join('\n')}\n\nImplement an efficient complete solution.`;
 const folder=path.join(local,`case-${index}`);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'TASK.md'),content);
 ready={index,id:task.id,mode,title:`LeetCode ${task.id}: ${task.title} (${task.difficulty})`,content,folder,marker};ack=false;
 await screen.goto('http://127.0.0.1:9561/');
 console.log('HANDOFF_READY',JSON.stringify({index,id:task.id,mode,folder}));
 const waitStart=Date.now();while(!ack){if(Date.now()-waitStart>600000)throw Error('Computer Use handoff acknowledgment timed out');await sleep(100);}
 const before=performance.now();const attached=await until(s=>!s.attachmentBusy&&(mode==='project'?!!s.project:!!s.screenshot));
 const automatic=await until(s=>s.latency?.completedAt!=null);
 await writeFile(path.join(out,`automatic-${task.id}.json`),JSON.stringify({answer:automatic.answer,latency:automatic.latency,attachment:mode==='project'?attached.project:attached.screenshot},null,2));
 return{marker,attachment:mode==='project'?attached.project:attached.screenshot,automaticLatency:automatic.latency,ackToAutomaticCompletedMs:performance.now()-before};
}
try{
 const binary=path.join(root,'src-tauri/target/debug/meeting-copilot.exe');
 report.binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
 report.sourceCommit=(await new Promise(resolve=>{const p=spawn('git',['rev-parse','HEAD'],{windowsHide:true,stdio:['ignore','pipe','ignore']});let text='';p.stdout.on('data',b=>text+=b);p.on('exit',()=>resolve(text.trim()));}));
 const exeDir=path.join(local,'app');await mkdir(exeDir,{recursive:true});
 for(const name of await readdir(path.dirname(binary)))if(name==='meeting-copilot.exe'||name.endsWith('.dll'))await copyFile(path.join(path.dirname(binary),name),path.join(exeDir,name));
 try{await fetch('http://127.0.0.1:1420');}catch{vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1420','--strictPort'],{windowsHide:true,stdio:'ignore'});await sleep(1500);}
 app=spawn(path.join(exeDir,'meeting-copilot.exe'),[],{cwd:root,windowsHide:true,env:{...process.env,COPILOT_DATA_DIR:path.join(local,'data'),WEBVIEW2_USER_DATA_FOLDER:path.join(local,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9560'},stdio:['ignore','ignore','pipe']});
 let stderr='';app.stderr.on('data',b=>stderr=(stderr+b.toString()).slice(-4000));
 for(let i=0;i<150;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9560');break;}catch{if(app.exitCode!==null)throw Error(`App exited ${app.exitCode}: ${stderr}`);await sleep(100);}}
 if(!browser)throw Error('Native CDP did not open');
 for(let i=0;i<100;i++){const pages=browser.contexts()[0].pages();main=pages.find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));overlay=pages.find(p=>p.url().includes('view=overlay'));if(main&&overlay)break;await sleep(100);}
 const boot=await invoke('bootstrap');if(!boot.selected?.planEnabled)throw Error('Signed-in Codex account is required');
 const models=await invoke('list_models');if(!models.some(m=>m.slug===report.model))throw Error('Requested model absent from live catalog');
 report.catalogVerified=true;report.shortcutErrors=boot.shortcutErrors;
 const settings={...boot.settings,model:report.model,reasoningEffort:'low',answerBackend:'codex',serviceTier:'fast',answerObjective:'detailed',speechBackend:'whisper',modelPath:path.join(root,'models/ggml-tiny.en.bin'),microphone:boot.devices.find(d=>d.source==='self'&&d.default)?.id??boot.devices.find(d=>d.source==='self')?.id,output:boot.devices.find(d=>d.source==='remote'&&d.default)?.id??boot.devices.find(d=>d.source==='remote')?.id};
 await invoke('start_meeting',{settings});await invoke('action',{action:'pause'});await until(s=>s.paused);
 screenBrowser=await chromium.launch({channel:'msedge',headless:false,args:['--start-maximized','--remote-debugging-port=9562']});screen=await screenBrowser.newPage();
 for(let i=0;i<problems.length;i++){
  const p=problems[i],mode=i%2===0?'screenshot':'project';
  const evidence=await handoff(p,i+1,mode);
  const response=await answer('Solve only the current attached TASK.md or visible LeetCode task. Start with the exact context marker from that attachment. Then give a single fenced javascript block defining function solve with the specified arguments and return value, with no imports or exports. Include complete runnable implementation, then state time and space complexity. Do not use prior tasks.');
  const code=codeFrom(response.answer),grade=gradeCode(p.id,code),markerCorrect=response.answer.includes(evidence.marker);
  await writeFile(path.join(out,`solution-${p.id}.js`),code);
  const row={id:p.id,title:p.title,difficulty:p.difficulty,url:p.url,mode,...evidence,...response,markerCorrect,grade,accurate:markerCorrect&&grade.passed};
  report.rows.push(row);await persist();console.log('RESULT',JSON.stringify({id:p.id,mode,markerCorrect,passed:grade.passed,cases:`${grade.passedCases}/${grade.totalCases}`,firstWordMs:response.firstWordMs,completedMs:response.completedMs}));
 }
 // Interview uses the full multi-file project, not a pasted explanation of the bug.
 await invoke('action',{action:'clear_screenshot'});await invoke('action',{action:'clear_project'});
 ready={index:26,id:'interview',mode:'project',title:'Inventory service bug interview',folder:path.join(root,'benchmarks/context-handoff/project'),content:'Open the project folder and press Ctrl Shift P. Diagnosis must come from project source.'};ack=false;
 console.log('HANDOFF_READY',JSON.stringify(ready));while(!ack)await sleep(100);
 await until(s=>s.project&&!s.attachmentBusy);await until(s=>s.latency?.completedAt!=null);
 for(const question of [
  'Interview round 1: Find the inventory correctness bug in the attached project. Constraints: rejected multi-item reservations must leave stock and request records unchanged; quantities are positive integers; request IDs are idempotent; API synchronous; no dependencies or test edits. Give exact source path, mechanism and a smallest reproducible input showing before and after inventory. Do not implement yet.',
  'Interview round 2: Implement the minimal fix. Return the complete replacement src/reservations.mjs in one fenced javascript block exporting class Reservations. Preserve synchronous public API and response shape. Aggregate duplicate SKUs before validating stock; validate all quantities before any mutation. No dependencies or test edits.',
  'Interview round 3: Check your fix on stock A=3 and an order with two A line items of quantity 2, and on stock A=3,B=2 with A quantity 1 then B quantity 0. Show that both rejections are atomic, then explain the accepted-request retry behavior. Return the final complete src/reservations.mjs again in a fenced javascript block.'
 ]){const response=await answer(question);report.interview.push(response);await persist();console.log('INTERVIEW_RESULT',report.interview.length,response.firstWordMs,response.completedMs);}
 ready=null;report.completedAt=new Date().toISOString();report.status='complete';await persist();
}catch(e){report.status='failed';report.error=String(e);await persist();console.error(e);process.exitCode=1;}
finally{if(main)try{await invoke('stop_meeting');}catch{}await browser?.close();await screenBrowser?.close();app?.kill();vite?.kill();server.closeAllConnections();server.close();}
