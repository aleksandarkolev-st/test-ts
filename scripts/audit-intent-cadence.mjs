// Descriptive recorded timings, never semantic labels or future-input reuse.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const directory=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&directory.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));
const raw=await readFile(path.join(directory,'interview.json')),run=JSON.parse(raw);
assert.equal(run.status,'complete');assert.equal(run.stoppedCleanly,true);
assert.equal(run.provisionalDiagnostics?.enabled,true);
const identity=text=>typeof text==='string'?text.split(/\s+/u).join(' ').trim():null;
const delta=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)?end-start:null;
const rounds=run.rows.map(row=>{
 const floor=row.latency.remoteSpeechStartedAt,finalText=identity(row.recognizedQuestion);
 const full=(row.candidateObservations??[]).map(event=>event.payload)
  .filter(event=>event.floor===floor&&identity(event.text)===finalText).sort((a,b)=>a.observedAt-b.observedAt)[0];
 const submitted=row.intentEvents.filter(event=>event.name==='intent.input_submitted'&&event.payload.input.floor===floor)
  .map(event=>event.payload).sort((a,b)=>a.submittedAt-b.submittedAt);
 assert(submitted.length,'Require exact native classifier-input trace');
 const exact=submitted.find(event=>identity(event.input.text)===finalText);
 const predictions=row.intentEvents.filter(event=>event.name==='intent.predicted').map(event=>event.payload);
 const predicted=exact?predictions.find(event=>event.prediction.id===exact.input.id):null;
 const starts=row.intentEvents.filter(event=>event.name==='intent.early_input').map(event=>event.payload);
 const bypasses=submitted.flatMap((entry,index)=>{
  if(!entry.quietPriorityBypass)return [];
  assert(entry.remoteQuiet&&!entry.selfSpeaking,'Priority bypass must occur during remote acoustic quiet');
  const interval=index?entry.submittedAt-submitted[index-1].submittedAt:null;
  if(interval!==null)assert(interval>=0&&interval<250,'A reported bypass must precede ordinary cadence');
  return [{id:entry.input.id,text:entry.input.text,submittedFromSpeechEndMs:entry.submittedAt-row.speechEndNativeMs,
   sincePreviousSubmissionMs:interval}];
 });
 return {round:row.round,firstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,
  completeRecognizedTextFirstObservedFromEndMs:delta(full?.observedAt,row.speechEndNativeMs),
  firstExactSubmissionFromEndMs:delta(exact?.submittedAt,row.speechEndNativeMs),
  firstCompleteObservedToSubmissionMs:delta(exact?.submittedAt,full?.observedAt),
  firstExactPredictionFromEndMs:delta(predicted?.prediction.observedAt,row.speechEndNativeMs),
  firstExactPredictionAccepted:predicted?.accepted??null,firstExactPredictionScores:predicted?.prediction.scores??null,
  earlyStarts:starts.map(entry=>({...entry,fromSpeechEndMs:entry.timestamp-row.speechEndNativeMs})),
  submissions:submitted.length,quietPriorityBypasses:bypasses};
});
const report={scope:'Recorded complete recognized-text availability versus classification submission and received prediction. Complete here means identity with eventual recognized input, not semantic completeness, intended-speech fidelity or correctness. Earliest matching text might subsequently change. Cadence intervals are descriptive; new text and context can invalidate results. Submission quiet flags do not reconstruct every acoustic pause. No counterfactual first-word latency is inferred.',
 source:{file:path.relative(process.cwd(),path.join(directory,'interview.json')),sha256:createHash('sha256').update(raw).digest('hex')},
 classifier:run.intentClassifier,sourceHashes:run.sourceHashes,intentSourceHashes:run.intentSourceHashes,
 summary:{rounds:rounds.length,submissions:rounds.reduce((sum,row)=>sum+row.submissions,0),
  quietPriorityBypasses:rounds.reduce((sum,row)=>sum+row.quietPriorityBypasses.length,0)},rounds};
await writeFile(path.join(directory,'intent-cadence-audit.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report.summary));
