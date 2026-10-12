import assert from 'node:assert/strict';

// Source selection for the execution grader. Never repair or normalize code.
export function recordedCppSource(answer, contract) {
 if(contract.allowUnfencedExactSource===true) {
  assert.equal(contract.kind,'integer-branch','Unfenced extraction requires an exact-source function contract');
  assert.equal(contract.block??0,0,'An unfenced source has no block index');
  assert(typeof contract.exactSource==='string'&&contract.exactSource.trim().length>0,'Bind the exact requested source');
 }
 const blocks=[...answer.matchAll(/```(?:cpp|c\+\+|cuda|c)?\s*\n([\s\S]*?)```/g)].map(m=>m[1]);
 if(blocks[contract.block??0]!=null)return {code:blocks[contract.block??0],format:'code_fence'};
 if(blocks.length||contract.allowUnfencedExactSource!==true)return null;
 const code=contract.exactSource,start=answer.indexOf(code),end=start+code.length;
 if(start<0||answer.indexOf(code,start+1)>=0)return null;
 if(start>0&&answer[start-1]!=='\n')return null;
 if(!code.endsWith('\n')&&end<answer.length&&answer[end]!=='\n')return null;
 return {code,format:'contract_bound_unfenced_exact_source'};
}
