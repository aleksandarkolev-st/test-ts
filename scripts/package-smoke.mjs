import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,access,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),dir=process.env.COPILOT_PACKAGE_DIR||path.join(root,'.local/msi-extracted/PFiles/Meeting Copilot'),keep=process.argv.includes('--keep');
await mkdir(path.join(root,'artifacts/package'),{recursive:true});
const required=['meeting-copilot.exe','whisper.dll','ggml.dll','ggml-base.dll',...['x64','sse42','sandybridge','haswell','skylakex','icelake','alderlake'].map(n=>`ggml-cpu-${n}.dll`),'models/ggml-tiny.en.bin','LICENSE.txt','THIRD_PARTY_NOTICES.txt'];
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
let existingEndpoint = false;
try { existingEndpoint = (await fetch('http://127.0.0.1:9557/json/version')).ok; } catch {}
assert.equal(existingEndpoint, false, 'CDP port 9557 is already owned; close the verified idle app before checking a new package');
const app=spawn(path.join(dir,'meeting-copilot.exe'),[],{cwd:dir,detached:keep,windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'.local/packaged-webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9557'},stdio:'ignore'});
let browser;
try{
  for(let i=0;i<150;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9557');break;}catch{assert.equal(app.exitCode,null,`Packaged executable exited ${app.exitCode}`);await new Promise(r=>setTimeout(r,100));}}
  assert(browser,'Packaged WebView2 did not initialize');let page;
  for(let i=0;i<100;i++){page=browser.contexts()[0].pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('view='));if(page)break;await new Promise(r=>setTimeout(r,100));}
  assert(page,'Packaged main window did not load');
  const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
  const b=await invoke('bootstrap');assert.equal(b.debug,false);assert(b.devices.length>1);assert(b.snapshot.protection);await access(b.settings.modelPath);
  assert.equal(app.exitCode, null, 'The package process exited before its production checks');
  for(const [name,args] of [['open_debug',{}],['native_diagnostics',{}],['acceptance_event',{kind:'transcript',source:'remote',text:'Fixture question?'}],['acceptance_protection',{enabled:false}]]){
    await assert.rejects(invoke(name,args));
  }
  const result={pass:true,packagedFiles:required.length,runtimeHashesMatchBuild:true,modelChecksumVerified:true,productionDebugDisabled:true,acceptanceHooksDisabled:true,captureProtectionReadback:true,audioDeviceCount:b.devices.length,completedAt:new Date().toISOString()};await writeFile(path.join(root,'artifacts/package/results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  if(keep){console.log('Packaged app remains open for the live ChatGPT sign-in check.');app.unref();}
}finally{await browser?.close();if(!keep)app.kill();}
