// Immutable offline source extraction, not runtime code execution or routing.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fencedSources} from './lib/fenced-sources.mjs';
const [source,roundText,directory,extension='cpp']=process.argv.slice(2);
assert(source&&roundText&&directory,'Usage: node scripts/export-interview-code.mjs JOURNAL ROUND OUTPUT_DIR [EXTENSION]');
const round=Number(roundText);assert(Number.isInteger(round)&&round>0);
assert(/^[a-z0-9]+$/u.test(extension),'Extension must be a plain suffix');
const inside=file=>{const p=path.resolve(file);assert(p.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));return p;};
const raw=await readFile(inside(source)),journal=JSON.parse(raw),row=journal.rows.find(row=>row.round===round);
assert(row&&row.latency?.completedAt!=null&&!row.ignored,'Require a completed retained response row');
const blocks=fencedSources(row.answer);
assert(blocks.length,'No closed code fences in retained answer');
await mkdir(inside(directory),{recursive:true});
const files=[];
for(const [index,block] of blocks.entries()){
 const text=block.text,file=path.join(directory,`round-${round}-block-${index+1}.${extension}`);
 await writeFile(inside(file),text,{flag:'wx'});
 files.push({file,languageAnnotation:block.languageAnnotation,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});
}
const manifest={recordedAt:new Date().toISOString(),scope:'Exact closed fenced sources extracted from one completed retained response. Extraction proves provenance, not compilability, passing tests, API behavior or correctness. An in-progress source journal remains incomplete interview evidence. No generated source is patched to make it pass.',
 source:{file:source,sha256:createHash('sha256').update(raw).digest('hex'),status:journal.status},round,responseVersion:row.responseVersion,
 model:journal.model,effort:journal.effort,tier:journal.tier,question:row.question,recognizedQuestion:row.recognizedQuestion,
 answerSha256:createHash('sha256').update(row.answer).digest('hex'),modelVerdict:row.review?.verdict??null,files};
manifest.extractionToolSha256=Object.fromEntries(await Promise.all(['scripts/export-interview-code.mjs','scripts/lib/fenced-sources.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(inside(file))).digest('hex')])));
await writeFile(inside(path.join(directory,`round-${round}.manifest.json`)),JSON.stringify(manifest,null,2),{flag:'wx'});
console.log(JSON.stringify({round,files}));
