import assert from 'node:assert/strict';
import test from 'node:test';
import {gradeWithRetry} from '../lib/examiner-retry.mjs';

test('a timed-out examiner can retry once with both attempts recorded',async()=>{
 let calls=0;const evidence=[];
 await gradeWithRetry(async()=>{if(++calls===1)throw Error('Examiner exited 1: Codex answer timed out');},
  {attempts:2,onAttempt:async row=>{evidence.push(row);}});
 assert.equal(calls,2);assert.deepEqual(evidence.map(row=>row.status),['failed','complete']);
 assert.equal(evidence[0].retryable,true);
});
test('default, repeated timeouts and unrelated failures stay bounded',async()=>{
 for(const [attempts,message,expected] of [[1,'Codex answer timed out',1],[2,'Codex answer timed out',2],[2,'Authentication failed',1],[2,'Cancelled',1],[2,'Rate limit exceeded',1]]){
  let calls=0;const evidence=[];
  await assert.rejects(gradeWithRetry(async()=>{calls++;throw Error(message);},{attempts,onAttempt:async row=>{evidence.push(row);}}),new RegExp(message));
  assert.equal(calls,expected);assert.equal(evidence.length,expected);
 }
});
