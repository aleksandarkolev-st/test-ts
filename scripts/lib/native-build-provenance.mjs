import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function nativeBuildProvenance(binaryRoot,sourceRoot,files){
 const bytes=await readFile(path.join(binaryRoot,'build.json')),declared=JSON.parse(bytes);
 const binarySha256=sha(await readFile(path.join(binaryRoot,'meeting-copilot.exe')));
 assert.equal(declared.nativeBinarySha256,binarySha256,'Frozen binary does not match its build manifest');
 assert(/^[a-f0-9]{7,40}$/.test(declared.productionCommit),'Build manifest must name a Git commit');
 for(const file of files)assert(/^src-tauri\/src\/[A-Za-z0-9_./-]+\.rs$/.test(file)&&!file.split('/').includes('..'));
 const gitBlobSha256=Object.fromEntries(await Promise.all(files.map(async file=>{
  const output=await new Promise((resolve,reject)=>{
   const child=spawn('git',['-C',sourceRoot,'show',`${declared.productionCommit}:${file}`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   const chunks=[];let error='';child.stdout.on('data',x=>chunks.push(x));child.stderr.on('data',x=>error+=x);
   child.once('error',reject);child.once('exit',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(error)));
  });
  return [file,sha(output)];
 })));
 return {declared,manifestSha256:sha(bytes),gitBlobSha256,
  scope:'Binary hash checked against the preserved build manifest; source hashes are Git blob bytes at its declared build commit. Current checkout bytes are recorded separately and may differ. This is provenance evidence, not a reproducible-build attestation.'};
}
