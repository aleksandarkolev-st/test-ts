// Extra generations have their own manual review and immutable source binding.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const [journalFile,specFile,out]=process.argv.slice(2);assert(journalFile&&specFile&&out);
const sha=x=>createHash('sha256').update(x).digest('hex');
for(const f of ['artifacts/controller-v73/reliability-live-r1/verification.json','artifacts/controller-v73/reliability-controls-r1/verification.json'])assert.equal(JSON.parse(await readFile(f)).status,'complete_pending_manual_review');
const probe="$ErrorActionPreference='Stop'; $ownedMatches=@(Get-CimInstance Win32_Process -Filter \"Name = 'WmiPrvSE.exe' OR Name = 'nemo-speech.exe'\" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\controller-',[System.StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\nemotron\\',[System.StringComparison]::OrdinalIgnoreCase)) } | Select-Object ProcessId,Name); ConvertTo-Json -InputObject $ownedMatches -Compress; exit 0";
assert.equal(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',probe],{windowsHide:true,encoding:'utf8'}).trim(),'[]');
const jb=await readFile(journalFile),j=JSON.parse(jb),sb=await readFile(specFile),s=JSON.parse(sb);
assert.equal(sha(jb),s.journalSha256);assert(j.status==='complete'&&j.stoppedCleanly);
const ab=await readFile(s.generationAuditFile),audit=JSON.parse(ab);assert.equal(sha(ab),s.generationAuditSha256);assert(audit.completedCapture);
await mkdir(out);
const rows=s.checks.map(c=>{
 const e=audit.extras.find(e=>e.question.id===c.generationId);assert(e);assert(e.sourceRounds.includes(c.round));
 assert.equal(sha(e.answer),e.answerSha256);assert.equal(e.review.answerSha256,e.answerSha256);
 assert(e.review.note&&e.answer&&/```(?:cpp|cuda)\r?\n/.test(e.answer),'Actual visible code requires a separate existing manual review');
 return {round:c.round,question:e.question.text,recognizedQuestion:e.question.text,answer:e.answer,phase:e.phase,error:e.error,responseVersion:e.question.id+':0',cancelled:e.cancelled??true};
});
assert.equal(new Set(rows.map(r=>r.round)).size,rows.length);
const derivedFile=path.join(out,'additional-generations-journal.json'),derivedBytes=Buffer.from(JSON.stringify({...j,rows},null,2)+'\n');
await writeFile(derivedFile,derivedBytes,{flag:'wx'});
const selectionFile=path.join(out,'additional-generations-selection.json');
await writeFile(selectionFile,JSON.stringify({journalSha256:sha(derivedBytes),rows:rows.map(r=>({round:r.round,answerSha256:sha(r.answer)})),scope:'Nonselected generations from separately manually reviewed all-generation audit. Complete capture status does not imply these individual jobs completed requested work; source bodies/phase/error unchanged.'},null,2)+'\n',{flag:'wx'});
let stdout='',stderr='';
const code=await new Promise(resolve=>{const p=spawn(process.execPath,['scripts/compile-controller-answer-cuda.mjs',derivedFile,s.toolchainFile,path.join(out,'nvcc'),selectionFile],{windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.once('error',e=>{stderr+=String(e);resolve(-1);});p.once('exit',resolve);});
await writeFile(path.join(out,'checker.log'),stdout+stderr,{flag:'wx'});
const report={journal:{file:journalFile,sha256:sha(jb)},spec:{file:specFile,sha256:sha(sb)},generationAudit:{file:s.generationAuditFile,sha256:sha(ab)},checkerSha256:sha(await readFile(new URL(import.meta.url))),derivedJournal:{file:derivedFile,sha256:sha(derivedBytes)},childExitCode:code,scope:'Unchanged separately reviewed additional model code compiled with pinned NVCC/MSVC. No source repair, chosen-answer substitution, whole-wave completion credit or NVIDIA hardware execution; host-ordering proof failures remain even if compiler accepts.'};
if(code===0){const rb=await readFile(path.join(out,'nvcc','compilation.json')),r=JSON.parse(rb);report.compilationSha256=sha(rb);report.summary=r.summary;report.results=r.blocks.map(b=>({round:b.round,generationId:rows.find(r=>r.round===b.round).responseVersion.split(':')[0],codeSha256:b.code.sha256,pass:b.exitCode===0&&!b.timedOut,scope:'Compiler acceptance only, not whole-program ordering correctness.'}));}
else{report.infrastructureFailure=stderr;process.exitCode=1;}
await writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,code,summary:report.summary}));
