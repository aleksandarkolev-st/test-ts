import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtures} from './cases.mjs';
import {interviews} from './catalog.mjs';
import {bugs} from './bugs.mjs';
import {gradeInterview,extractCode} from './grade.mjs';

test('every additional interview has frozen, distinct, executable rejection witnesses',()=>{
 assert.equal(Object.keys(fixtures).length,75);
 for(const task of interviews.filter(i=>i.gradeProvider==='synthetic-oracles')){
  const cases=fixtures[task.id];assert.ok(cases?.length>=4,task.id);
  assert.equal(new Set(cases.map(c=>JSON.stringify(c.args))).size,cases.length,task.id);
  const wrong=gradeInterview(task.id,'function solve(){return null;}');
  assert.equal(wrong.passed,false,task.id);assert.ok(wrong.failures.length,task.id);
 }
});
test('cross-check overlapping contracts against independent preexisting bug oracles',()=>{
 const pairs={'quoted-csv-row':'csv-escaping','absolute-path-normalization':'root-path','lru-cache-simulation':'lru-recency','ttl-cache-simulation':'ttl-expiry','fixed-window-rate-limiter':'window-reset','idempotent-event-processing':'event-identity','bounded-fifo-queue':'bounded-queue','lexicographic-topological-sort':'dependency-completion','minimum-meeting-rooms':'meeting-endpoint'};
 for(const [id,bugId] of Object.entries(pairs)){
  const oracle=bugs.find(b=>b.id===bugId).oracle;
  for(const {args,expected} of fixtures[id])assert.deepEqual(oracle(...structuredClone(args)),expected,id);
 }
});
test('large string arithmetic expected results are independently exact',()=>{
 for(const {args,expected} of fixtures['binary-string-addition'])assert.equal((BigInt('0b'+args[0])+BigInt('0b'+args[1])).toString(2),expected);
 for(const {args,expected} of fixtures['decimal-string-multiplication'])assert.equal((BigInt(args[0])*BigInt(args[1])).toString(),expected);
});
test('grading runs actual implementations and bounds runaway and non-JSON outputs',()=>{
 assert.equal(gradeInterview('rotate-array','function solve(a,k){if(!a.length)return [];k%=a.length;return a.slice(a.length-k).concat(a.slice(0,a.length-k));}').passed,true);
 assert.equal(gradeInterview('maximum-subarray','function solve(a){let best=-Infinity;for(let i=0;i<a.length;i++){let sum=0;for(let j=i;j<a.length;j++){sum+=a[j];best=Math.max(best,sum);}}return best;}').passed,true);
 assert.equal(gradeInterview('majority-element','function solve(){return Infinity;}').passed,false);
 assert.equal(gradeInterview('move-zeros','function solve(){throw Error("candidate failure");}').passed,false);
 assert.equal(extractCode('Explanation\n~~~js\nfunction solve(){return 1;}\n~~~'),'function solve(){return 1;}\n');
});
