import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

// Only deliberately generated source and a fullscreen synthetic page are
// attached. Reports contain verdicts/metadata, never account credentials.
const root=process.cwd(),port=Number(process.env.COPILOT_CDP_PORT||9557);
const artifactName=process.env.COPILOT_CONTEXT_ARTIFACT_NAME||'live-context';assert.match(artifactName,/^[A-Za-z0-9_-]+$/);
const project=path.join(root,'.local/live-context-project'),artifact=path.join(root,'artifacts',artifactName);
await mkdir(path.join(project,'src/deep'),{recursive:true});await mkdir(artifact,{recursive:true});
await writeFile(path.join(project,'README.md'),'Synthetic deployment fixture. See the nested source for the release configuration.\n');
await writeFile(path.join(project,'src/deep/release.ts'),"export const release = { code: 'CEDAR-782', date: '2032-04-17', owner: 'Mira' };\n");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={passed:false,model:process.env.COPILOT_LIVE_MODEL||'gpt-5.6-luna',reasoningEffort:'xhigh',checks:[],scope:'Actual signed-in production answer backend with controlled synthetic project and screen'};
let browser,desktop,main,started=false,original;
const stopFile=path.join(root,'.local',`context-screen-stop-${process.pid}-${Date.now()}`);
async function shortcut(key){await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-Command',`${key==='{F8}'?"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CopilotTestPointer { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); }'; [CopilotTestPointer]::SetCursorPos(300,250) | Out-Null; ":''}$copilotKeys=New-Object -ComObject WScript.Shell; $copilotKeys.SendKeys('^+${key}')`],{windowsHide:true,stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Shortcut injection failed')));});}
try{
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 main=browser.contexts()[0].pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));assert(main);
 const invoke=(name,args={})=>main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
 async function until(predicate,ms=90000){const end=Date.now()+ms;while(Date.now()<end){const state=await invoke('get_snapshot');if(state.error)throw Error(state.error);if(predicate(state))return state;await sleep(30);}throw Error('Production context check timed out');}
 const boot=await invoke('bootstrap');assert.equal(boot.debug,false);assert.equal(boot.snapshot.active,false);assert(boot.selected?.planEnabled);assert((await invoke('list_models')).some(m=>m.slug===report.model));
 report.answerBackend=boot.settings.answerBackend||'chatgpt';report.serviceTier=boot.settings.serviceTier||null;
 assert(!boot.shortcutErrors.some(e=>e.startsWith('Ctrl+Shift+P is unavailable;')||e.startsWith('Ctrl+Shift+F8 is unavailable;')));
 original=boot.settings;
 await invoke('start_meeting',{settings:{...original,projectPath:project,model:report.model,reasoningEffort:report.reasoningEffort}});started=true;
 await invoke('action',{action:'pause'});await until(s=>s.paused);
 await shortcut('p');await until(s=>s.project&&!s.attachmentBusy&&s.latency?.completedAt!=null);
 await invoke('ask',{question:'According to the attached source, what are the exact release code, ISO date and owner?'});
 const code=await until(s=>s.latency?.completedAt!=null&&s.question?.text.startsWith('According to the attached source'));
 const sourceVerdict={code:code.answer.includes('CEDAR-782'),date:code.answer.includes('2032-04-17'),owner:/Mira/i.test(code.answer)};
 report.source=sourceVerdict;assert(Object.values(sourceVerdict).every(Boolean),'The live model did not recall all nested source facts');report.checks.push('Native project shortcut and subsequent answer understand all controlled nested source facts');
 await invoke('action',{action:'clear_project'});await until(s=>!s.project&&!s.question);
 desktop=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/context-screen-fixture.ps1'),'-StopFile',stopFile],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{let output='',error='';const timeout=setTimeout(()=>reject(Error(`Synthetic screen did not open: ${error.slice(-500)}`)),15000);desktop.stdout.on('data',b=>{output+=b;if(output.includes('"event":"ready"')){clearTimeout(timeout);resolve();}});desktop.stderr.on('data',b=>error+=b);desktop.on('error',e=>{clearTimeout(timeout);reject(e);});desktop.on('exit',code=>{clearTimeout(timeout);if(!output.includes('"event":"ready"'))reject(Error(`Synthetic screen exited ${code}: ${error.slice(-500)}`));});});
 await sleep(500);await shortcut('{F8}');const captured=await until(s=>s.screenshot&&!s.attachmentBusy);
 report.imageDimensions={width:captured.screenshot.width,height:captured.screenshot.height};
 await writeFile(stopFile,'stop');await new Promise(resolve=>desktop.exitCode!==null?resolve():desktop.once('exit',resolve));desktop=null;
 await until(s=>s.latency?.completedAt!=null);
 await invoke('ask',{question:'Read the exact visual verification code from the attached screenshot, and name the source and destination of its arrow.'});
 const image=await until(s=>s.latency?.completedAt!=null&&s.question?.text.startsWith('Read the exact visual'));
 const normalized=image.answer.replace(/[*_`]/g,'');
 const imageVerdict={code:normalized.includes('ORBIT-649'),source:/QUEUE\s*A/i.test(normalized),destination:/ARCHIVE\s*B/i.test(normalized)};
 report.image=imageVerdict;if(!Object.values(imageVerdict).every(Boolean))report.syntheticImageAnswer=image.answer;
 assert(Object.values(imageVerdict).every(Boolean),'The live model did not understand the controlled screenshot');report.checks.push('Native screenshot shortcut and subsequent answer read the controlled image code and diagram');
 await invoke('action',{action:'clear_screenshot'});await until(s=>!s.screenshot&&!s.question);
 report.checks.push('Context removal clears the production attachment state');report.passed=true;
}catch(error){report.failure=String(error);throw error;}finally{
 if(desktop){await writeFile(stopFile,'stop');desktop.kill();}
 if(main&&started){try{await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('stop_meeting'));if(original)await main.evaluate(settings=>window.__TAURI_INTERNALS__.invoke('save_settings',{settings}),original);}catch(error){report.cleanupFailure=String(error);report.passed=false;process.exitCode=1;}}
 report.completedAt=new Date().toISOString();await writeFile(path.join(artifact,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser?.close();
}
