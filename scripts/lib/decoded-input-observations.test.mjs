import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodedInputObservations} from './decoded-input-observations.mjs';
const contextKey=Array(32).fill(7),event=payload=>({payload});
const frame={id:'job',revision:2,question:'x < Y',contextKey};
const prefix=overrides=>event({...frame,revision:0,firstWordObservedAt:50,...overrides});
const row=prefixes=>({responseVersion:'job:2',recognizedQuestion:' x  < Y ',receivedFrames:[event(frame)],provisionalPrefixes:prefixes});

test('earlier job, operators, case and changed context cannot supply matching latency',()=>{
 const result=decodedInputObservations(row([
  prefix({id:'old',firstWordObservedAt:1}),prefix({question:'x > Y',firstWordObservedAt:2}),
  prefix({question:'x < y',firstWordObservedAt:3}),prefix({contextKey:Array(32).fill(8),firstWordObservedAt:4}),prefix({})]));
 assert.equal(result.firstDecoded,50);assert.equal(result.differentContextObservations,1);
});
test('missing, null or malformed digests remain unknown even on both sides',()=>{
 for(const missing of [undefined,null,[],Array(32).fill(-1)]){
  const result=decodedInputObservations({...row([prefix({contextKey:missing})]),receivedFrames:[event({...frame,contextKey:missing})]});
  assert.equal(result.firstDecoded,null);assert.equal(result.unknownContextObservations,1);
 }
});
test('missing retained frame stays unknown and conflicting recognized input fails',()=>{
 assert.equal(decodedInputObservations({...row([prefix({})]),receivedFrames:[]}).firstDecoded,null);
 assert.throws(()=>decodedInputObservations({...row([]),recognizedQuestion:'x > Y'}),/differs/);
});
