import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const base='artifacts/deep-interview-v70/hard-probes/histogram-late-reversal-exact-pause';
const bytes=await readFile(`${base}/interview.json`),j=JSON.parse(bytes),r=j.rows[0];
assert(j.status==='complete'&&j.stoppedCleanly&&r.phase==='complete'&&!r.cancelled&&!r.error);
const hash=b=>createHash('sha256').update(b).digest('hex');
const code=r.answer.match(/```cpp\s*\n([\s\S]*?)```/u)?.[1];assert(code);
await mkdir(`${base}/code-review`,{recursive:true});
const file=`${base}/code-review/original.cu`;
try{assert.equal(await readFile(file,'utf8'),code);}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(file,code,{flag:'wx'});}
if(process.argv.includes('--export-only')){console.log(JSON.stringify({sourceSha256:hash(code),compilationPending:true}));process.exit(0);}
const completion=JSON.parse(await readFile('artifacts/deep-interview-v70/chatgpt-backend-comparison-no-tier/complete.json'));
assert.equal(completion.status,'complete','Finish the measured comparison before compilation');
const start=performance.now();
const result=await new Promise((resolve,reject)=>{
 const child=spawn('cmd.exe',['/d','/c','.local\\compile-exact-histogram-v70.cmd'],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 child.once('error',reject);child.once('exit',exitCode=>resolve({exitCode,stdout,stderr}));
});
await writeFile(`${base}/code-review/compile-output.json`,JSON.stringify(result,null,2),{flag:'wx'});
let executable=null;if(result.exitCode===0){const b=await readFile(`${base}/code-review/histogram.exe`);assert.equal(b.subarray(0,2).toString(),'MZ');executable={file:`${base}/code-review/histogram.exe`,sha256:hash(b)};}
const report={recordedAt:new Date().toISOString(),journal:{file:`${base}/interview.json`,sha256:hash(bytes)},round:r.round,
 questionSha256:hash(r.question),answerSha256:hash(r.answer),source:{file,sha256:hash(await readFile(file))},executable,
 originalSourcePatched:false,compilation:{passed:result.exitCode===0,exitCode:result.exitCode,elapsedMs:performance.now()-start,
 commandFile:'.local/compile-exact-histogram-v70.cmd',commandSha256:hash(await readFile('.local/compile-exact-histogram-v70.cmd')),target:'sm_70',standard:'c++17',optimization:'O2',unsupportedCompilerOverride:false,
 compilerBanner:result.stdout},
 manualOwnershipReview:{partialWriter:'One worker exclusively owns one row and processes input indices congruent to its worker index modulo WORKERS.',
 finalWriter:'Each reduction bin has one owner; the ordered kernels make all private rows available first.',
 skew:'Repeated keys remain within private rows, so skew introduces no shared-write contention.',
 counts:'Every intermediate count is nonnegative and bounded by N; the supplied 64-bit counter supports the stated representable N. The input-index increment guards overflow, and the supplied host bin allocation bound limits reduction index growth.',
 scope:'Manual source reasoning, separate from compilation and model verdict. The CLI demonstration requires input and scratch storage to fit memory and discloses chunking for larger input.'},
 scope:'Untouched source from the exact-1500ms-pause response, separate from the previously compiled different histogram listing. Compilation and linkage are recorded; no NVIDIA hardware execution, GPU performance measurement or full input-parser certificate is claimed.'};
await writeFile('docs/evidence/exact-pause-histogram-compile-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({passed:report.compilation.passed,exitCode:result.exitCode,sourceSha256:report.source.sha256,hardwareExecution:false}));
if(result.exitCode!==0)process.exitCode=1;
