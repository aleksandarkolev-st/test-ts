// Describe checks of untouched recorded answers; never repair their code.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordedCohort} from './lib/recorded-cohort.mjs';
import {fencedSources} from '../scripts/lib/fenced-sources.mjs';
const [root='artifacts/deep-interview-v71',output]=process.argv.slice(2);assert(output);
const hash=value=>createHash('sha256').update(value).digest('hex'),evidence=new Map();
async function bytes(file){const value=await readFile(file);evidence.set(path.resolve(file),{file,sha256:hash(value)});return value;}
async function load(file){return JSON.parse(await bytes(file));}
async function bound(source){const value=await bytes(source.file);assert.equal(hash(value),source.sha256);return value;}
const cohort=await recordedCohort(root),inputs=[...cohort.hours];
for(const dir of (await readdir(root+'/hard-probes',{withFileTypes:true})).filter(dir=>dir.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)))
 inputs.push({kind:'specified_probe',name:dir.name,file:root+'/hard-probes/'+dir.name+'/interview.json'});
const compilations=[],olderReferences=[];
for(const entry of inputs){
 const journal=await load(entry.file),journalSha256=evidence.get(path.resolve(entry.file)).sha256,directory=path.dirname(entry.file);
 const compilationFile=directory+'/code-review/nvcc-compilation-v71/compilation.json',compilation=await load(compilationFile);
 assert.equal(compilation.journal.sha256,journalSha256);await bound(compilation.toolchain);
 const blocks=[];
 for(const block of compilation.blocks){
  const row=journal.rows.find(row=>row.round===block.round);assert(row);
  assert.equal(hash(row.answer??''),block.answerSha256);
  const code=await bound(block.code);assert(fencedSources(row.answer??'').some(source=>hash(source.text)===hash(code)));
  const stdout=(await bound(block.stdout)).toString('utf8'),stderr=(await bound(block.stderr)).toString('utf8');
  if(block.object)await bound(block.object);
  blocks.push({round:block.round,block:block.block,answerSha256:block.answerSha256,code:block.code,
   exitCode:block.exitCode,timedOut:block.timedOut,object:block.object,
   diagnostics:block.exitCode===0?null:{stdout,stderr},
   scope:'Exact fenced source compiled as its own translation unit, without inserted headers or host wrappers. Context-dependent snippets can fail standalone compilation; compilation success does not prove behavior.'});
 }
 compilations.push({name:entry.name,kind:entry.kind,journal:{file:entry.file,sha256:journalSha256},
  compilation:{file:compilationFile,sha256:evidence.get(path.resolve(compilationFile)).sha256},summary:compilation.summary,blocks});
 if(journal.olderCodeProbe){
  const auditFile=directory+'/older-code-reference-audit.json',audit=await load(auditFile);
  assert.equal(audit.journal.sha256,journalSha256);
  const original=journal.rows.find(row=>row.round===journal.olderCodeProbe.sourceRound),probeIndex=journal.rows.findIndex(row=>row.round===journal.olderCodeProbe.probeRound),probe=journal.rows[probeIndex];
  assert(original&&probe);assert.equal(hash(original.answer??''),journal.olderCodeProbe.sourceAnswerSha256);
  assert.equal(typeof probe.selectedContext,'string');
  const reviewFile=directory+'/independent-model-review-v71/trial-'+String(probeIndex+1).padStart(3,'0')+'.json',review=await load(reviewFile);
  olderReferences.push({name:entry.name,journal:{file:entry.file,sha256:journalSha256},audit:{file:auditFile,sha256:evidence.get(path.resolve(auditFile)).sha256},
   sourceRound:original.round,probeRound:probe.round,interveningTurns:audit.probe.interveningTurns,
   spokenQuestion:probe.question,recognizedQuestion:probe.recognizedQuestion,answer:probe.answer,
   selectedContextSha256:hash(probe.selectedContext),selectedContextCharacters:probe.selectedContext.length,
   fullOriginalAnswerPresentInSelectedContext:probe.selectedContext.includes(original.answer),
   sourceBlocks:fencedSources(original.answer??'').map(source=>({sha256:hash(source.text),characters:source.text.length,
    exactBodyPresentInSelectedContext:probe.selectedContext.includes(source.text),exactBodyReproducedInAnswer:(probe.answer??'').includes(source.text)})),
   independentReview:{file:reviewFile,sha256:evidence.get(path.resolve(reviewFile)).sha256,verdict:review.review.verdict,issues:review.review.issues},
   scope:'Recorded selected context only. Absence here does not prove the service had no historical input. The public spoken reference can be truncated by the evaluation interviewer; original code and expected answers were not inserted into the new question.'});
 }
}
const selections=await load('docs/evidence/recorded-code-selections-v71.json'),codeChecks=[];
for(const selection of selections.checks){
 const checkFile=selection.outputDirectory+'/source-bound-check.json',check=await load(checkFile);
 assert.equal(check.journal.sha256,selection.journalSha256);await bound(check.journal);await bound(check.code);
 assert.equal(check.row.exactSha256,selection.rowSha256);assert.equal(check.row.answerSha256,selection.answerSha256);
 if(check.oracle)await bound(check.oracle);for(const source of Object.values(check.executionLogs))await bound(source);
 const journal=await load(selection.file),index=journal.rows.findIndex(row=>row.round===selection.round);
 const reviewFile=path.dirname(selection.file)+'/independent-model-review-v71/trial-'+String(index+1).padStart(3,'0')+'.json',review=await load(reviewFile);
 codeChecks.push({kind:selection.kind,check:{file:checkFile,sha256:evidence.get(path.resolve(checkFile)).sha256},
  row:check.row,code:check.code,oracle:check.oracle,
  independentReview:{file:reviewFile,sha256:evidence.get(path.resolve(reviewFile)).sha256,verdict:review.review.verdict,issues:review.review.issues},
  scope:'Computational checks and source-interface judgments remain separate. Passing a finite oracle does not override an incorrect source API, missing requirements or other interview failures.'});
}
const collector=fileURLToPath(import.meta.url);await bytes(collector);
const report={recordedAt:new Date().toISOString(),compilations,olderReferences,codeChecks,evidence:[...evidence.values()],
 scope:'Source-bound compiler, finite computational-oracle and older-code context observations. No answer repair, replacement implementation, verdict rewrite or runtime topic rule. Hardware execution and all-input mathematical correctness are not certified.'};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({compilations:compilations.filter(item=>item.blocks.length).map(item=>({name:item.name,summary:item.summary})),
 olderReferences:olderReferences.map(({name,sourceRound,probeRound,sourceBlocks,independentReview})=>({name,sourceRound,probeRound,sourceBlocks,verdict:independentReview.verdict})),
 codeChecks:codeChecks.map(item=>({kind:item.kind,queries:item.oracle?.queries,failures:item.oracle?.failures,verdict:item.independentReview.verdict}))}));
