import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const hash=text=>createHash('sha256').update(text).digest('hex');
const tool=path.resolve('scripts/summarize-deep-audio-interview.mjs');
test('measurement keeps offscreen, revised, cancelled and incorrect trials in the denominator',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'deep-assessment-'));
 try{
  const answer='The sum is 43. This claim needs further qualification.';
  const rows=Array.from({length:5},(_,i)=>({round:i+1,policy:'existing',question:'What is the sum?',
   recognizedQuestion:'What is the sum?',answer,selectedContext:'Only public prior conversation.',phase:'complete',
   responseVersion:`question-${i}:2`,cancelled:i===3,
   audio:{playback:{lastVoicedDevicePositionLowerHostMs:1000,lastVoicedDevicePositionUpperHostMs:1010},
    clockAnchors:[{hostBeforeMs:500,hostAfterMs:510,nativeMs:100}]},latency:{firstWordAt:1100}}));
  const samples=rows.flatMap((row,i)=>[
   {recorderVersion:2,questionId:`question-${i}`,revision:1,hostMs:1100,text:answer,visible:true,visibleStart:0,visibleEnd:answer.length},
   {recorderVersion:i===2?1:2,questionId:`question-${i}`,revision:2,hostMs:1400,text:answer,
    visible:true,visibleStart:i===1?20:0,visibleEnd:answer.length}
  ]);
  const journal=path.join(directory,'journal.json'),reviews=path.join(directory,'reviews'),output=path.join(directory,'output');
  await mkdir(reviews);
  await writeFile(journal,JSON.stringify({status:'complete',stoppedCleanly:true,rows,overlayPaintSamples:samples}));
  for(const [i,row] of rows.entries()){
   const input={answer:row.answer,phase:row.phase,publicPriorContext:row.selectedContext,
    recognizedQuestion:row.recognizedQuestion,spokenQuestion:row.question};
   await writeFile(path.join(reviews,`trial-${String(i+1).padStart(3,'0')}.json`),JSON.stringify({inputSha256:hash(JSON.stringify(input)),
    review:{verdict:i===4?'incorrect':'correct',usefulPhrase:'The sum is 43.'}}));
  }
  execFileSync(process.execPath,[tool,journal,reviews,output],{stdio:'pipe'});
  const result=JSON.parse(await readFile(path.join(output,'assessment.json')));
  assert.deepEqual(result.rows[0].visibleRetainedPhraseLatencyMs,{low:390,high:400});
  assert.equal(result.rows[1].visiblePhraseMissingReason,'selected_phrase_not_observed_as_visible_retained_text');
  assert.equal(result.rows[2].visiblePhraseMissingReason,'viewport_visibility_unverified');
  assert.equal(result.rows[3].visiblePhraseMissingReason,'cancelled_answer');
  assert.deepEqual(result.rows[4].visibleRetainedPhraseLatencyMs,{low:390,high:400});
  assert.equal(result.summary.existing.evaluatedTurns,5);
  assert.equal(result.summary.existing.finitePhraseLatency.count,2);
  assert.equal(result.summary.existing.missingPhraseMeasurements,3);
  assert.equal(result.summary.existing.under800MsJointProvisionalSuccesses,1);
  assert.equal(result.summary.existing.successFraction,.2);
  assert.equal(result.targetCertified,false);
  // A changed answer must invalidate an existing independent review.
  rows[0].answer='A different answer.';
  await writeFile(journal,JSON.stringify({status:'complete',stoppedCleanly:true,rows,overlayPaintSamples:samples}));
  assert.throws(()=>execFileSync(process.execPath,[tool,journal,reviews,path.join(directory,'stale')],{stdio:'pipe'}),/does not match recorded input/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
