import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('pressure audit measures native endpoints without inventing source assignments or dropping missing jobs',async()=>{
 const directory=await mkdtemp(path.resolve('.local/pressure-audit-check-'));
 try{
  const jobs=[{question:{id:'a',text:'Why?'},answer:'Because it fails.',phase:'complete',cancelled:false,
   latency:{speechStoppedAt:2000,completedAt:2400,responseRevision:0}},
   {question:{id:'b',text:'And if?'},answer:'',phase:'ignored',cancelled:true,latency:{speechStoppedAt:2200}}];
  const journal={status:'complete',stoppedCleanly:true,
   continuousPressure:{segments:[{},{}],nativeJobs:jobs,clockAnchors:[
    {hostBeforeMs:10000,hostAfterMs:10010,nativeMs:1000},
    {hostBeforeMs:12000,hostAfterMs:12010,nativeMs:3000}]},
   overlayPaintSamples:[{recorderVersion:2,questionId:'a',revision:0,text:'Because it fails.',hostMs:11200,
    visible:true,visibleStart:0,visibleEnd:17,streaming:true}]};
  await writeFile(path.join(directory,'interview.json'),JSON.stringify(journal));
  execFileSync(process.execPath,['scripts/summarize-continuous-pressure.mjs',directory],{stdio:'pipe'});
  const report=JSON.parse(await readFile(path.join(directory,'pressure-audit.json')));
  assert.equal(report.clocksValid,true);assert.equal(report.rows.length,2);
  assert.deepEqual(report.rows[0].firstVisibleWord.latencyMs,{low:190,high:200});
  assert.equal(report.rows[0].sourceSegmentAssignment,null);
  assert.equal(report.summary.cancelled,1);assert.equal(report.summary.missingVisibleWords,1);
  assert.equal(report.independentAssessmentPending,true);assert.equal(report.targetCertified,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});
