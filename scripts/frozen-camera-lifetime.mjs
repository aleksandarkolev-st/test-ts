import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),directory=process.env.COPILOT_PACKAGE_DIR;
assert(directory,'Set COPILOT_PACKAGE_DIR to the verified extracted package');
const executable=path.join(directory,'meeting-copilot.exe');await access(executable);
const port=9558,sleep=ms=>new Promise(r=>setTimeout(r,ms));
let occupied=false;try{occupied=(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{}
assert(!occupied,'Frozen lifetime CDP port is already owned');
const report={passed:false,scope:'Actual frozen production camera worker and descendant lifetime after unexpected parent termination; no live correction/naturalness claim'};
let app,browser,owned=[];
async function powershell(command){return await new Promise((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',error='';const timeout=setTimeout(()=>{child.kill();reject(Error('Process query timed out'));},10000);
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.on('error',e=>{clearTimeout(timeout);reject(e);});
  child.on('exit',code=>{clearTimeout(timeout);code===0?resolve(output):reject(Error(`Process query failed: ${error.slice(-500)}`));});
});}
const processes=async()=>JSON.parse(await powershell("@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='CreationDate';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''}}}) | ConvertTo-Json -Compress"));
const same=(a,b)=>a.ProcessId===b.ProcessId&&a.Name===b.Name&&a.CreationDate===b.CreationDate;
try{
  app=spawn(executable,[],{cwd:directory,windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(root,`.local/frozen-lifetime-webview-${Date.now()}`),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
  for(let i=0;i<150;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{assert.equal(app.exitCode,null);await sleep(100);}}
  assert(browser,'Production WebView did not open');let main;
  for(let i=0;i<100;i++){main=browser.contexts()[0].pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));if(main)break;await sleep(100);}assert(main);
  const invoke=(name,args={})=>main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
  report.version=await invoke('plugin:app|version');assert.equal(report.version,JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version);
  let boot;
  try{boot=await invoke('bootstrap');}catch(error){
    if(!String(error).includes('state not managed'))throw error;
    report.earlyStateUnavailable=true;await sleep(1500);boot=await invoke('bootstrap');
  }
  await sleep(500);
  report.frontendStartupStateError=(await main.locator('[role="alert"]').allTextContents()).some(t=>t.includes('state not managed'));
  assert.equal(report.frontendStartupStateError,false,'Cold-start frontend failed before native state was managed');
  assert.equal(boot.debug,false);assert.equal(boot.snapshot.active,false);
  const devices=await invoke('gaze_devices'),camera=devices.cameras.find(c=>c.allowed),gpu=devices.gpus.find(g=>/RX 9070 XT/.test(g.name));assert(camera&&gpu);
  await invoke('gaze_start',{settings:{camera:camera.index,device:gpu.index,strength:12}});
  const deadline=Date.now()+45000;let state;
  while(Date.now()<deadline){state=await invoke('gaze_snapshot');assert(!state.error,state.error);if(state.running&&state.preview&&state.fps>0)break;await sleep(50);}
  assert(state.running&&state.preview&&state.fps>0,'Frozen worker must actually deliver video before forced termination');
  report.camera=camera.name;report.gpu=gpu.name;report.fps=state.fps;report.face=state.face;
  const all=await processes(),descendants=new Set([app.pid]);let changed=true;
  while(changed){changed=false;for(const p of all)if(descendants.has(p.ParentProcessId)&&!descendants.has(p.ProcessId)){descendants.add(p.ProcessId);changed=true;}}
  owned=all.filter(p=>descendants.has(p.ProcessId)&&p.Name==='gaze-worker.exe');
  assert(owned.length>=1,'Frozen worker must be a descendant of the tested parent');
  report.ownedWorkers=owned.map(p=>({pid:p.ProcessId,name:p.Name}));
  await browser.close();browser=null;assert.equal(app.exitCode,null);app.kill();
  const exitDeadline=Date.now()+15000;let remaining;
  do{await sleep(250);remaining=(await processes()).filter(p=>owned.some(o=>same(o,p)));}while(remaining.length&&Date.now()<exitDeadline);
  report.remainingWorkers=remaining.length;assert.equal(remaining.length,0,'Frozen camera descendant survived unexpected parent termination');
  report.passed=true;console.log(JSON.stringify(report));
}catch(error){report.failure=String(error);throw error;}finally{
  await browser?.close();app?.kill();
  // If containment fails, release only this test's still-identical workers.
  // Compare creation time as well as PID/name so PID reuse cannot target others.
  if(owned.length){const remaining=(await processes()).filter(p=>owned.some(o=>same(o,p)));for(const p of remaining)await powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${p.ProcessId}'; if($p -and $p.Name -eq 'gaze-worker.exe' -and ($p.CreationDate.ToUniversalTime().ToString('o') -eq '${String(p.CreationDate).replaceAll("'","''")}')) { Stop-Process -Id ${p.ProcessId} -Force }`);}
  const artifact=path.join(root,'artifacts/gaze');await mkdir(artifact,{recursive:true});
  report.completedAt=new Date().toISOString();await writeFile(path.join(artifact,'frozen-lifetime.json'),JSON.stringify(report,null,2));
}
