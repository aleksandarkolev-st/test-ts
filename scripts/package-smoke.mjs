import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,access,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),dir=process.env.COPILOT_PACKAGE_DIR||path.join(root,'.local/msi-extracted/PFiles/Meeting Copilot'),keep=process.argv.includes('--keep');
await mkdir(path.join(root,'artifacts/package'),{recursive:true});
const required=['meeting-copilot.exe','whisper.dll','ggml.dll','ggml-base.dll',...['x64','sse42','sandybridge','haswell','skylakex','icelake','alderlake'].map(n=>`ggml-cpu-${n}.dll`),'models/ggml-tiny.en.bin','LICENSE.txt','THIRD_PARTY_NOTICES.txt','models/nemotron-speech-streaming-en-0.6b.q8_0.gguf','nemotron/nemo-speech.exe','gaze/gaze-worker.exe','gaze/_internal/onnxruntime/capi/DirectML.dll','gaze/licenses/PYTHON-LICENSE.txt','models/gaze/flx-l.onnx','models/gaze/flx-r.onnx','models/gaze/face_landmarker.task','licenses/models/FLX-LICENSE.txt','licenses/models/NVIDIA-OPEN-MODEL-LICENSE.pdf','licenses/models/Nemotron-Notice.txt','codex/codex.exe','codex/LICENSE.txt','codex/NOTICE.txt','codex/manifest.json'];
for(const name of required)await access(path.join(dir,name));
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
for(const name of required.filter(n=>n.endsWith('.dll')))assert.equal(await hash(path.join(dir,name)),await hash(path.join(root,'src-tauri/target/release',name)),`Stale packaged runtime: ${name}`);
// Tauri temporarily patches this marker for MSI bundling, then restores UNK
// in the loose executable. Compare every byte with that one known patch.
const compiledExecutable=await readFile(path.join(root,'src-tauri/target/release/meeting-copilot.exe'));
const marker=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),markerOffset=compiledExecutable.indexOf(marker);
if(markerOffset>=0)Buffer.from('__TAURI_BUNDLE_TYPE_VAR_MSI').copy(compiledExecutable,markerOffset);
assert.deepEqual(await readFile(path.join(dir,'meeting-copilot.exe')),compiledExecutable,'Stale packaged executable');
assert.equal(await hash(path.join(dir,'models/ggml-tiny.en.bin')),'921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f');
assert.equal(await hash(path.join(dir,'models/nemotron-speech-streaming-en-0.6b.q8_0.gguf')),'d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d');
assert.equal(await hash(path.join(dir,'models/gaze/face_landmarker.task')),'64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff');
assert.equal(await hash(path.join(dir,'codex/codex.exe')),'9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d');
let resourceFiles=0;
async function verifyTree(source,target){for(const entry of await readdir(source,{withFileTypes:true})){const a=path.join(source,entry.name),b=path.join(target,entry.name);if(entry.isDirectory())await verifyTree(a,b);else{assert.equal(await hash(b),await hash(a),`Stale packaged resource: ${b}`);resourceFiles++;}}}
await verifyTree(path.join(root,'.local/gaze-dist/gaze-worker'),path.join(dir,'gaze'));
await verifyTree(path.join(root,'.local/nemotron/nemo-speech-0.2.0-windows-x86_64-vulkan/bin'),path.join(dir,'nemotron'));
await verifyTree(path.join(root,'.local/nemotron/nemo-speech-0.2.0-windows-x86_64-vulkan/share/licenses'),path.join(dir,'licenses/nemotron'));
await verifyTree(path.join(root,'models/gaze'),path.join(dir,'models/gaze'));
for(const name of ['codex.exe','LICENSE.txt','NOTICE.txt','manifest.json']){assert.equal(await hash(path.join(dir,'codex',name)),await hash(path.join(root,'.local/codex',name)),`Stale Codex resource: ${name}`);resourceFiles++;}
let existingEndpoint = false;
try { existingEndpoint = (await fetch('http://127.0.0.1:9557/json/version')).ok; } catch {}
assert.equal(existingEndpoint, false, 'CDP port 9557 is already owned; close the verified idle app before checking a new package');
const app=spawn(path.join(dir,'meeting-copilot.exe'),[],{cwd:dir,detached:keep,windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'.local/packaged-webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9557'},stdio:'ignore'});
let browser,succeeded=false;
try{
  for(let i=0;i<150;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9557');break;}catch{assert.equal(app.exitCode,null,`Packaged executable exited ${app.exitCode}`);await new Promise(r=>setTimeout(r,100));}}
  assert(browser,'Packaged WebView2 did not initialize');let page;
  for(let i=0;i<100;i++){page=browser.contexts()[0].pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));if(page)break;await new Promise(r=>setTimeout(r,100));}
  assert(page,'Packaged main window did not load');
  const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
  const applicationVersion=await invoke('plugin:app|version');
  const expectedVersion=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
  assert.equal(applicationVersion,expectedVersion,'Extracted app version differs from this build');
  let b=await invoke('bootstrap');assert.equal(b.debug,false);assert(b.devices.length>1);assert(b.snapshot.protection);
  if(process.argv.includes('--use-bundled-speech')){
    assert.equal(b.snapshot.active,false);
    await invoke('save_settings',{settings:{...b.settings,speechBackend:'nemotron',speechChunkMs:160,nemotronDevice:1,modelPath:path.join(dir,'models/nemotron-speech-streaming-en-0.6b.q8_0.gguf'),nemotronRuntime:path.join(dir,'nemotron/nemo-speech.exe')}});
    b=await invoke('bootstrap');
  }
  if(process.argv.includes('--use-codex')){
    assert.equal(b.snapshot.active,false);
    await invoke('save_settings',{settings:{...b.settings,answerBackend:'codex',model:'gpt-6-luna',serviceTier:'fast',reasoningEffort:'xhigh'}});
    b=await invoke('bootstrap');assert(b.selected?.planEnabled,'The native Codex account must be signed in');
    assert((await invoke('list_models')).some(m=>m.slug==='gpt-6-luna'),'GPT-6 Luna must be in the Codex catalog');
    await page.reload();
    await page.getByLabel('Answer backend').waitFor();
    await page.waitForFunction(()=>document.querySelector('select[aria-label="Answer backend"]')?.value==='codex'&&document.querySelector('select[aria-label="Answer model"]')?.value==='gpt-6-luna');
    assert.equal(await page.getByLabel('Answer model').inputValue(),'gpt-6-luna');
    assert.equal(await page.getByLabel('Answer speed').inputValue(),'fast');
    assert.equal(await page.getByLabel('Reasoning effort').inputValue(),'xhigh');
  }
  await access(b.settings.modelPath);
  assert.equal(b.settings.speechBackend,'nemotron');await access(b.settings.nemotronRuntime);assert.equal(b.settings.speechChunkMs,160);
  const cameraDevices=await invoke('gaze_devices');assert(cameraDevices.cameras.some(c=>c.allowed));const gpu=cameraDevices.gpus.find(g=>/RX 9070 XT/.test(g.name));assert(gpu);
  const input=cameraDevices.cameras.find(c=>c.allowed);
  await invoke('gaze_start',{settings:{camera:input.index,device:gpu.index,strength:12}});
  let camera;const cameraDeadline=Date.now()+45000;
  while(Date.now()<cameraDeadline){camera=await invoke('gaze_snapshot');if(camera.error)throw Error(camera.error);if(camera.running&&camera.preview)break;await new Promise(r=>setTimeout(r,50));}
  assert(camera.running&&camera.preview,'Frozen camera runtime did not deliver a preview');assert.equal(camera.calibrated,false);await invoke('gaze_stop');assert.equal((await invoke('gaze_snapshot')).preview,null);
  assert.equal(app.exitCode, null, 'The package process exited before its production checks');
  for(const [name,args] of [['open_debug',{}],['native_diagnostics',{}],['acceptance_event',{kind:'transcript',source:'remote',text:'Fixture question?'}],['acceptance_protection',{enabled:false}]]){
    await assert.rejects(invoke(name,args));
  }
  const result={pass:true,applicationVersion,packageDirectory:dir,packagedFiles:required.length,verifiedSidecarResources:resourceFiles,runtimeHashesMatchBuild:true,modelChecksumVerified:true,nemotronDefault:true,frozenCameraPreview:true,productionDebugDisabled:true,acceptanceHooksDisabled:true,captureProtectionReadback:true,audioDeviceCount:b.devices.length,answerBackend:b.settings.answerBackend,model:b.settings.model,serviceTier:b.settings.serviceTier,completedAt:new Date().toISOString()};await writeFile(path.join(root,'artifacts/package/results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  succeeded=true;
  if(keep){console.log('Packaged app remains open for the live ChatGPT sign-in check.');app.unref();}
}finally{if(browser){const main=browser.contexts()[0].pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));try{await main?.evaluate(()=>window.__TAURI_INTERNALS__.invoke('gaze_stop'));}catch{}}await browser?.close();if(!keep||!succeeded)app.kill();}
