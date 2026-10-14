import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bugs,checkBug} from './bugs.mjs';
test('20 different bug mechanisms each have an executable failing witness',()=>{
 assert.equal(bugs.length,20);assert.equal(new Set(bugs.map(b=>b.source)).size,20);
 for(const b of bugs){const grade=checkBug(b,b.source);assert(!grade.passed,`${b.id} must exhibit its injected defect`);assert(grade.failures?.length>0,`${b.id} needs a functional witness, not a syntax error`);}
});
test('golden implementations satisfy the fixture contracts',()=>{
 for(const b of bugs){const source=`function solve(...args){return (${b.oracle.toString()})(...args);}`;assert(checkBug(b,source).passed,`${b.id} golden control`);}
});
