import test from 'node:test';
import assert from 'node:assert/strict';
import {examinerPublicHistory} from '../lib/examiner-public-history.mjs';

test('examiner receives earlier completions observed now rather than a permanently frozen partial prefix',()=>{
 const rows=[{question:'Implement it',answer:'Use a custom iterator',responseVersion:'old:0'},
  {question:'Why?',answer:'Because'}, {question:'A later question',answer:'future code'}];
 const latest=new Map([['old',{answer:'Use a custom iterator.\nclass Iterator: pass',running:false,cancelled:false}]]);
 const history=examinerPublicHistory(rows,rows[1],latest,'Introduction');
 assert(history.includes('class Iterator: pass'));
 assert(!history.includes('future code'));assert(!history.includes('INTERVIEWER: Why?'));
 latest.set('old',{answer:'Use a custom iterator',running:true,cancelled:false});
 const beforeCompletion=examinerPublicHistory(rows,rows[1],latest,'Introduction');
 assert(!beforeCompletion.includes('class Iterator: pass'));assert(beforeCompletion.includes('still streaming'));
});
