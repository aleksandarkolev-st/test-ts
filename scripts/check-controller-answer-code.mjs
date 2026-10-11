// Explicit, post-capture execution of recorded code. No generated repair and
// no arbitrary shell evaluation. Compiler and execution failures are results.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [journalFile,specFile,outDir]=process.argv.slice(2);assert(journalFile&&specFile&&outDir,'JOURNAL SPECS OUTPUT');
const root=process.cwd(),output=path.resolve(outDir);assert(output.startsWith(root+path.sep));await mkdir(output,{recursive:true});
const bytes=await readFile(journalFile),journal=JSON.parse(bytes),spec=JSON.parse(await readFile(specFile));
assert.equal(journal.status,'complete','Do not run code checks concurrently with measured inference');
const sha=x=>createHash('sha256').update(x).digest('hex');assert.equal(spec.journalSha256,sha(bytes));
const run=(file,args,budget=20000)=>new Promise(resolve=>{
 const child=spawn(file,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
 child.stdout.on('data',x=>stdout=(stdout+x).slice(-12000));child.stderr.on('data',x=>stderr=(stderr+x).slice(-12000));
 const timer=setTimeout(()=>{timedOut=true;child.kill();},budget);
 child.once('error',error=>{clearTimeout(timer);resolve({error:String(error),stdout,stderr,timedOut});});
 child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut});});
});
const results=[];
for(const item of spec.checks){
 const row=journal.rows.find(r=>r.round===item.round);assert(row);
 const blocks=[...row.answer.matchAll(/```(?:cpp|c\+\+|cuda|c)?\s*\n([\s\S]*?)```/g)].map(m=>m[1]);
 const code=blocks[item.block??0];const result={round:item.round,answerSha256:sha(row.answer),kind:item.kind,scope:item.scope};results.push(result);
 if(code==null){result.failure='No complete code fence';continue;}
 result.codeSha256=sha(code);
 let source=code;
 if(item.kind==='foo-exact'){
  result.exactOriginal=code==='int Foo(int x) { return x < -1 ? 17 : 19; }\n';
  source='#include <cassert>\n'+code+'\nint main(){ for(int x=-1000;x<=1000;x++) assert(Foo(x)==(x < -1 ? 17 : 19)); }\n';
 }else if(item.kind==='cuda-sum19'){
  assert(/^[A-Za-z_][A-Za-z_0-9]*$/.test(item.function),'Specify the recorded entry point without editing it');
  // Substitute only the PTX lane-id read with the harness's physical lane.
  // This is an environment adaptation, not a repair of the recorded algorithm.
  const laneRead=/asm\s+volatile\s*\(\s*"mov\.u32 %0, %%laneid;"\s*:\s*"=r"\s*\(\s*([A-Za-z_][A-Za-z_0-9]*)\s*\)\s*\)\s*;/g;
  const adapted=code.replace(laneRead,(_,variable)=>`${variable} = threadIdx.x;`);
  result.environmentAdaptations={cudaHeader:'test-only CPU intrinsic shim',ptxLaneReadsReplaced:[...code.matchAll(laneRead)].length,
   algorithmRepaired:false,adaptedCodeSha256:sha(adapted)};
  source=`#include <iostream>\n#include ${JSON.stringify(path.resolve('tests/fixtures/cuda-collective-harness.hpp').replaceAll('\\','/'))}\n${adapted}\nint main(){try{check_sum19(${item.function});}catch(const std::exception& error){std::cerr<<error.what();return 2;}}\n`;
 }else assert.equal(item.kind,'cpp-self-test','Unknown execution contract');
 const sourceFile=path.join(output,`round-${item.round}.cpp`),exe=path.join(output,`round-${item.round}.exe`);await writeFile(sourceFile,source);
 result.compile=await run(spec.compiler??'clang++',['-std=c++17','-O0','-fno-fast-math','-I',path.resolve('tests/fixtures'),sourceFile,'-o',exe]);
 if(result.compile.code===0)result.execution=await run(exe,[],10000);
 result.pass=result.compile.code===0&&result.execution?.code===0&&!result.execution.timedOut&&(item.kind!=='foo-exact'||result.exactOriginal);
}
await writeFile(path.join(output,'results.json'),JSON.stringify({journalFile,journalSha256:sha(bytes),compiler:spec.compiler??'clang++',results,
 scope:'CPU compilation/execution of recorded algorithm plus explicit test harness. CUDA header/intrinsics and PTX lane-id read are adapted to the documented CPU environment; algorithm is not repaired. This does not certify NVIDIA hardware, nvcc or a proof for arbitrary inputs.'},null,2));
console.log(JSON.stringify(results.map(r=>({round:r.round,pass:r.pass??false,failure:r.pass?null:r.failure??r.compile?.error??r.compile?.stderr??null}))));
