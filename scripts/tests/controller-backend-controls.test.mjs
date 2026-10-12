import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=process.cwd(),artifacts=path.resolve('artifacts'),sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 await mkdir(artifacts,{recursive:true});const dir=await mkdtemp(path.join(artifacts,'backend-control-fixture-'));
 const manifest=JSON.stringify({model:'gpt-6.1-sol',effort:'low',objective:'brief',serviceTier:'fast'}),wave=Buffer.from('RIFF synthetic fixture bytes');
 const waveFile=path.join(dir,'input.wav');await writeFile(waveFile,wave);
 const rows=[{round:1,name:'reference-failure',question:'Why?',recognizedQuestion:'Y',selectedContext:'REMOTE: exact source\n```cpp\nint X=-17;\n```\nCOPILOT: claim',responseVersion:'generation:0',waveFile,waveSha256:sha(wave),answer:'Incorrect reference answer'},
 {round:2,name:'reference-missing',question:'Why?',recognizedQuestion:null,selectedContext:null,answer:''}];
 const journal=JSON.stringify({status:'complete',model:'gpt-6.1-sol',effort:'low',tier:'fast',manifestSha256:sha(manifest),rows});
 const review=JSON.stringify({journalSha256:sha(journal),rows:rows.map(r=>({round:r.round,answerSha256:sha(r.answer),ordinaryFollowup:true,correctness:'incorrect'}))});
 const files=[journal,review,manifest].map((_,i)=>path.join(dir,['journal','review','manifest'][i]+'.json'));
 for(const [i,text] of [journal,review,manifest].entries())await writeFile(files[i],text);
 return {dir,files,rows,waveFile,async clean(){const target=path.resolve(dir);assert(target.startsWith(artifacts+path.sep+'backend-control-fixture-'));await rm(target,{recursive:true,force:true});},run(output='prepared'){return spawnSync(process.execPath,['scripts/prepare-controller-backend-controls.mjs',...files,path.join(dir,output)],{cwd:root,encoding:'utf8',windowsHide:true});}};
}
test('backend controls preserve exact failed inputs and disclose uncaptured requests',async()=>{
 const f=await fixture();try{const result=f.run();assert.equal(result.status,0,result.stderr);
  const read=async name=>JSON.parse(await readFile(path.join(f.dir,'prepared',name+'.json'))),text=await read('text'),audio=await read('audio'),binding=await read('binding');
  assert.equal(text.objective,'brief');assert.equal(text.serviceTier,'fast');assert.equal(text.turns[0].question,'Y');assert.equal(audio.turns[0].question,'Why?');
  assert.equal(text.turns[0].fixedContext,f.rows[0].selectedContext);assert.equal(audio.turns[0].fixedContext,text.turns[0].fixedContext);
  assert.equal(binding.bindings[0].referenceOutcome,'incorrect');assert.equal(binding.skipped[0].round,2);assert.equal(text.turns.length,1);assert.equal(audio.turns.length,1);
 }finally{await f.clean();}
});
test('changed reference manifest is rejected before preparing comparison inputs',async()=>{
 const f=await fixture();try{await writeFile(f.files[2],'{}');assert.notEqual(f.run().status,0);}finally{await f.clean();}
});
test('changed recorded waveform is rejected without repairing or replacing it',async()=>{
 const f=await fixture();try{await writeFile(f.waveFile,'changed');assert.notEqual(f.run().status,0);}finally{await f.clean();}
});
test('an omitted failed reference outcome cannot silently disappear from controls',async()=>{
 const f=await fixture();try{const review=JSON.parse(await readFile(f.files[1]));review.rows.pop();await writeFile(f.files[1],JSON.stringify(review));assert.notEqual(f.run().status,0);}finally{await f.clean();}
});
