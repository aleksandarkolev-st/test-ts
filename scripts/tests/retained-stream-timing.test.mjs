import assert from 'node:assert/strict';
import test from 'node:test';
import {retainedStreamTiming} from '../lib/retained-stream-timing.mjs';
test('retained timing excludes replaced text and requires a complete first word',()=>{
 const events=[{atMs:1,delta:'Obsolete answer. '},{atMs:10,revision:''},{atMs:12,delta:'No'},
  {atMs:14,delta:', the wait is a no-op.'}];
 assert.deepEqual(retainedStreamTiming(events,'No, the wait is a no-op.','the wait is a no-op.'),
  {firstRetainedTextMs:12,firstRetainedWordMs:14,firstRetainedPhraseMs:14,phraseCharacterRange:[4,24]});
});
test('missing phrase and unfinished word remain missing',()=>{
 assert.deepEqual(retainedStreamTiming([{atMs:3,delta:'Unfinished'}],'Unfinished','absent'),
  {firstRetainedTextMs:3,firstRetainedWordMs:null,firstRetainedPhraseMs:null,phraseCharacterRange:null});
});
test('replacement callback can itself contain the first retained useful clause',()=>{
 assert.equal(retainedStreamTiming([{atMs:8,revision:'Use 53 blocks.'}],'Use 53 blocks.','53 blocks.').firstRetainedPhraseMs,8);
});
test('a replaced revision with the same prefix cannot supply final-revision timing',()=>{
 const events=[{atMs:2,delta:'Use '},{atMs:9,revision:''},{atMs:12,delta:'Use 53 blocks.'}];
 assert.equal(retainedStreamTiming(events,'Use 53 blocks.').firstRetainedWordMs,12);
});
