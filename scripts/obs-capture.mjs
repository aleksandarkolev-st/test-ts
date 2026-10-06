import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=s=>createHash('sha256').update(s).digest('base64');
export async function testCapture(invoke){
  const root=process.cwd(),obsDir=path.join(root,'.local/obs-current'),config=path.join(obsDir,'config/obs-studio'),output=path.join(root,'artifacts/capture');
  await mkdir(path.join(config,'plugin_config/obs-websocket'),{recursive:true});await mkdir(path.join(config,'basic/profiles/CaptureTest'),{recursive:true});await mkdir(output,{recursive:true});
  const password=randomBytes(24).toString('base64');
  await writeFile(path.join(config,'plugin_config/obs-websocket/config.json'),JSON.stringify({first_load:false,server_enabled:true,server_port:4447,alerts_enabled:false,auth_required:true,server_password:password}));
  await writeFile(path.join(config,'global.ini'),'[General]\nFirstRun=false\nEnableAutoUpdates=false\n[Basic]\nProfile=CaptureTest\nProfileDir=CaptureTest\n[BasicWindow]\nWarnBeforeStartingStream=false\n');
  await writeFile(path.join(config,'user.ini'),'[General]\nLastVersion=536936448\n[Basic]\nProfile=CaptureTest\nProfileDir=CaptureTest\nSceneCollection=CaptureTest\nSceneCollectionFile=CaptureTest\nConfigOnNewProfile=false\n[BasicWindow]\nSysTrayEnabled=true\nSysTrayWhenStarted=true\n');
  await mkdir(path.join(config,'basic/scenes'),{recursive:true});
  await writeFile(path.join(config,'basic/scenes/CaptureTest.json'),JSON.stringify({name:'CaptureTest',current_scene:'Copilot capture test',current_program_scene:'Copilot capture test',scene_order:[{name:'Copilot capture test'}],sources:[{name:'Copilot capture test',id:'scene',versioned_id:'scene',settings:{items:[]}}],groups:[],transitions:[{name:'Fade',id:'fade_transition',settings:{}}],current_transition:'Fade',transition_duration:300}));
  await writeFile(path.join(config,'basic/profiles/CaptureTest/basic.ini'),'[General]\nName=CaptureTest\n[Video]\nBaseCX=1920\nBaseCY=1080\nOutputCX=1920\nOutputCY=1080\nFPSCommon=30\n[Audio]\nSampleRate=48000\nChannelSetup=Stereo\n');
  let obs,background,ws;const pending=new Map();
  try{
    background=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/capture-background.ps1')],{windowsHide:true,stdio:'ignore'});await sleep(1500);
    obs=spawn(path.join(obsDir,'bin/64bit/obs64.exe'),['--portable','--multi','--profile','CaptureTest','--collection','CaptureTest','--minimize-to-tray','--disable-updater','--disable-shutdown-check','--websocket_ipv4_only'],{cwd:path.join(obsDir,'bin/64bit'),windowsHide:true,stdio:'ignore'});
    obs.on('error',()=>{});
    let connected=false;
    for(let i=0;i<100&&!connected;i++){
      try{
        await new Promise((resolve,reject)=>{
          const socket=new WebSocket('ws://127.0.0.1:4447');const timer=setTimeout(()=>{socket.close();reject(Error('OBS connection timed out'));},1000);
          socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.op===0){const authentication=m.d.authentication?sha(sha(password+m.d.authentication.salt)+m.d.authentication.challenge):undefined;socket.send(JSON.stringify({op:1,d:{rpcVersion:1,eventSubscriptions:0,authentication}}));}
            if(m.op===2){clearTimeout(timer);ws=socket;connected=true;resolve();}
            if(m.op===7){const p=pending.get(m.d.requestId);if(p){pending.delete(m.d.requestId);m.d.requestStatus.result?p.resolve(m.d.responseData||{}):p.reject(Error(`${m.d.requestType}: ${m.d.requestStatus.comment}`));}}};
          socket.onerror=()=>{clearTimeout(timer);reject(Error('OBS WebSocket unavailable'));};
        });
      }catch{await sleep(200);}
    }
    assert(connected,'OBS did not start its isolated WebSocket server');
    const request=(requestType,requestData={})=>new Promise((resolve,reject)=>{const requestId=randomBytes(6).toString('hex');const timer=setTimeout(()=>{pending.delete(requestId);reject(Error(`OBS request timeout: ${requestType}`));},5000);pending.set(requestId,{resolve:d=>{clearTimeout(timer);resolve(d);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({op:6,d:{requestType,requestId,requestData}}));});
    let version;for(let i=0;i<60;i++){try{version=await request('GetVersion');break;}catch{await sleep(500);}}assert(version,'OBS did not finish initialization');let sceneName='Copilot capture test';const scenes=await request('GetSceneList');if(!scenes.scenes.some(s=>s.sceneName===sceneName))await request('CreateScene',{sceneName});await request('SetCurrentProgramScene',{sceneName});
    await request('CreateInput',{sceneName,inputName:'Display',inputKind:'monitor_capture',inputSettings:{monitor:0,capture_cursor:false},sceneItemEnabled:true});
    const monitors=await request('GetInputPropertiesListPropertyItems',{inputName:'Display',propertyName:'monitor_id'});
    const monitor=monitors.propertyItems.find(x=>x.itemEnabled&&x.itemValue!=='DUMMY');assert(monitor,'OBS did not enumerate a connected monitor');
    await request('SetInputSettings',{inputName:'Display',inputSettings:{monitor_id:monitor.itemValue,method:1,capture_cursor:false}});
    await invoke('acceptance_protection',{enabled:false});
    await request('CreateInput',{sceneName,inputName:'Overlay window',inputKind:'window_capture',inputSettings:{capture_cursor:false},sceneItemEnabled:true});
    const windows=await request('GetInputPropertiesListPropertyItems',{inputName:'Overlay window',propertyName:'window'});
    const target=windows.propertyItems.find(x=>String(x.itemValue).startsWith('Copilot capture verification overlay:'));
    assert(target,'OBS could not enumerate the real native overlay window');
    await request('SetInputSettings',{inputName:'Overlay window',inputSettings:{window:target.itemValue,method:2,client_area:true}});
    await sleep(1200);
    const diagnostic=await invoke('native_diagnostics');await writeFile(path.join(output,'geometry.json'),JSON.stringify(diagnostic));
    const screenshot=async(sourceName,name)=>{const d=await request('GetSourceScreenshot',{sourceName,imageFormat:'png'});await writeFile(path.join(output,name),Buffer.from(d.imageData.split(',')[1],'base64'));};
    await invoke('acceptance_protection',{enabled:false});await sleep(1000);
    await screenshot('Display','obs-display-control.png');await screenshot('Overlay window','obs-window-control.png');
    await invoke('acceptance_protection',{enabled:true});await sleep(1000);
    await screenshot('Display','obs-display-protected.png');
    // Start a new capture after affinity is active, matching app startup.
    // A running WGC source can retain its last pre-protection frame.
    await request('RemoveInput',{inputName:'Overlay window'});
    await request('CreateInput',{sceneName,inputName:'Protected overlay window',inputKind:'window_capture',inputSettings:{window:target.itemValue,method:2,client_area:true,capture_cursor:false},sceneItemEnabled:true});
    await sleep(1500);
    let protectedWindowRefused=false;
    try{await screenshot('Protected overlay window','obs-window-protected.png');}catch(e){if(!String(e).includes('Failed to render screenshot'))throw e;protectedWindowRefused=true;}
    await writeFile(path.join(output,'window-status.json'),JSON.stringify({protectedWindowRefused}));
    const metrics=await new Promise((resolve,reject)=>{const child=spawn('python',[path.join(root,'scripts/compare-capture.py'),output],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(Error(err||out)));});
    const result={obsVersion:version.obsVersion,websocketVersion:version.obsWebSocketVersion,metrics,pass:true};await writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));return result;
  }finally{
    try{await invoke('acceptance_protection',{enabled:true});}catch{}
    ws?.close();obs?.kill();background?.kill();
  }
}
