import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {extractRecordedRow} from './lib/recorded-row.mjs';
import {fencedSources} from '../scripts/lib/fenced-sources.mjs';
const [file,roundText,directory,selectionFile]=process.argv.slice(2),round=Number(roundText);
assert(file&&directory&&Number.isSafeInteger(round)&&round>0,'JOURNAL ROUND OUTPUT_DIRECTORY');
const root=process.cwd(),out=path.resolve(directory);assert(out.startsWith(root+path.sep));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// This explicit selection evaluates the graph-walk contract, not arbitrary code.
// It adds no keyword, answer, or case routing to the application.
const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);
const journalSha256=digest.digest('hex'),{row,text}=await extractRecordedRow(file,round);
const completedBytes=await readFile(file);assert.equal(hash(completedBytes),journalSha256,'Journal changed while checking its completion');
const completed=JSON.parse(completedBytes);assert.equal(completed.status,'complete');assert(completed.stoppedCleanly);
assert.deepEqual(row,completed.rows.find(candidate=>candidate.round===round),'Bounded extraction must match the actual recorded row');
if(selectionFile){
 const selections=JSON.parse(await readFile(selectionFile)),selected=selections.checks.find(item=>path.resolve(item.file)===path.resolve(file)&&item.round===round);
 assert(selected,'Code check selection must bind this source and row');
 assert.equal(selected.journalSha256,journalSha256);assert.equal(selected.rowSha256,hash(text));
 assert.equal(selected.questionSha256,hash(row.question));assert.equal(selected.answerSha256,hash(row.answer));
}
assert(!row.error&&!row.cancelled&&row.phase==='complete','Selected retained code must be complete and error-free');
const blocks=fencedSources(row.answer??'').filter(block=>/^python(?:3)?$/iu.test(block.languageAnnotation));
assert.equal(blocks.length,1,'Explicitly selected answer must contain one complete Python body');
const sourceCodeSha256=hash(blocks[0].text);
try{
 const prior=JSON.parse(await readFile(path.join(out,'source-bound-check.json')));
 assert.equal(prior.journal.sha256,journalSha256);assert.equal(prior.code.sha256,sourceCodeSha256);
 assert.equal(prior.row.exactSha256,hash(text));
 if(prior.oracle){const result=await readFile(path.join(out,'oracle.json'));assert.equal(hash(result),prior.oracle.sha256);}
 console.log(JSON.stringify({cached:true,file:path.join(out,'source-bound-check.json'),status:prior.status,failures:prior.oracle?.failures??null}));
 process.exit(0);
}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(path.dirname(out),{recursive:true});await mkdir(out);
const codeFile=path.join(out,'recorded.py'),oracleFile=path.join(out,'oracle.json');
await writeFile(codeFile,blocks[0].text,{flag:'wx'});
const checkerFile='.local/verify-recorded-graph-code-v71.py',checker=await readFile(checkerFile);
const startedAt=new Date().toISOString();let stdout='',stderr='';
const exitCode=await new Promise((resolve,reject)=>{
 const child=spawn('python',['-B',path.resolve(checkerFile),codeFile,oracleFile,journalSha256],
  {cwd:out,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(()=>child.kill(),120000);
 child.stdout.on('data',chunk=>stdout=(stdout+chunk).slice(-8000));
 child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-8000));
 child.once('error',error=>{clearTimeout(timer);reject(error);});
 child.once('exit',code=>{clearTimeout(timer);resolve(code);});
});
await writeFile(path.join(out,'stdout.log'),stdout,{flag:'wx'});await writeFile(path.join(out,'stderr.log'),stderr,{flag:'wx'});
const oracleBytes=exitCode===0?await readFile(oracleFile):null,oracle=oracleBytes?JSON.parse(oracleBytes):null;
if(oracle)assert.equal(oracle.sourceCodeSha256,sourceCodeSha256);
const report={status:exitCode===0?'completed':'execution_failed',exitCode,startedAt,completedAt:new Date().toISOString(),journal:{file,sha256:journalSha256},
 row:{round,exactSha256:hash(text),question:row.question,recognizedQuestion:row.recognizedQuestion,
  answerSha256:hash(row.answer),responseVersion:row.responseVersion,phase:row.phase,error:row.error,cancelled:row.cancelled},
 code:{file:path.relative(root,codeFile),sha256:sourceCodeSha256,languageAnnotation:blocks[0].languageAnnotation},
 oracle:oracle?{file:path.relative(root,oracleFile),sha256:hash(oracleBytes),exitCode,...oracle}:null,
 executionLogs:{stdout:{file:path.relative(root,path.join(out,'stdout.log')),sha256:hash(stdout)},stderr:{file:path.relative(root,path.join(out,'stderr.log')),sha256:hash(stderr)}},
 checkerSourceHashes:{[checkerFile]:hash(checker),'.local/verify-recorded-graph-code-v71.mjs':hash(await readFile(new URL(import.meta.url)))},
 goalComplete:false,scope:'Selective independent executable graph-contract check on this exact recorded implementation. '
 +'Naming differences between spoken and recognized interfaces remain visible. No source repair, correctness filtering of latency, or full-cohort certification.'};
await writeFile(path.join(out,'source-bound-check.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:path.join(out,'source-bound-check.json'),status:report.status,queries:oracle?.queries??null,failures:oracle?.failures??null}));
