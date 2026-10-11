// Temporary Git authentication. Read the credential only from stdin, pass it
// through a private askpass child, and never store it in files or remote URLs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const credentialKey='TASK_GIT_PUSH_TOKEN';
if(process.argv[2]==='--askpass'){
 const prompt=process.argv.slice(3).join(' ');
 assert(/https:\/\/(?:x-access-token@)?github\.com(?:['/:]|$)/.test(prompt),'Unexpected credential realm');
 if(/^Username/i.test(prompt))process.stdout.write('x-access-token\n');
 else if(/^Password/i.test(prompt)){
  assert(process.env[credentialKey],'Missing temporary credential');process.stdout.write(process.env[credentialKey]+'\n');
 }else throw new Error('Unexpected credential prompt');
}else{
 const probe=process.argv[2]==='--probe';
 const refs=process.argv.slice(2);assert(refs.length,'Supply branch refs');
 const adapter=path.resolve('.local/git-token-askpass-v71.cmd'),source=fileURLToPath(import.meta.url);
 const content='@echo off\r\n"'+process.execPath+'" "'+source+'" --askpass %*\r\n';
 try{await writeFile(adapter,content,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;assert.equal(await readFile(adapter,'utf8'),content);}
 assert(process.stdin.isTTY&&typeof process.stdin.setRawMode==='function','A terminal with disabled echo is required');
 process.stdin.setRawMode(true);
 const input=createInterface({input:process.stdin,terminal:false});
 console.log('Waiting for temporary Git credential on stdin; input will not be echoed.');
 let token=await new Promise((resolve,reject)=>{
  input.once('line',resolve);input.once('close',()=>reject(new Error('No credential supplied on stdin')));
 });input.close();assert(token&& !/[\r\n\0]/.test(token),'Invalid credential input');
 if(probe){token='';process.stdin.setRawMode(false);process.stdin.pause();console.log('Non-echoing input probe completed.');process.exit(0);}
 function git(args,authenticated=false){return new Promise((resolve,reject)=>{
  const child=spawn('git',args,{windowsHide:true,stdio:['ignore','pipe','pipe'],
   env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',
    ...(authenticated?{GIT_ASKPASS:adapter,[credentialKey]:token}:{})}});
  const output=[];let size=0;
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
   size+=chunk.length;if(size>1048576){child.kill();reject(new Error('Git output limit exceeded'));return;}output.push(chunk);
  });
  child.once('error',reject);child.once('close',code=>resolve({code,text:Buffer.concat(output).toString('utf8')}));
 });}
 try{
  const remote=await git(['remote','get-url','origin']);assert.equal(remote.code,0);const url=new URL(remote.text.trim());
  assert.equal(url.protocol,'https:');assert.equal(url.hostname,'github.com');assert(!url.username&&!url.password,'Remote must not contain credentials');
  for(const ref of refs){const checked=await git(['check-ref-format','--branch',ref]);assert.equal(checked.code,0,'Invalid branch ref');}
  const result=await git(['-c','credential.helper=','push','origin',...refs],true);
  console.log(result.text.replaceAll(token,'[redacted]'));process.exitCode=result.code??1;
 }finally{token='';delete process.env[credentialKey];process.stdin.setRawMode(false);process.stdin.pause();}
}
