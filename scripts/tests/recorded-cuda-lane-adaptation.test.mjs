import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptRecordedPhysicalLaneRead} from '../lib/recorded-cuda-lane-adaptation.mjs';
test('both recorded volatile and nonvolatile lane reads use the CPU physical lane',()=>{
 for(const instruction of ['asm("mov.u32 %0, %%laneid;" : "=r"(lane));','asm ("mov.u32 %0, %%laneid;" : "=r" (lane));','asm volatile("mov.u32 %0, %%laneid;" : "=r"(lane));']){
  const source='unsigned lane;\n'+instruction+'\nreturn __shfl_sync(mask,value,18,32);';
  const result=adaptRecordedPhysicalLaneRead(source);
  assert.equal(result.source,'unsigned lane;\nlane = threadIdx.x;\nreturn __shfl_sync(mask,value,18,32);');
  assert.equal(result.ptxLaneReadsReplaced,1);assert.equal(result.algorithmRepaired,false);
 }
});
test('adaptation cannot repair an invalid source, mask or lane predicate',()=>{
 const source='unsigned physical; asm volatile ("mov.u32 %0, %%laneid;" : "=r"(physical));\nif (physical < 18) return __shfl_sync(0xffffffffu,value,29,16);';
 const result=adaptRecordedPhysicalLaneRead(source);
 assert.equal(result.source,'unsigned physical; physical = threadIdx.x;\nif (physical < 18) return __shfl_sync(0xffffffffu,value,29,16);');
});
test('other PTX and absent lane reads are preserved as unsupported',()=>{
 const source='asm("mov.u32 %0, %%warpid;" : "=r"(warp));\nreturn value;';
 assert.equal(adaptRecordedPhysicalLaneRead(source).source,source);
 assert.equal(adaptRecordedPhysicalLaneRead(source).ptxLaneReadsReplaced,0);
});
test('examples in comments and raw strings remain byte-exact',()=>{
 const example='asm("mov.u32 %0, %%laneid;" : "=r"(lane));';
 const constants='// '+example+'\n/* '+example+' */\nconst char* text=R"sample('+example+')sample";\n';
 const source=constants+example;
 const result=adaptRecordedPhysicalLaneRead(source);
 assert.equal(result.source,constants+'lane = threadIdx.x;');
 assert.equal(result.ptxLaneReadsReplaced,1);
});
