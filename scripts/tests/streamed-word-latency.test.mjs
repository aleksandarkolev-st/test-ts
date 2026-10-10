import test from 'node:test';
import assert from 'node:assert/strict';
import {streamedWordLatency} from '../lib/streamed-word-latency.mjs';

test('measures a streaming word before answer completion and keeps discarded revisions separate',()=>{
 const row={responseVersion:'q:2',answer:'No. A complete answer follows.',phase:'confirmed',
  audio:{playback:{lastVoicedDevicePositionLowerHostMs:1000,lastVoicedDevicePositionUpperHostMs:1010}}};
 const paint=(hostMs,text,revision,visibleStart=0)=>({hostMs,text,revision,questionId:'q',recorderVersion:2,
  visible:true,visibleStart,visibleEnd:text.length,streaming:true});
 const journal={overlayPaintSamples:[paint(1015,'Y',1),paint(1020,'Yes ',1),paint(1100,'N',2),paint(1200,'No. ',2)],
  deepObservations:[{jobs:[{question:{id:'q'},answer:row.answer,phase:'confirmed',running:true,latency:{responseRevision:2}}]}]};
 const measured=streamedWordLatency(journal,row);
 assert.equal(measured.firstVisibleStreamedWord.word,'Yes');
 assert.deepEqual(measured.firstVisibleStreamedWord.latencyMs,{low:10,high:20});
 assert.equal(measured.firstRetainedVisibleStreamedWord.word,'No');
 assert.deepEqual(measured.firstRetainedVisibleStreamedWord.latencyMs,{low:190,high:200});
 assert.equal(measured.phase,'confirmed');
 journal.overlayPaintSamples=[{...paint(1400,row.answer,2),streaming:false}];
 assert.equal(streamedWordLatency(journal,row).firstVisibleStreamedWord.word,'No');
 assert.equal(streamedWordLatency(journal,row).firstWordHiddenUntilAfterStreaming,true);
 assert.equal(streamedWordLatency(journal,row).firstWordVisibleWhileStillStreaming,null);
 journal.overlayPaintSamples=[paint(1200,'No. A complete answer follows.',2,4)];
 assert.equal(streamedWordLatency(journal,row).firstVisibleStreamedWord,null);
});
