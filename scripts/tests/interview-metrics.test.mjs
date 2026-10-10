import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {distribution,difference,transcriptWordError,qualitySummary,counterSummary,verifiedReviewFindings} from '../lib/interview-metrics.mjs';

test('missing observations stay unknown and early overlap remains negative',()=>{
  assert.equal(difference(null,10),null);
  assert.equal(difference(5,10),-5);
  assert.deepEqual(distribution([null,undefined,NaN,-5,10]),{count:2,median:2.5,sampleP95:10,max:10});
  assert.deepEqual(counterSummary([{restarts:null},{restarts:0},{restarts:2}],'restarts'),{assessed:2,total:2,roundsWithAny:1});
  assert.equal(counterSummary([{restarts:null}],'restarts').total,null);
});

test('lexical edits detect substitution, insertion and deletion without treating formatting as an error',()=>{
  assert.equal(transcriptWordError('A fast, GPU!','a fast gpu').rate,0);
  assert.equal(transcriptWordError('a b c','a x c').edits,1);
  assert.equal(transcriptWordError('a b c','a c').edits,1);
  assert.equal(transcriptWordError('a b c','a b x c').edits,1);
  assert.equal(transcriptWordError('', 'extra'),null);
  assert.equal(transcriptWordError('a',null),null);
});

test('model grade denominators exclude pending reviews but include graded ignored requests',()=>{
  const quality=qualitySummary([
    {modelGrade:'correct',constraintTracking:true,transcriptWordError:{referenceWords:3,edits:1}},
    {modelGrade:'incorrect',ignored:true,constraintTracking:false,transcriptWordError:{referenceWords:7,edits:1}},
    {modelGrade:null},
  ]);
  assert.equal(quality.graded,2);
  assert.equal(quality.ungraded,1);
  assert.equal(quality.modelGradedCorrectRate,.5);
  assert.deepEqual(quality.constraintTracking,{assessed:2,true:1,false:1});
  assert.equal(quality.lexicalAsr.normalizedWordErrorRate,.2);
});

test('a selective review cannot silently attach to a different recorded answer',()=>{
  const hash = text=>createHash('sha256').update(text).digest('hex');
  const report={rows:[{round:1,question:'q',answer:'a'},{round:2,question:'other',answer:'untested'}]};
  const review={findings:[{round:1,questionSha256:hash('q'),answerSha256:hash('a')}]};
  assert.equal(verifiedReviewFindings(report,review).roundsWithFindings,1);
  assert.equal(verifiedReviewFindings(report,null),null);
  assert.throws(()=>verifiedReviewFindings({...report,rows:[{round:1,question:'q',answer:'changed'}]},review),/identity mismatch/);
});
