import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedCodeReference} from '../lib/recorded-code-reference.mjs';
test('delayed code probe names the actual earlier function without inserting its code',()=>{
 const answer='```cuda\n__device__ float actual_name(float value) { return value; }\n```';
 const result=recordedCodeReference({referenceTurn:'first',question:'Recall {{function}} exactly'},[{name:'first',answer}]);
 assert.equal(result.question,'Recall actual_name exactly');assert.equal(result.referenceEvidence.available,true);
 assert.equal(result.question.includes('return value'),false);assert.equal(result.referenceEvidence.codeSha256.length,64);
});
test('missing source code is an explicit recall dependency failure, not a hinted answer',()=>{
 const result=recordedCodeReference({referenceTurn:'failed',question:'Recall {{function}}'},[]);
 assert.equal(result.referenceEvidence.available,false);assert.equal(result.question,'Recall the earlier device function');
});
