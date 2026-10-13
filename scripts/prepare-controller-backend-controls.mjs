// Freeze observed inputs for backend-only comparisons. This tool prepares
// validation fixtures; it does not choose application intent or repair ASR.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [journalFile,reviewFile,manifestFile,outputDir]=process.argv.slice(2);
assert(journalFile&&reviewFile&&manifestFile&&outputDir,'JOURNAL REVIEW ORIGINAL_MANIFEST NEW_OUTPUT_DIRECTORY');
const root=process.cwd(),out=path.resolve(outputDir);assert(out.startsWith(path.resolve('artifacts')+path.sep));
const sha=b=>createHash('sha256').update(b).digest('hex'),bytes=await readFile(journalFile),j=JSON.parse(bytes),reviewBytes=await readFile(reviewFile),review=JSON.parse(reviewBytes);
assert.equal(j.status,'complete');assert.equal(review.journalSha256,sha(bytes));
const reviewed=new Map(review.rows.map(r=>[r.round,r]));
assert.equal(reviewed.size,review.rows.length,'Duplicate review rows cannot define comparison inputs');
assert.equal(reviewed.size,j.rows.length,'Every reference outcome must be reviewed before selecting backend controls');
for(const r of j.rows){assert(reviewed.has(r.round),'Unreviewed reference outcome');assert.equal(reviewed.get(r.round).answerSha256,sha(r.answer));}
const manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes);assert.equal(sha(manifestBytes),j.manifestSha256);
await mkdir(out);const text=[],audio=[],skipped=[],bindings=[];
for(const verdict of review.rows.filter(r=>r.ordinaryFollowup)){
 const r=j.rows.find(x=>x.round===verdict.round);assert(r);assert.equal(verdict.answerSha256,sha(r.answer));
 if(r.selectedContext==null||r.recognizedQuestion==null){skipped.push({round:r.round,name:r.name,reason:'No accepted input/context was captured. Original missing/failed outcome remains in reference denominator; no context or recognized question invented.'});continue;}
 const sourceBinding={journalFile:path.relative(root,path.resolve(journalFile)),journalSha256:sha(bytes),round:r.round,referenceGeneration:r.responseVersion,
  contextSha256:sha(r.selectedContext),recognizedQuestionSha256:sha(r.recognizedQuestion),originalSourceQuestionSha256:sha(r.question),referenceOutcome:verdict.correctness};
 const shared={name:r.name+'-frozen-'+r.round,fixedContext:r.selectedContext,ordinaryFollowup:true,sourceBinding};
 text.push({...shared,question:r.recognizedQuestion});
 if(r.waveFile){const waveFile=path.resolve(r.waveFile);assert(waveFile.startsWith(root+path.sep));const waveSha256=sha(await readFile(waveFile));assert.equal(waveSha256,r.waveSha256??r.audio?.sha256);
  audio.push({...shared,question:r.question,waveFile:r.waveFile,waveSha256,expectedReply:r.expectedReply});
 }
 bindings.push({...sourceBinding,waveSha256:r.waveSha256??r.audio?.sha256??null});
}
const base={model:j.model,effort:j.effort,objective:manifest.objective??'detailed',serviceTier:j.tier??null};
assert.equal(base.model,'gpt-6.1-sol');assert.equal(base.effort,'low');
for(const [mode,turns] of Object.entries({text,audio}))await writeFile(path.join(out,mode+'.json'),JSON.stringify({...base,
 scope:mode==='text'?'Backend-only control: identical recognized text and actual frozen context for each backend. Explicit typed acceptance excludes ASR.':'Backend-only audio control: identical saved waveform and frozen context for each backend. Recognition may differ and must be reported. Automatic acceptance remains production policy.',turns},null,2));
await writeFile(path.join(out,'binding.json'),JSON.stringify({journalSha256:sha(bytes),reviewSha256:sha(reviewBytes),manifestSha256:sha(manifestBytes),nativeBinarySha256:j.nativeBinarySha256,bindings,skipped,
 scope:'Prepared inputs only, not inference results. All ordinary reference outcomes, including incorrect ones, are preserved. Missing captured context is disclosed rather than invented. Contexts intentionally contain actual earlier Codex suggestions, held identical across backend cells.'},null,2));
console.log(JSON.stringify({outputDir,text:text.length,audio:audio.length,skipped:skipped.length}));
