import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bugs,checkBug} from './bugs.mjs';
test('20 different bug mechanisms each have an executable failing witness',()=>{
 assert.equal(bugs.length,20);assert.equal(new Set(bugs.map(b=>b.source)).size,20);
 for(const b of bugs){const grade=checkBug(b,b.source);assert(!grade.passed,`${b.id} must exhibit its injected defect`);assert(grade.failures?.length>0,`${b.id} needs a functional witness, not a syntax error`);}
});
test('golden implementations satisfy the fixture contracts',()=>{
 for(const b of bugs){const source=`function solve(...args){return (${b.oracle.toString()})(...args);}`;assert(checkBug(b,source).passed,`${b.id} golden control`);}
});

test('an empty target requires an empty minimum window',()=>{
 const oracle=bugs.find(b=>b.id==='window-multiplicity').oracle;
 for(const source of ['', 'A', '😀AB'])assert.equal(oracle(source,''),'');
 assert.equal(oracle('BAAA','AA'),'AA');
});

test('zero-product references handle empty products and zero after overflow',()=>{
 const oracle=bugs.find(b=>b.id==='zero-product').oracle;
 assert.deepEqual(oracle([]),[]);
 assert.deepEqual(oracle([0]),[1]);
 assert.deepEqual(oracle([0,2,3]),[6,0,0]);
 assert.deepEqual(oracle([0,0,2]),[0,0,0]);
 for(const values of [
  [...Array(310).fill(10),0,0],
  [0,...Array(310).fill(10),0],
  [0,0,...Array(310).fill(10)],
 ])assert.deepEqual(oracle(values),Array(values.length).fill(0));
});

test('integer TTL deadlines compare exactly beyond safe-integer addition',()=>{
 const oracle=bugs.find(b=>b.id==='ttl-expiry').oracle;
 assert.deepEqual(oracle([
  [Number.MAX_SAFE_INTEGER,'put','a',7,2],
  [2**53,'get','a'],
  [2**53+2,'get','a'],
 ]),[7,null]);
 assert.deepEqual(oracle([[0,'put','a',0,2],[1,'get','a'],[2,'get','a']]),[0,null]);
 assert.deepEqual(oracle([[1,'put','a',7,0],[1,'get','a']]),[null]);
});

test('reference repairs preserve all original fixture expectations and injected defects',async()=>{
 const snapshot=JSON.parse(await readFile(new URL('../../docs/evidence/interview-frozen-contract-snapshot.json',import.meta.url),'utf8'));
 const original=await import('data:text/javascript;base64,'+snapshot.files.find(f=>f.name==='bugs.mjs').bytes);
 assert.equal(bugs.length,original.bugs.length);
 for(const bug of bugs){
  const before=original.bugs.find(b=>b.id===bug.id);
  assert.equal(bug.source,before.source);
  assert.equal(bug.contract,before.contract);
  assert.deepEqual(bug.cases,before.cases);
  for(const args of bug.cases)assert.deepEqual(bug.oracle(...structuredClone(args)),before.oracle(...structuredClone(args)),bug.id);
 }
});
