// Offline exact-input diagnosis. No automatic labels or production routing.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const directory=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&directory.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));
const bytes=await readFile(path.join(directory,'interview.json')),report=JSON.parse(bytes);
const incomplete=process.argv.includes('--allow-incomplete');
assert(report.status==='complete'||(incomplete&&report.status==='failed'),'Require a terminal run; incomplete evidence needs an explicit flag');
assert.equal(report.stoppedCleanly,true);
assert.equal(report.provisionalDiagnostics?.enabled,true);
const identity=text=>typeof text==='string'?text.split(/\s+/u).join(' ').trim():null;
const threshold=report.intentClassifier?.threshold;assert(Number.isFinite(threshold));
const rounds=report.rows.map(row=>{
  const submitted=new Map((row.intentEvents??[]).filter(e=>e.name==='intent.input_submitted').map(e=>[e.payload.input.id,e.payload]));
  assert(submitted.size>0,'Run with exact submitted-input diagnostics');
  const predictions=(row.intentEvents??[]).filter(e=>e.name==='intent.predicted');
  const entries=predictions.map(event=>{
    const p=event.payload.prediction,input=submitted.get(p.id);
    if(!input)return {id:p.id,missingSubmission:true,prediction:p,accepted:event.payload.accepted};
    const ready=!p.abstained&&p.scores?.request>=threshold&&p.scores?.ready>=threshold;
    return {id:p.id,floor:input.input.floor,text:input.input.text,context:input.input.context,
      submittedAt:input.submittedAt,predictedAt:p.observedAt,
      inputToObservedPredictionMs:p.observedAt-input.submittedAt,workerElapsedMs:p.elapsedMs,
      remoteQuietAtSubmission:input.remoteQuiet,remoteSpeakingAtSubmission:input.remoteSpeaking,
      selfSpeakingAtSubmission:input.selfSpeaking,accepted:event.payload.accepted,
      abstained:p.abstained,scores:p.scores,aboveReadyThreshold:Boolean(ready),
      exactFinalRecognizedText:input.input.floor===row.latency?.remoteSpeechStartedAt&&identity(input.input.text)===identity(row.recognizedQuestion),
      submittedFromSpeechEndMs:input.submittedAt-row.speechEndNativeMs,
      predictedFromSpeechEndMs:p.observedAt-row.speechEndNativeMs};
  });
  return {round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,
    firstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,entries,
    earlyStarts:row.intentEvents.filter(e=>e.name==='intent.early_input').map(e=>e.payload)};
});
const entries=rounds.flatMap(row=>row.entries),complete=entries.filter(e=>!e.missingSubmission);
assert(complete.length>0);
const count=predicate=>complete.filter(predicate).length;
const audit={scope:'Exact submitted classifier text/context joined to received scores. Threshold crossings are predictions, not semantic truth. Submission acoustic flags do not establish eligibility at prediction receipt or later ticks. Exact final text is recognized input identity, not intended-speech fidelity or correctness. No automatic labels, trained-model promotion or prefix reuse are authorized.',
  source:{file:path.relative(process.cwd(),path.join(directory,'interview.json')),sha256:createHash('sha256').update(bytes).digest('hex'),
    status:report.status,requestedRounds:report.rounds,recordedRounds:report.rows.length,failure:report.failure??null},
  classifier:report.intentClassifier,sourceHashes:report.sourceHashes,intentSourceHashes:report.intentSourceHashes,
  diagnosticSourceHashes:report.diagnosticSourceHashes,speechConfiguration:report.speechConfiguration,
  summary:{predictions:entries.length,missingSubmissions:entries.length-complete.length,
    stale:count(e=>!e.accepted),abstained:count(e=>e.abstained),
    acceptedAboveReadyThreshold:count(e=>e.accepted&&e.aboveReadyThreshold),
    acceptedExactFinalAboveReadyThreshold:count(e=>e.accepted&&e.aboveReadyThreshold&&e.exactFinalRecognizedText)},rounds};
await writeFile(path.join(directory,'intent-stream-audit.json'),JSON.stringify(audit,null,2));
console.log(JSON.stringify(audit.summary));
