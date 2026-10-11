import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/algorithms-hour-t';
const journal=JSON.parse(await readFile(`${directory}/interview.json`));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const target='scripts/lib/deep-audio-interview.mjs';
let older=await readFile(target,'utf8');
const replace=(from,to)=>{if(!older.includes(from))throw Error('Cannot reconstruct exact starting evaluation harness');older=older.replace(from,to);};
replace("import {explicitContextProbe,questionPause,waveformEvidence} from './deep-delivery.mjs';\n",'');
replace(' const delivery=scenario.evaluationDelivery??{};\n','');
replace(' result.deliveryPlan.caseOverrides=delivery;\n','');
replace("  let pause={split:0,pauseMs:0,kind:'recorded_waveform_replay'};\n",'');
replace("   const round=Number(label.match(/\\d+/)?.[0]);\n   pause=questionPause(question,round,delivery,[4,8].includes(deepDeliveryRound(round)));",
 "   const pause=[4,8].includes(deepDeliveryRound(Number(label.match(/\\d+/)?.[0])));\n   const split=pause?question.indexOf(' ',Math.floor(question.length*.55)):0;");
replace("   if(pause.split>0)args.push('-PauseAfterCharacters',String(pause.split),'-PauseMs',String(pause.pauseMs));",
 "   if(split>0)args.push('-PauseAfterCharacters',String(split),'-PauseMs','1500');");
replace("  const bytes=await readFile(waveFile);\n  return {waveFile:path.basename(waveFile),sha256:hash(bytes),waveformEvidence:waveformEvidence(bytes,pause,\n   Number(label.match(/\\d+/)?.[0])===1?delivery:{})};",
 "  return {waveFile:path.basename(waveFile),sha256:hash(await readFile(waveFile))};");
replace('   const probe=!trial&&continueInterview(budget,round+1,performance.now()-sessionClock)?\n    explicitContextProbe(delivery,round+1,immediateContextProbe(round+1)):null;',
 '   const probe=!trial&&continueInterview(budget,round+1,performance.now()-sessionClock)?immediateContextProbe(round+1):null;');
if(hash(Buffer.from(older))!==journal.diagnosticSourceHashes[target])throw Error('Reconstructed bytes do not match the starting recorded SHA-256');
const files={...journal.sourceHashes,...journal.intentSourceHashes,...journal.diagnosticSourceHashes};
const saved=[];
for(const [file,expected] of Object.entries(files)){
 const bytes=file===target?Buffer.from(older):await readFile(file);
 if(hash(bytes)!==expected)throw Error(`Source differs from actual run start: ${file}`);
 const destination=path.join(directory,'source-snapshot',file);await mkdir(path.dirname(destination),{recursive:true});
 await writeFile(destination,bytes,{flag:'wx'});saved.push({file,sha256:expected,reconstructed:file===target});
}
for(const file of ['scripts/lib/deep-observations.mjs','scripts/lib/interview-duration.mjs','scripts/lib/streamed-word-latency.mjs','scripts/sample-interview-process.ps1']){
 const bytes=await readFile(file),destination=path.join(directory,'source-snapshot',file);
 await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes,{flag:'wx'});
 saved.push({file,sha256:hash(bytes),notInStartingManifest:true,scope:'Unchanged auxiliary dependency, captured during live run; initial manifest did not hash this file.'});
}
await writeFile(`${directory}/source-snapshot-manifest.json`,JSON.stringify({recordedAt:new Date().toISOString(),saved,
 scope:'Starting recorded source hashes verified byte-for-byte. The evaluation harness before later exact-probe support was reconstructed and accepted only after matching its recorded starting hash. New exact-probe delivery changes do not apply to this live hour.'},null,2),{flag:'wx'});
console.log(JSON.stringify({frozenFiles:saved.length,reconstructedHashVerified:true}));
