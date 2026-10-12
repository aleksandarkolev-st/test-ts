// Explicit local-ASR experiment. No assistant inference, word repair or policy.
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import {wordError} from './lib/controller-measurements.mjs';
const require=createRequire(import.meta.url),{ws:WebSocket}=require('../node_modules/playwright-core/lib/utilsBundle.js');
const [journalFile,outDir,backend]=process.argv.slice(2);assert(journalFile&&outDir&&/^vulkan:\d+$/.test(backend),'JOURNAL NEW_OUTPUT VULKAN_DEVICE');
const root=process.cwd(),out=path.resolve(outDir);assert(out.startsWith(path.resolve('artifacts')+path.sep));await mkdir(out);
const sha=b=>createHash('sha256').update(b).digest('hex'),bytes=await readFile(journalFile),j=JSON.parse(bytes);assert.equal(j.status,'complete');
const rows=j.rows.filter(r=>r.waveFile),target=rows.find(r=>r.runningAtSubmission?.length||r.audio?.runningAtPlaybackLaunch?.length);assert(target,'An observed speech-during-output target is required');
const sequence=rows.filter(r=>r.round<=target.round);assert(sequence.length>1);
function pcm(bytes){assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');let format,audio;
 for(let offset=12;offset+8<=bytes.length;){const size=bytes.readUInt32LE(offset+4),start=offset+8;assert(start+size<=bytes.length);const type=bytes.toString('ascii',offset,offset+4);if(type==='fmt ')format=bytes.subarray(start,start+size);if(type==='data')audio=bytes.subarray(start,start+size);offset=start+size+(size%2);}
 assert(format&&audio);assert.equal(format.readUInt16LE(0),1);assert.equal(format.readUInt16LE(2),1);assert.equal(format.readUInt32LE(4),16000);assert.equal(format.readUInt16LE(14),16);return audio;
}
const inputs=[];for(const r of sequence){const raw=await readFile(r.waveFile);assert.equal(sha(raw),r.waveSha256??r.audio?.sha256);inputs.push({round:r.round,waveFile:r.waveFile,waveSha256:sha(raw),question:r.question,pcm:pcm(raw),startMs:r.audio.playback.submitBeforeHostMs});}
const pieces=[],base=inputs[0].startMs;let frames=0,targetOffset;
for(const input of inputs){const start=Math.round((input.startMs-base)*16);assert(start>=frames,'Recorded sources overlap; this experiment does not mix source waveforms');pieces.push(Buffer.alloc((start-frames)*2));frames=start;if(input.round===target.round)targetOffset=frames;pieces.push(input.pcm);frames+=input.pcm.length/2;}
pieces.push(Buffer.alloc(16000*2*3));const audio=Buffer.concat(pieces);let lastVoice=inputs.at(-1).pcm.length/2-1;while(lastVoice>=0&&inputs.at(-1).pcm.readInt16LE(lastVoice*2)===0)lastVoice--;assert(lastVoice>=0);
const executable=path.resolve('.local/nemotron/nemo-speech-0.2.0-windows-x86_64-vulkan/bin/nemo-speech.exe'),model=path.resolve('models/nemotron-speech-streaming-en-0.6b.q8_0.gguf');
async function fileHash(file){const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
const protocolDoc='.local/nemotron/nemo-speech-0.2.0-windows-x86_64-vulkan/share/doc/nemo-speech/docs/api.md';
const report={status:'starting',startedAt:new Date().toISOString(),journalSha256:sha(bytes),targetRound:target.round,chunkMs:160,rightContext:1,backend,inputs:inputs.map(({pcm,...rest})=>rest),inputPcmSha256:sha(audio),runtimeSha256:await fileHash(executable),modelSha256:await fileHash(model),protocolDoc:{file:protocolDoc,sha256:await fileHash(protocolDoc)},wsLibrarySha256:await fileHash('node_modules/playwright-core/lib/utilsBundle.js'),collectorSha256:await fileHash('scripts/nemotron-finalization-replay.mjs'),trials:[],
 scope:'Local pinned ASR only. Identical PCM and preceding source-wave timing for each paired cell, with controlled leading-zero phase shifts. Fresh owned service per trial, awaited process exit before the next. Source WAV is fed directly, excluding WASAPI/resampling and assistant output workload; not a native-loopback reproduction or proof of the original failure cause. Final events without usable source-time binding are explicitly unattributed. A separate post-observation commit drains both variants before the connection-reuse probe; it cannot establish automatic endpoint recovery. No words, model or endpoint thresholds are changed.'};
const persist=()=>writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2)),pause=ms=>new Promise(r=>setTimeout(r,ms));await persist();
try{
 report.status='measuring';await persist();
 for(const repetition of [1,2])for(const phaseMs of [0,80])for(const commit of repetition===1?[false,true]:[true,false]){
  const trial={repetition,phaseMs,commit,startedAt:new Date().toISOString(),events:[]};report.trials.push(trial);await persist();
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const key=randomUUID(),service=spawn(executable,['serve','--host','127.0.0.1','--port',String(port),'--asr-model',model,'--backend',backend,'--no-ui','--asr.batching.enabled=false','--asr.batching.max_batch_size','2','--asr.batching.state_arena_slots','2','--asr.streaming.rnnt_right_context','1','--asr.endpointing.enable=true','--asr.endpointing.stop_history_eou_ms','510'],{cwd:path.dirname(executable),windowsHide:true,env:{...process.env,NEMO_SPEECH_HTTP_API_KEY:key},stdio:'ignore'});
  let launchError,socket,failure,opened=false;service.once('error',e=>launchError=String(e));trial.serviceProcessId=service.pid;
  const until=async(fn,budget=15000)=>{const end=Date.now()+budget;while(!fn()){assert(!failure,failure);assert(!launchError,launchError);assert.equal(service.exitCode,null,'Owned ASR service exited');assert(Date.now()<end,'ASR protocol deadline exceeded');await pause(20);}};
  try{
   const end=Date.now()+600000;for(;;){assert(!launchError);assert.equal(service.exitCode,null);assert(Date.now()<end,'ASR readiness timeout');try{const ready=await fetch('http://127.0.0.1:'+port+'/ready',{signal:AbortSignal.timeout(1000)}).then(r=>r.json());if(ready.ready&&ready.device===backend){trial.readyAt=new Date().toISOString();break;}}catch{}await pause(200);}
   socket=new WebSocket('ws://127.0.0.1:'+port+'/v1/audio/transcriptions/realtime',{headers:{Authorization:'Bearer '+key}});
   socket.on('open',()=>opened=true);socket.on('error',()=>failure='Local ASR socket error');socket.on('message',data=>{try{const event=JSON.parse(String(data));if(event.type==='error')failure='Local ASR protocol rejected input';trial.events.push({hostMs:Date.now(),...event});}catch{failure='Invalid ASR event';}});
   await until(()=>opened&&trial.events.some(e=>e.type==='session.created'));socket.send(JSON.stringify({type:'session.update',session:{sample_rate:16000,language:'en-US',automatic_punctuation:true,endpointing_ms:510}}));await until(()=>trial.events.some(e=>e.type==='session.updated'));
   const source=Buffer.concat([Buffer.alloc(phaseMs*16*2),audio]),start=Date.now(),commitFrame=(phaseMs*16+targetOffset+lastVoice+1+510*16);trial.inputPcmSha256=sha(source);let committed=false;
   for(let offset=0;offset<source.length;offset+=5120){assert(!failure,failure);const due=start+offset/32;while(Date.now()<due)await pause(Math.min(20,due-Date.now()));socket.send(source.subarray(offset,offset+5120));if(commit&&!committed&&(offset+5120)/2>=commitFrame){trial.commitSentAt=Date.now();socket.send(JSON.stringify({type:'input_audio_buffer.commit'}));committed=true;}}
   trial.targetSpeechEndHostMs=start+phaseMs+(targetOffset+lastVoice+1)/16;await pause(3000);
   trial.primaryWindowEndsAt=Date.now();trial.observationWindowAfterTargetMs=trial.primaryWindowEndsAt-trial.targetSpeechEndHostMs;
   trial.unattributedPrimaryFinals=trial.events.filter(e=>e.hostMs>=trial.targetSpeechEndHostMs&&e.type==='conversation.item.input_audio_transcription.completed').map(e=>({hostMs:e.hostMs,text:e.transcript??e.text??''}));
   trial.committedAcknowledgedInPrimaryWindow=commit?trial.events.some(e=>e.type==='input_audio_buffer.committed'&&e.hostMs>=trial.commitSentAt):null;
   trial.targetAttribution='Unverified: finals received after target speech can belong to earlier queued audio. No target WER or target recovery success imputed from these events.';
   // Outside the primary window, drain every prior input before probing reuse.
   // This additional commit is identical in both variants and cannot promote
   // a baseline endpointing result or borrow a late preceding transcript.
   trial.postObservationDrainCommitSentAt=Date.now();socket.send(JSON.stringify({type:'input_audio_buffer.commit'}));
   await until(()=>trial.events.filter(e=>e.type==='input_audio_buffer.committed').length>=(commit?2:1),90000);trial.drainAcknowledgedAt=Date.now();
   trial.drainedFinals=trial.events.filter(e=>e.type==='conversation.item.input_audio_transcription.completed').map(e=>({hostMs:e.hostMs,text:e.transcript??e.text??''}));
   const followStart=Date.now(),follow=inputs.at(-1).pcm;for(let offset=0;offset<follow.length;offset+=5120){socket.send(follow.subarray(offset,offset+5120));await pause(160);}socket.send(Buffer.alloc(16000*2));if(commit)socket.send(JSON.stringify({type:'input_audio_buffer.commit'}));await pause(3000);
   trial.followingTurnText=trial.events.filter(e=>e.hostMs>=followStart&&e.type==='conversation.item.input_audio_transcription.completed').map(e=>e.transcript??e.text??'').join(' ');trial.followingTurnWER=wordError(target.question,trial.followingTurnText);
  }catch(e){trial.failure=String(e);}
  finally{
   if(socket){socket.close();const deadline=Date.now()+2000;while(socket.readyState!==WebSocket.CLOSED&&Date.now()<deadline)await pause(20);if(socket.readyState!==WebSocket.CLOSED)socket.terminate();}
   if(service.exitCode===null&&service.signalCode===null){const exited=new Promise(resolve=>service.once('exit',resolve));assert(service.kill(),'Owned ASR service could not be stopped');await Promise.race([exited,pause(5000).then(()=>{throw Error('Owned ASR exit deadline exceeded; no next trial allowed');})]);}
   socket?.removeAllListeners('message');trial.eventCollectionClosedAt=Date.now();
   trial.serviceExitedAt=new Date().toISOString();trial.serviceExitCode=service.exitCode;trial.serviceExitSignal=service.signalCode;trial.completedAt=new Date().toISOString();
  }
  await persist();console.log(JSON.stringify({repetition,phaseMs,commit,following:trial.followingTurnText,ack:trial.committedAcknowledgedInPrimaryWindow,failure:trial.failure??null}));
 }
 report.status='complete_pending_review';report.trialFailures=report.trials.filter(t=>t.failure).length;
}catch(e){report.status='failed';report.failure=String(e);process.exitCode=1;}
finally{report.completedAt=new Date().toISOString();await persist();}
