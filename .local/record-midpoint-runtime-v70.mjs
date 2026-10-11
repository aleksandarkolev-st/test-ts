import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pcmData} from '../scripts/lib/rapid-wave.mjs';
const base='artifacts/deep-interview-v70/hard-probes/long-question-essential-tail-midpoint-pause';
const file=`${base}/interview.json`,bytes=await readFile(file),j=JSON.parse(bytes);
assert(j.status==='complete'&&j.stoppedCleanly&&j.rows.length===1);
const r=j.rows[0],id=r.responseVersion.split(':')[0],wave=await readFile(`${base}/${r.audio.waveFile}`);
const hash=b=>createHash('sha256').update(b).digest('hex');assert.equal(hash(wave),r.audio.sha256);
const pcm=pcmData(wave),pause=r.audio.waveformEvidence.requestedPause;
let first=-1,last=-1;
for(let i=0;i<pcm.length/2;i++){if(pcm.readInt16LE(i*2)!==0){if(first<0)first=i;last=i;}}
for(let i=pause.pauseStartFrame;i<pause.pauseEndFrame;i++)assert.equal(pcm.readInt16LE(i*2),0);
assert.equal(pause.pauseEndFrame-pause.pauseStartFrame,24000);
assert.equal(r.audio.playback.lastNonzeroFrame,last+1);
const before=(pause.pauseStartFrame-first)/16,after=(last+1-pause.pauseEndFrame)/16;
const endpoint={low:r.audio.playback.lastVoicedDevicePositionLowerHostMs,high:r.audio.playback.lastVoicedDevicePositionUpperHostMs};
const paints=j.overlayPaintSamples.filter(p=>p.questionId===id&&p.recorderVersion===2&&p.visible&&p.visibleEnd>p.visibleStart);
const observedComplete=j.deepObservations.flatMap(o=>(o.jobs??[]).filter(job=>job.question.id===id&&job.latency?.completedAt!=null).map(job=>({hostBeforeMs:o.hostBeforeMs,hostAfterMs:o.hostAfterMs,nativeCompletedAt:job.latency.completedAt,phase:job.phase,revision:job.latency.responseRevision})));
const offsets=r.audio.clockAnchors.map(a=>({low:a.hostBeforeMs-a.nativeMs,high:a.hostAfterMs-a.nativeMs}));
const offset={low:Math.min(...offsets.map(o=>o.low)),high:Math.max(...offsets.map(o=>o.high))};
const completion={low:r.latency.completedAt+offset.low,high:r.latency.completedAt+offset.high};
const report={recordedAt:new Date().toISOString(),journal:{file,sha256:hash(bytes)},model:j.model,effort:j.effort,
 outputDevice:j.outputDevice,speechConfiguration:j.speechConfiguration,wave:{file:`${base}/${r.audio.waveFile}`,sha256:hash(wave),frames:pcm.length/2,durationMs:pcm.length/32,
 durationWithoutPauseMs:pcm.length/32-1500,firstNonzeroFrame:first,lastNonzeroFrame:last,pauseStartFrame:pause.pauseStartFrame,pauseEndFrame:pause.pauseEndFrame,exactZeroPauseMs:1500,
 prefixVoicedSpanMs:before,tailVoicedSpanMs:after,prefixFractionOfVoicedSpan:before/(before+after)},
 sourceQuestion:r.question,recognizedQuestion:r.recognizedQuestion,answer:r.answer,answerSha256:hash(r.answer),phase:r.phase,error:r.error,cancelled:r.cancelled,
 physicalVoicedEndHostBounds:endpoint,visiblePaintsAllRevisions:paints.length,visibleRevisions:[...new Set(paints.map(p=>p.revision))],
 firstObservedVisiblePaintHostMs:paints[0]?.hostMs??null,visiblePaintsBeforeFullVoicedEndpoint:paints.filter(p=>p.hostMs<endpoint.low).length,
 nativeCompletionHostBoundsFromRecordedAnchors:completion,completionDefinitelyAfterFullVoicedEndpoint:completion.low>endpoint.high,
 firstCompleteJobObservation:observedComplete[0]??null,completeJobObservationsBeforeFullVoicedEndpoint:observedComplete.filter(o=>o.hostAfterMs<endpoint.low).length,
 answerCompletedEventsForQuestion:r.events.filter(e=>e.name==='answer.completed'&&e.payload.id===id).length,
 hiddenFirstAgentDeltaNativeMs:r.latency.pipeline.firstAgentDelta,visibleFirstRetainedWord:r.firstStreamedWordMeasurement.firstRetainedVisibleStreamedWord,
 manualConditionCheck:{finalSigned64Range:true,exactFullBatchAccumulation:true,rejectOverflowWithoutWrappingOrPartialSum:true,allowsIntermediateCancellation:true,
 scope:'Manual reading of this retained answer; independent model review remains separate. No executable implementation was requested in this turn.'},
 scope:'Actual waveform bytes and every recorded visible paint revision for this question, with native completion mapped through recorded clock anchors. No early visible answer or completed native answer was observed before the entire source question ended. Hidden speculation is recorded separately. Polling cannot establish every unsampled instant; the gap has no device-position host marker, so nominal PCM timing is not presented as an exact host pause timestamp. No microphone or production changes.'};
assert.equal(report.visiblePaintsBeforeFullVoicedEndpoint,0);assert.equal(report.completeJobObservationsBeforeFullVoicedEndpoint,0);assert(report.completionDefinitelyAfterFullVoicedEndpoint);
await writeFile('docs/evidence/midpoint-pause-recording-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({durationMs:report.wave.durationMs,prefixFraction:report.wave.prefixFractionOfVoicedSpan,visiblePaints:paints.length,earlyVisiblePaints:0,completionAfterFullQuestion:true,firstWord:report.visibleFirstRetainedWord.latencyMs}));
