import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {exactPauseWave} from '../scripts/lib/exact-pause-wave.mjs';
import {waveformEvidence} from '../scripts/lib/deep-delivery.mjs';
const directory='artifacts/deep-interview-v70/midpoint-pause-preparation';
await mkdir(directory,{recursive:true});
try{await readFile(path.join(directory,'preparation.json'));throw Error('Refusing to overwrite completed preparation');}catch(error){if(error.code!=='ENOENT')throw error;}
const suiteBytes=await readFile('tests/fixtures/hard-interview-audio-suite.json');
const sourceCase=JSON.parse(suiteBytes).cases.find(item=>item.name==='long-question-essential-tail');
const question=sourceCase.scenario.seed;
const candidates=[];
for(const [index,marker] of ['Explain how you would','you would validate','validate an implementation'].entries()){
 const split=question.indexOf(marker);assert(split>0);
 const waves=[];
 for(const [part,text] of [question.slice(0,split),question.slice(split)].entries()){
  const base=path.resolve(directory,`candidate-${index+1}-part-${part+1}`);
  try{assert.equal(await readFile(base+'.txt','utf8'),text,'Partial preparation has different source text');}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(base+'.txt',text,{flag:'wx'});}
  await new Promise((resolve,reject)=>{
   const child=spawn('powershell.exe',['-NoProfile','-File',path.resolve('scripts/synthesize-interview-question.ps1'),'-TextPath',base+'.txt','-OutputPath',base+'.wav'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';
   child.stderr.on('data',chunk=>error=(error+chunk).slice(-1000));child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Synthesis failed ${code}: ${error}`)));
  });waves.push(await readFile(base+'.wav'));
 }
 const exact=exactPauseWave(...waves,1500),pause={split,...exact.evidence};
 const evidence=waveformEvidence(exact.wave,pause,sourceCase.delivery);
 const prefixMs=(pause.pauseStartFrame-evidence.firstNonzeroFrame)/16;
 const tailMs=(evidence.lastNonzeroFrame+1-pause.pauseEndFrame)/16;
 const fraction=prefixMs/(prefixMs+tailMs);
 const file=`candidate-${index+1}.wav`;await writeFile(path.join(directory,file),exact.wave,{flag:'wx'});
 candidates.push({marker,split,file,waveSha256:createHash('sha256').update(exact.wave).digest('hex'),prefixMs,tailMs,prefixFraction:fraction,distanceFromHalf:Math.abs(fraction-.5),evidence});
}
candidates.sort((a,b)=>a.distanceFromHalf-b.distanceFromHalf);const selected=candidates[0];
const scenario={...sourceCase.scenario,name:'long-question-essential-tail-midpoint-pause',
 evaluationDelivery:{...sourceCase.delivery,initialPauseBeforeText:selected.marker,exactDigitalPause:true,immediateAfterRounds:{}}};
await writeFile(path.join(directory,'scenario.json'),JSON.stringify({scenario,requirementIds:sourceCase.requirementIds,sourceFixtureSha256:createHash('sha256').update(suiteBytes).digest('hex')},null,2),{flag:'wx'});
const report={recordedAt:new Date().toISOString(),question,selected,candidates,
 sourceFixtureSha256:createHash('sha256').update(suiteBytes).digest('hex'),playbackPending:true,
 scope:'Offline audio preparation from the unchanged public question. Three word-boundary splits are measured; the closest to half of the voiced PCM span is selected. An exact 1500 ms digital gap is inserted without modifying voiced samples. No model inference, microphone or playback occurred. The eventual native recording regenerates the selected split and must be measured again; this preparation is not runtime evidence or an answer grade.'};
await writeFile(path.join(directory,'preparation.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(report));
