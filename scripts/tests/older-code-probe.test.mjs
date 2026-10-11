import test from 'node:test';
import assert from 'node:assert/strict';
import {olderCodeProbe} from '../lib/older-code-probe.mjs';

test('older-code probe requires twenty turns and a completed uncancelled actual implementation',()=>{
 const rows=[{round:4,question:'Implement classify with exact string negative INF for reachable negative cycles.',responseVersion:'q:0'}];
 const job={answer:'```python\ndef classify(n, edges, source):\n    return []\n```',latency:{completedAt:10,responseRevision:2},cancelled:false};
 const latest=new Map([['q',job]]);
 assert.equal(olderCodeProbe(rows,latest,23),null);
 assert.equal(olderCodeProbe(rows,latest,24),null);
 const probe=olderCodeProbe(rows,latest,25);
 assert.equal(probe.interveningTurns,20);assert.equal(probe.sourceResponseVersion,'q:2');
 assert(probe.text.includes(rows[0].question));assert(!probe.text.includes('return []'));
 assert(probe.text.includes('FIRST completed implementation'));
 job.cancelled=true;assert.equal(olderCodeProbe(rows,latest,25),null);
 job.cancelled=false;job.latency.completedAt=null;assert.equal(olderCodeProbe(rows,latest,25),null);
});
