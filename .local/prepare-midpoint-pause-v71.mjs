import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {exactPauseWave} from '../scripts/lib/exact-pause-wave.mjs';
import {waveformEvidence} from '../scripts/lib/deep-delivery.mjs';
const [suiteFile='tests/fixtures/hard-interview-audio-suite.json',caseName='long-question-essential-tail',directory='artifacts/deep-interview-v71/midpoint-pause-preparation']=process.argv.slice(2);
await mkdir(directory,{recursive:true});
try{await readFile(path.join(directory,'preparation.json'));throw Error('Refusing to overwrite completed preparation');}catch(error){if(error.code!=='ENOENT')throw error;}
const suiteBytes=await readFile(suiteFile);
const sourceCase=JSON.parse(suiteBytes).cases.find(item=>item.name===caseName);assert(sourceCase,'Requested public test case not found');
const question=sourceCase.scenario.seed;assert.equal(typeof question,'string');
const splitCandidates=[...question.matchAll(/\S+/g)].map(match=>match.index).filter(index=>index>0)
 .sort((a,b)=>Math.abs(a-question.length/2)-Math.abs(b-question.length/2)).slice(0,3).sort((a,b)=>a-b);
assert(splitCandidates.length,'Question has no internal word boundary');
const candidates=[];
for(const [index,split] of splitCandidates.entries()){
 const marker=question.slice(split);assert.equal(question.indexOf(marker),split);
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
const scenario={...sourceCase.scenario,name:sourceCase.scenario.name+'-midpoint-pause',
 evaluationDelivery:{...sourceCase.delivery,initialPauseBeforeText:selected.marker,exactDigitalPause:true,immediateAfterRounds:{}}};
await writeFile(path.join(directory,'scenario.json'),JSON.stringify({scenario,requirementIds:sourceCase.requirementIds,sourceFixtureSha256:createHash('sha256').update(suiteBytes).digest('hex')},null,2),{flag:'wx'});
const report={recordedAt:new Date().toISOString(),question,selected,candidates,
 sourceFixture:{file:suiteFile,caseName,sha256:createHash('sha256').update(suiteBytes).digest('hex')},
 sourceFixtureSha256:createHash('sha256').update(suiteBytes).digest('hex'),collectorSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),playbackPending:true,
 scope:'Offline audio preparation from the unchanged caller-selected public question. Up to three word boundaries nearest its character midpoint are derived without question-specific markers; synthesis measures each and selects the closest to half of the voiced PCM span. An exact 1500 ms digital gap is inserted without modifying voiced samples. No model inference, microphone or playback occurred. The eventual native recording regenerates the selected split and must be measured again; this preparation is not runtime evidence or an answer grade.'};
await writeFile(path.join(directory,'preparation.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(report));
