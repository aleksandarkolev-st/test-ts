import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex'),file='docs/evidence/architecture-systems-r36-missing-word-v71.json',raw=await readFile(file),row=JSON.parse(raw),p=row.pipeline;
assert.equal(row.answer,'');assert.equal(row.latency.firstWordAt,null);assert.equal(p.retainedFirstDelta,null);assert.equal(p.firstVisible,null);assert(row.error);
const offsets=row.audioClockAnchors.map(a=>({low:a.nativeMs-a.hostAfterMs,high:a.nativeMs-a.hostBeforeMs}));
const offset={low:Math.max(...offsets.map(a=>a.low)),high:Math.min(...offsets.map(a=>a.high))};assert(offset.low<=offset.high);
const endpoint={low:row.audioPlayback.lastVoicedDevicePositionLowerHostMs+offset.low,high:row.audioPlayback.lastVoicedDevicePositionUpperHostMs+offset.high};
const timingFile='scripts/summarize-deep-audio-duration.mjs',timing=await readFile(timingFile),wordFile='scripts/lib/streamed-word-latency.mjs',words=await readFile(wordFile);
assert(timing.toString().includes('l?.firstWordAt==null||l?.speechStoppedAt==null?null'));
assert(words.toString().includes('measurements.find(m=>m.retainedInCurrentRecordedAnswer)??null'));
const report={recordedAt:new Date().toISOString(),evidence:{file,sha256:hash(raw)},sourceHashes:{[timingFile]:hash(timing),[wordFile]:hash(words)},
 round:row.round,responseVersion:row.responseVersion,question:row.question,phase:row.phase,cancelled:row.cancelled,error:row.error,
 answerCharacters:row.answer.length,retainedVisibleWordLatencyMs:null,latestInputReaderReceived:p.latestInputReaderReceived,latestInputConsumed:p.latestInputConsumed,
 durationsMs:{confirmedToLastSend:p.latestInputSent-p.questionConfirmed,lastSendToAcknowledgement:p.latestInputAck-p.latestInputSent,
  lastSendToCleanupStart:p.cleanupStartedAt-p.latestInputSent,physicalEndpointToRecordedCompletion:{low:row.latency.completedAt-endpoint.high,high:row.latency.completedAt-endpoint.low}},
 scope:'An empty retained answer cannot contain a retained visible word, regardless of earlier provisional paint frames. The console diagnostic subtracts from null and prints a negative number; the duration summarizer explicitly returns null for an unset first-word timestamp, and the primary retained-word metric uses actual paint plus retained text. This failed recorded answer remains in the row/accuracy/error denominators and is a missing retained-word observation, not a negative, zero or successful response-time measurement. Earlier obsolete visible words, if any, are a separate measurement requiring the completed journal. Final journal binding and independent review remain pending.',
 finalJournalBindingPending:true,independentAccuracyPending:true,goalComplete:false};
const output='docs/evidence/missing-word-timeout-v71.json';await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({output,error:report.error,durationsMs:report.durationsMs,retainedVisibleWordLatencyMs:null}));
