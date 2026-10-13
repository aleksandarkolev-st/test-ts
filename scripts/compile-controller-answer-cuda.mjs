import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fencedSources} from './lib/fenced-sources.mjs';
const [journalFile,toolchainFile,directory,selectionFile]=process.argv.slice(2);
assert(journalFile&&toolchainFile&&directory,'JOURNAL TOOLCHAIN_MANIFEST OUTPUT_DIRECTORY');
const root=process.cwd(),out=path.resolve(directory);assert(out.startsWith(root+path.sep));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const journalBytes=await readFile(journalFile),journal=JSON.parse(journalBytes),toolchainBytes=await readFile(toolchainFile),toolchain=JSON.parse(toolchainBytes);
assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
let sourceSelection=null,selectedRows=journal.rows;
if(selectionFile){
 const bytes=await readFile(selectionFile),selection=JSON.parse(bytes);
 assert.equal(selection.journalSha256,hash(journalBytes));assert(Array.isArray(selection.rows)&&selection.rows.length);
 assert.equal(new Set(selection.rows.map(r=>r.round)).size,selection.rows.length);
 selectedRows=selection.rows.map(selected=>{const row=journal.rows.find(r=>r.round===selected.round);assert(row);assert.equal(hash(row.answer),selected.answerSha256);return row;});
 sourceSelection={file:selectionFile,sha256:hash(bytes),rows:selection.rows,scope:selection.scope};
}
const nvccSha256=hash(await readFile(toolchain.nvcc));
assert.equal(nvccSha256,toolchain.files.find(file=>path.resolve(file.file)===path.resolve(toolchain.nvcc)).sha256);
assert.equal(hash(await readFile(toolchain.hostCompiler)),toolchain.hostCompilerSha256);
try{
 const previous=JSON.parse(await readFile(path.join(out,'compilation.json')));
 assert.equal(previous.journal.sha256,hash(journalBytes));assert.equal(previous.toolchain.sha256,hash(toolchainBytes));
 assert.equal(previous.sourceSelection?.sha256??null,sourceSelection?.sha256??null);
 for(const block of previous.blocks){assert.equal(hash(await readFile(block.code.file)),block.code.sha256);for(const log of [block.stdout,block.stderr])assert.equal(hash(await readFile(log.file)),log.sha256);}
 console.log(JSON.stringify({cached:true,file:path.join(out,'compilation.json'),summary:previous.summary}));process.exit(0);
}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(path.dirname(out),{recursive:true});await mkdir(out);
const includes=toolchain.components.map(component=>path.join(component.root,'include'));
const blocks=[],run=(args,cwd)=>new Promise((resolve,reject)=>{
 const child=spawn(toolchain.nvcc,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false,stdoutBytes=0,stderrBytes=0;
 const timer=setTimeout(()=>{timedOut=true;child.kill();},120000);
 child.stdout.on('data',chunk=>{stdoutBytes+=chunk.length;stdout=(stdout+chunk).slice(-64000);});child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;stderr=(stderr+chunk).slice(-64000);});
 child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',exitCode=>{clearTimeout(timer);resolve({exitCode,timedOut,stdout,stderr,stdoutBytes,stderrBytes});});
});
for(const row of selectedRows)for(const [index,block] of fencedSources(row.answer??'').entries()){
 if(!/^(?:cuda|cpp|c\+\+)$/iu.test(block.languageAnnotation))continue;
 const caseDirectory=path.join(out,`round-${row.round}-block-${index}`);await mkdir(caseDirectory);
 const source=path.join(caseDirectory,'recorded.cu'),object=path.join(caseDirectory,'recorded.obj');await writeFile(source,block.text,{flag:'wx'});
 const command=['--device-c','--std=c++17','-arch=sm_70','--cudart=none','-ccbin',path.dirname(toolchain.hostCompiler),...includes.flatMap(include=>['-I',include]),'-Xcompiler','/utf-8','recorded.cu','-o','recorded.obj'];
 const startedAt=new Date().toISOString(),result=await run(command,caseDirectory);
 const stdoutFile=path.join(caseDirectory,'stdout.log'),stderrFile=path.join(caseDirectory,'stderr.log');
 await writeFile(stdoutFile,result.stdout,{flag:'wx'});await writeFile(stderrFile,result.stderr,{flag:'wx'});
 let objectEvidence=null;if(result.exitCode===0)objectEvidence={file:path.relative(root,object),sha256:hash(await readFile(object))};
 blocks.push({round:row.round,block:index,question:row.question,recognizedQuestion:row.recognizedQuestion,responseVersion:row.responseVersion,
  answerSha256:hash(row.answer),phase:row.phase,error:row.error??null,cancelled:row.cancelled??false,
  code:{file:path.relative(root,source),sha256:hash(block.text),languageAnnotation:block.languageAnnotation},
  startedAt,completedAt:new Date().toISOString(),command,workingDirectory:path.relative(root,caseDirectory),exitCode:result.exitCode,timedOut:result.timedOut,object:objectEvidence,
  diagnosticOutputBytes:{stdout:result.stdoutBytes,stderr:result.stderrBytes},
  diagnosticOutputTruncated:{stdout:result.stdoutBytes>Buffer.byteLength(result.stdout),stderr:result.stderrBytes>Buffer.byteLength(result.stderr)},
  stdout:{file:path.relative(root,stdoutFile),sha256:hash(result.stdout)},stderr:{file:path.relative(root,stderrFile),sha256:hash(result.stderr)}});
}
const report={recordedAt:new Date().toISOString(),journal:{file:journalFile,sha256:hash(journalBytes)},
 sourceSelection,
 toolchain:{file:toolchainFile,sha256:hash(toolchainBytes),nvccSha256,hostCompilerSha256:toolchain.hostCompilerSha256},
 collectorSourceHashes:{'scripts/compile-controller-answer-cuda.mjs':hash(await readFile(new URL(import.meta.url))),'scripts/lib/fenced-sources.mjs':hash(await readFile('scripts/lib/fenced-sources.mjs'))},
 blocks,summary:{recordedCudaOrCppBlocks:blocks.length,compiled:blocks.filter(block=>block.exitCode===0).length,
  failed:blocks.filter(block=>block.exitCode!==0).length,timedOut:blocks.filter(block=>block.timedOut).length},
 hardwareExecutionPerformed:false,goalComplete:false,
 scope:'Unchanged CUDA/C++-annotated fenced bodies compiled as individual C++17 translation units with real pinned NVIDIA nvcc and MSVC, using relocatable device compilation for sm_70. No missing includes, launch wrappers or answer repairs are added. Compilation failures remain recorded, including snippets not intended as standalone units and dependency or requested-standard mismatches. Compiler acceptance does not prove numerical or collective correctness, hardware behavior, or full-interview accuracy.'};
await writeFile(path.join(out,'compilation.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:path.join(out,'compilation.json'),summary:report.summary}));
