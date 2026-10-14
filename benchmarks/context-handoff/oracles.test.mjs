import {test} from 'node:test';
import assert from 'node:assert/strict';
import {problems} from './catalog.mjs';
import {casesFor,oracles,gradeCode} from './oracles.mjs';
test('25 verified difficulty slots and independent oracle agreement on examples',()=>{
 assert.equal(problems.length,25);
 for(const [difficulty,n] of [['Hard',15],['Medium',5],['Easy',5]])assert.equal(problems.filter(p=>p.difficulty===difficulty).length,n);
 for(const p of problems){for(const [args,expected] of p.examples)assert.deepEqual(oracles[p.id](...structuredClone(args)),expected,`${p.id} example`);assert(casesFor(p.id).length>=71);}
});
test('grader rejects a fake constant implementation and handles arbitrary valid two-sum index order',()=>{
 assert.equal(gradeCode(42,'function solve(){return 6}').passed,false);
 assert.equal(gradeCode(1,'function solve(a,t){for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i]+a[j]===t)return[j,i];}').passed,true);
});
