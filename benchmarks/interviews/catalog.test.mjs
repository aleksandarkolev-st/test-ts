import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interviews} from './catalog.mjs';
test('exactly 100 distinct substantive three-round interview contracts',()=>{
 assert.equal(interviews.length,100);assert.equal(new Set(interviews.map(i=>i.task)).size,100);
 for(const i of interviews){assert.match(i.signature,/^solve\(/);assert(i.task.length>50);assert.equal(i.rounds.length,3);assert(i.rounds.every(r=>r.length>80));}
});
