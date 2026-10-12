import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {integerBranchHarness} from '../lib/integer-branch-harness.mjs';

test('external contract catches an original operator returned for a correction',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'controller-integer-contract-'));
 const run=(file,args)=>new Promise((resolve,reject)=>{
  const child=spawn(file,args,{windowsHide:true,stdio:'ignore'});
  const timer=setTimeout(()=>{child.kill();reject(new Error('Contract check exceeded its 20-second budget'));},20000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});
 });
 try {
  const contract={function:'Sample',operator:'<=',threshold:-1,whenTrue:17,whenFalse:19,minimum:-1000,maximum:1000};
  for(const [index,operator] of ['<=','<'].entries()){
   const source=path.join(directory,index+'.cpp'),executable=path.join(directory,index+'.exe');
   await writeFile(source,integerBranchHarness(`int Sample(int x) { return x ${operator} -1 ? 17 : 19; }\n`,contract));
   assert.equal(await run(process.env.CONTROLLER_TEST_CXX??'C:/TheRock/build/bin/clang++.exe',['-std=c++17',source,'-o',executable]),0);
   const code=await run(executable,[]);
   if(index===0)assert.equal(code,0);else assert.notEqual(code,0);
  }
 }finally{
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
  assert(path.basename(directory).startsWith('controller-integer-contract-'));
  await rm(directory,{recursive:true,force:true});
 }
});
