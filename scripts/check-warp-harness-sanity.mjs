// PREPARED ONLY. Never run this fixture compiler during measured captures.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const label=process.argv[2];assert(/^r\d+$/.test(label),'Unique rN attempt label required');
const sha=x=>createHash('sha256').update(x).digest('hex'),captures=[];
for(const file of ['artifacts/controller-v73/reliability-live-r1/verification.json','artifacts/controller-v73/reliability-controls-r1/verification.json']){
 const b=await readFile(file);assert.equal(JSON.parse(b).status,'complete_pending_manual_review','Both measured queues must stop before any fixture compilation');captures.push({file,sha256:sha(b)});
}
const probe="$ErrorActionPreference='Stop'; $ownedMatches=@(Get-CimInstance Win32_Process -Filter \"Name = 'wavesSvc64.exe' OR Name = 'nemo-speech.exe'\" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\controller-',[System.StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\nemotron\\',[System.StringComparison]::OrdinalIgnoreCase)) } | Select-Object ProcessId,Name); ConvertTo-Json -InputObject $ownedMatches -Compress; exit 0";
assert.equal(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',probe],{windowsHide:true,encoding:'utf8'}).trim(),'[]','Owned measured native/ASR still active');
const out='artifacts/controller-v73/warp-harness-sanity-'+label;await mkdir(out);
const header=await readFile('scripts/fixtures/cuda-warp-contract-harness-v73.hpp'),source=await readFile('scripts/fixtures/cuda-warp-contract-harness-sanity-v73.cpp');
const hf=path.join(out,'cuda-warp-contract-harness-v73.hpp'),sf=path.join(out,'fixture.cpp'),exe=path.resolve(out,'fixture.exe');
await writeFile(hf,header,{flag:'wx'});await writeFile(sf,source,{flag:'wx'});
const report={status:'verifying',startedAt:new Date().toISOString(),captures,checkerSha256:sha(await readFile(new URL(import.meta.url))),headerSha256:sha(header),fixtureSha256:sha(source),scope:'Evaluator fixture sanity only, no model generation or production dependency. Full32/high-bit ballot, changing/subset membership, source/count checks and explicit invalid-contract rejection. CPU simulation only, not GPU scheduling, hardware barriers or FTZ certification.'};
const persist=()=>writeFile(out+'/results.json',JSON.stringify(report,null,2)+'\n');await persist();
const run=(file,args,budget)=>new Promise(resolve=>{
 const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
 child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const timer=setTimeout(()=>{timedOut=true;child.kill();},budget);
 child.once('error',e=>{clearTimeout(timer);resolve({error:String(e),stdout,stderr,timedOut});});
 child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut});});
});
report.compile=await run('clang++',['-std=c++17','-O0','-fno-fast-math',path.resolve(sf),'-o',exe],20000);await persist();
if(report.compile.code===0&&!report.compile.timedOut){report.execution=await run(exe,[],15000);await persist();}
report.infrastructureFailure=report.compile.error??report.execution?.error??null;
report.pass=!report.infrastructureFailure&&report.compile.code===0&&!report.compile.timedOut&&report.execution?.code===0&&!report.execution.timedOut;
report.status=report.infrastructureFailure?'failed_infrastructure':report.pass?'complete_pending_manual_review':'fixture_failed';report.completedAt=new Date().toISOString();await persist();
if(!report.pass)process.exitCode=1;console.log(JSON.stringify({out,status:report.status,pass:report.pass,infrastructureFailure:report.infrastructureFailure}));
