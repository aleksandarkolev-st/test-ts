import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(), artifact=path.join(root,'artifacts/camera-native'), application=path.join(root,'.local/camera-app');
await mkdir(artifact,{recursive:true});await mkdir(application,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{slug:'fixture-mini',display_name:'Fixture model',visibility:'list'}]}));});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
let app,browser,vite,main;const report={scope:'Actual native camera and OBS transport; no live correction/naturalness assertion',passed:false,checks:[]};
const check=text=>{report.checks.push(text);console.log(`PASS ${text}`);};
async function commandOutput(executable,args){return await new Promise((resolve,reject)=>{const child=spawn(executable,args,{windowsHide:true,cwd:root,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(out):reject(Error(`Local check failed (${code}): ${err.slice(-1000)}`)));});}
try{
  for(const name of await readdir(path.join(root,'src-tauri/target/debug')))if(name==='meeting-copilot.exe'||name.endsWith('.dll'))await copyFile(path.join(root,'src-tauri/target/debug',name),path.join(application,name));
  try{await fetch('http://127.0.0.1:1420');}catch{vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1420','--strictPort'],{windowsHide:true,stdio:'ignore'});for(let i=0;i<50;i++){try{await fetch('http://127.0.0.1:1420');break;}catch{await sleep(100);}}}
  app=spawn(path.join(application,'meeting-copilot.exe'),[],{windowsHide:true,env:{...process.env,COPILOT_ACCEPTANCE:'1',COPILOT_TEST_API:`http://127.0.0.1:${fixture.address().port}/v1`,COPILOT_DATA_DIR:path.join(root,'.local/camera-test-data'),WEBVIEW2_USER_DATA_FOLDER:path.join(root,'.local/camera-webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9228'},stdio:'ignore'});
  for(let i=0;i<100;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9228');break;}catch{assert.equal(app.exitCode,null);await sleep(100);}}
  assert(browser);for(let i=0;i<100;i++){main=browser.contexts()[0].pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));if(main)break;await sleep(100);}assert(main);
  const invoke=(name,args={})=>main.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
  async function until(predicate,ms=30000){const end=Date.now()+ms;let last;while(Date.now()<end){last=await invoke('gaze_snapshot');if(predicate(last))return last;await sleep(50);}const{preview,...metadata}=last||{};report.timeoutState={...metadata,previewPresent:!!preview};throw Error('Camera state timed out');}
  const devices=await invoke('gaze_devices');report.devices=devices;
  const input=devices.cameras.find(c=>c.allowed),output=devices.cameras.find(c=>!c.allowed);
  assert(input,'Connect an input camera before running native camera acceptance');assert(output,'OBS output must be enumerated');
  const gpu=devices.gpus.find(g=>/RX 9070 XT/.test(g.name));assert(gpu,'The requested discrete AMD GPU must be enumerated');
  check('Named DirectShow input/output and RX 9070 XT DirectML adapter are discovered');
  await invoke('gaze_start',{settings:{camera:output.index,device:gpu.index,strength:12}});
  const rejected=await until(s=>!s.loading&&!s.running&&s.error);assert.match(rejected.error,/output|feedback/);
  check('OBS output is rejected as an input before camera capture');
  await invoke('gaze_start',{settings:{camera:input.index,device:gpu.index,strength:12}});
  const live=await until(s=>s.running&&s.preview&&s.fps>0);
  assert.equal(live.calibrated,false);assert.equal(live.correcting,false);assert.match(live.device,/RX 9070 XT/);
  assert(live.preview.startsWith('data:image/jpeg;base64,'));
  const {preview,...metadata}=live;report.previewBytes=Buffer.from(preview.split(',')[1],'base64').length;report.live=metadata;
  report.inputRateLimited=live.fps<15;
  check('Actual input frames reach the native preview with correction gated until calibration');
  report.obs=JSON.parse(await commandOutput(path.join(root,'.local/gaze-runtime/Scripts/python.exe'),['scripts/check-obs-output.py']));
  assert.equal(report.obs.frames,4);assert.deepEqual(report.obs.shape,[720,1280,3]);
  check('Independent DirectShow consumer receives real 1280 × 720 OBS Virtual Camera output');
  await main.getByRole('button',{name:'Stop camera',exact:true}).scrollIntoViewIfNeeded();
  // Hide the preview for layout QA: never persist a user's camera image.
  await main.addStyleTag({content:'.camera-preview { visibility: hidden !important; }'});
  await main.screenshot({path:path.join(artifact,'controls.png')});
  await main.getByRole('button',{name:'Stop camera',exact:true}).click();
  const stopped=await until(s=>!s.running&&!s.loading&&s.preview===null);assert.equal(stopped.calibrated,false);assert.equal(stopped.correcting,false);
  check('Native Stop camera closes capture/output and clears preview and calibration');
  report.passed=true;
}catch(error){report.failure=String(error);throw error;}finally{
  if(main)try{await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('gaze_stop'));}catch{}
  await writeFile(path.join(artifact,'results.json'),JSON.stringify(report,null,2));
  await browser?.close();app?.kill();vite?.kill();fixture.closeAllConnections();fixture.close();
}
