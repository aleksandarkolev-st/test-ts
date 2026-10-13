import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedCppSource} from '../lib/recorded-cpp-source.mjs';

const source='int probe(int x) { return x < 0 ? 1 : 2; }\n';
const contract={kind:'integer-branch',exactSource:source,allowUnfencedExactSource:true};
test('an explicitly permitted standalone source is retained byte for byte',()=>{
 assert.deepEqual(recordedCppSource(source+'\nThe comparison excludes equality.',contract),{code:source,format:'contract_bound_unfenced_exact_source'});
 assert.equal(recordedCppSource(source,{kind:'integer-branch',exactSource:source}),null);
});
test('operator, whitespace and final-newline changes are not repaired',()=>{
 for(const answer of [source.replace('<','<='),' '+source,source.trimEnd()])assert.equal(recordedCppSource(answer,contract),null);
});
test('quoted prose and duplicate candidates do not become executable code',()=>{
 assert.equal(recordedCppSource('The source is '+source,contract),null);
 assert.equal(recordedCppSource(source+'\n'+source,contract),null);
});
test('a selected fence keeps its actual wrong operator instead of taking a correct excerpt',()=>{
 const changed=source.replace('<','<=');
 assert.deepEqual(recordedCppSource('```cpp\n'+changed+'```\n'+source,contract),{code:changed,format:'code_fence'});
});
test('complete-program and nonexistent-block contracts cannot enable excerpt extraction',()=>{
 assert.throws(()=>recordedCppSource(source,{...contract,kind:'cpp-self-test'}),/exact-source function contract/);
 assert.throws(()=>recordedCppSource(source,{...contract,block:1}),/no block index/);
});
