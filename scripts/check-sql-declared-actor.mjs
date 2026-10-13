// External evaluator for a recorded SQL answer which explicitly instructs
// actor substitution. The substitution is disclosed, never production logic.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const [journalFile,specFile,out]=process.argv.slice(2);
assert(journalFile&&specFile&&out);
const sha=x=>createHash('sha256').update(x).digest('hex');
for(const file of ['artifacts/controller-v73/reliability-live-r1/verification.json','artifacts/controller-v73/reliability-controls-r1/verification.json'])assert.equal(JSON.parse(await readFile(file)).status,'complete_pending_manual_review','No database/grader execution during either measured queue');
const probe="$ErrorActionPreference='Stop'; $ownedMatches=@(Get-CimInstance Win32_Process -Filter \"Name = 'meeting-copilot.exe' OR Name = 'nemo-speech.exe'\" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\controller-',[System.StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith('C:\\Users\\polek\\Downloads\\test-ts\\.local\\nemotron\\',[System.StringComparison]::OrdinalIgnoreCase)) } | Select-Object ProcessId,Name); ConvertTo-Json -InputObject $ownedMatches -Compress; exit 0";
assert.equal(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',probe],{windowsHide:true,encoding:'utf8'}).trim(),'[]');
const jb=await readFile(journalFile),j=JSON.parse(jb),sb=await readFile(specFile),spec=JSON.parse(sb);
assert.equal(sha(jb),spec.journalSha256);assert(j.status==='complete'&&j.stoppedCleanly);
await mkdir(out);
const adaptations=[],checks=[];
for(const c of spec.checks){
 const r=j.rows.find(r=>r.round===c.round);assert(r);assert.equal(sha(r.answer),c.answerSha256);
 assert(r.answer.includes(c.explicitInstruction),'Only execute substitutions actually instructed by the answer');
 assert(/^[A-Za-z_]\w*$/.test(c.actorFrom)&&/^[A-Za-z_]\w*$/.test(c.actorTo)&&c.actorFrom!==c.actorTo);
 const blocks=[...r.answer.matchAll(/```sql\r?\n([\s\S]*?)```/gi)];
 assert.equal(blocks.length,2,'Only independently reviewed two-fence setup/parameterized-transaction layout');
 const transaction=blocks[c.transactionBlock??1][1],from="'"+c.actorFrom+"'",to="'"+c.actorTo+"'";
 assert.equal(transaction.split(from).length-1,1,'Unique actor literal required; do not alter algorithmic statements');
 const derived=transaction.replace(from,to);
 adaptations.push({round:c.round,originalAnswerSha256:c.answerSha256,originalTransactionSha256:sha(transaction),declaredActorTransactionSha256:sha(derived),explicitInstruction:c.explicitInstruction,actorFrom:c.actorFrom,actorTo:c.actorTo,scope:'Source-author explicitly requested actor substitution only. Original setup and first transaction unchanged; one actor string literal changed for the second participant. This is a disclosed parameter instantiation, not verbatim two-transaction emission or an algorithm repair.'});
 r.answer+='\n```sql\n'+derived+'```\n';
 checks.push({round:c.round,setupBlock:0,aliceBlock:1,bobBlock:2,table:c.table,onCallColumn:c.onCallColumn});
}
const derivedFile=path.join(out,'declared-actor-journal.json'),derivedBytes=Buffer.from(JSON.stringify(j,null,2)+'\n');
await writeFile(derivedFile,derivedBytes,{flag:'wx'});
const derivedSpec=path.join(out,'declared-actor-spec.json');
await writeFile(derivedSpec,JSON.stringify({journalSha256:sha(derivedBytes),port:spec.port??55484,checks},null,2)+'\n',{flag:'wx'});
let stdout='',stderr='';
const code=await new Promise(resolve=>{const p=spawn(process.execPath,['scripts/check-controller-answer-sql.mjs',derivedFile,derivedSpec,path.join(out,'postgres-checks')],{windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.once('error',e=>{stderr+=String(e);resolve(-1);});p.once('exit',resolve);});
await writeFile(path.join(out,'checker.log'),stdout+stderr,{flag:'wx'});
const report={journal:{file:journalFile,sha256:sha(jb)},spec:{file:specFile,sha256:sha(sb)},checkerSha256:sha(await readFile(new URL(import.meta.url))),adaptations,derivedJournal:{file:derivedFile,sha256:sha(derivedBytes)},childExitCode:code,scope:'Actual recorded SQL plus its explicitly instructed actor parameter, all changes disclosed. No generated source repair or production dependency. Controlled overlap/retry execution cannot replace universal invariant review.'};
if(code===0){const rb=await readFile(path.join(out,'postgres-checks','results.json'));report.childResultsSha256=sha(rb);report.results=JSON.parse(rb).results;}
else{report.infrastructureFailure=stderr;process.exitCode=1;}
await writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,code,results:report.results?.map(r=>({round:r.round,pass:r.pass}))}));
