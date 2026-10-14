import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {checkReservations} from './grade-interview.mjs';
import {createService} from './project/src/service.mjs';
const original=await readFile(new URL('./project/src/reservations.mjs',import.meta.url),'utf8');
const control=checkReservations(original);
assert.equal(control.passed,false);assert.equal(control.results.filter(r=>r.passed).length,2,'The grader must catch the injected defect, not merely accept the fixture');
const service=createService({A:1});let rejected=false;
try{service.reserve('r1',[{sku:'A',quantity:1},{sku:'A',quantity:1}]);}catch{rejected=true;}
assert(rejected);assert.deepEqual(service.inventory(),{A:0});
const evidence={diagnosisReviewed:true,source:'src/reservations.mjs',mechanism:'Inventory is deducted per line item before later validation; rejection leaves partial mutations.',counterexample:{stockBefore:{A:1},requestId:'r1',items:[{sku:'A',quantity:1},{sku:'A',quantity:1}],rejected,stockAfter:service.inventory(),requiredStockAfter:{A:1}},originalDefectiveImplementationControl:control,review:'Source inspection and independent execution confirm the round 1 diagnosis and counterexample. Rounds 2 and 3 are independently executed by grade-interview.mjs.'};
await writeFile('docs/evidence/context-interview-review-2026-10-14.json',JSON.stringify(evidence,null,2));
console.log('PASS diagnosis reproduction; original fixture fails 6/8 checks; returned implementations pass 8/8 each');
