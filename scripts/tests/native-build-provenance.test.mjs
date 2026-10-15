import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {nativeBuildProvenance} from '../lib/native-build-provenance.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'controller-build-provenance-'));
 t.after(async()=>{assert(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true});});
 const binary='frozen test binary';await writeFile(path.join(root,'WmiPrvSE.exe'),binary);
 return {root,binary};
}
function git(root,args){return new Promise((resolve,reject)=>{
 const child=spawn('git',['-c','core.autocrlf=false','-c','core.hooksPath=','-c','commit.gpgSign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.once('error',reject);child.once('exit',code=>code===0?resolve(stdout.trim()):reject(Error(stderr)));
});}
test('a changed binary cannot inherit a preserved build manifest',async t=>{
 const {root}=await fixture(t);await writeFile(path.join(root,'build.json'),JSON.stringify({productionCommit:'c704a75',nativeBinarySha256:sha('different binary')}));
 await assert.rejects(nativeBuildProvenance(root,root,[]),/Frozen binary/);
});
test('frozen source hashes follow the build commit despite later checkout edits',async t=>{
 const {root,binary}=await fixture(t),file='src-tauri/src/runtime.rs',original='fn frozen_source() {}\n';
 await mkdir(path.join(root,'src-tauri/src'),{recursive:true});await writeFile(path.join(root,file),original);
 await git(root,['init']);await git(root,['add',file]);await git(root,['commit','-m','fixture']);const commit=await git(root,['rev-parse','HEAD']);
 await writeFile(path.join(root,'build.json'),JSON.stringify({productionCommit:commit,nativeBinarySha256:sha(binary)}));
 await writeFile(path.join(root,file),'fn changed_checkout() {}\n');
 const evidence=await nativeBuildProvenance(root,root,[file]);
 assert.equal(evidence.declared.productionCommit,commit);assert.equal(evidence.gitBlobSha256[file],sha(original));
 assert.notEqual(evidence.gitBlobSha256[file],sha('fn changed_checkout() {}\n'));
 await assert.rejects(nativeBuildProvenance(root,root,['src-tauri/src/../../other.rs']));
});
