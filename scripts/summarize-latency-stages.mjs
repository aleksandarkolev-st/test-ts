import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const directory=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&directory.startsWith(process.cwd()+path.sep),'Supply a workspace interview artifact directory');
const report=JSON.parse(await readFile(path.join(directory,'interview.json'),'utf8'));
const difference=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)?end-start:null;
const rows=report.rows.filter(row=>row.latency&&Number.isFinite(row.latency.firstWordAt)).map(row=>{
  const l=row.latency,p=l.pipeline??{},end=row.speechEndNativeMs;
  return {
    round:row.round,
    fullRecognizedClauses:row.preservesAllRecognizedClauses,
    firstWordFromSpeechEndMs:difference(l.firstWordAt,end),
    asrFinalizationFromSpeechEndMs:difference(l.transcriptFinalAt,end),
    confirmationAfterAsrMs:difference(l.questionConfirmedAt,l.transcriptFinalAt),
    foregroundSlotWaitMs:difference(p.semaphoreAcquired,p.codexStreamEntered),
    preparedThreadWaitMs:difference(p.warmThreadTaken,p.semaphoreAcquired),
    initialStartAcknowledgementMs:difference(p.turnStartAck,p.turnStartSent),
    latestInputSentAfterConfirmationMs:difference(p.latestInputSent,l.questionConfirmedAt),
    latestInputConsumptionWaitMs:difference(p.latestInputConsumed,p.latestInputSent),
    firstWordAfterLatestInputConsumptionMs:difference(l.firstWordAt,p.latestInputConsumed),
    renderAfterFirstWordMs:difference(p.firstVisible,l.firstWordAt),
    cleanupMs:difference(p.cleanupTerminalAt,p.cleanupStartedAt),
    restarts:p.refinementRestartCount??0,
    steers:p.steeringCount??0,
    followups:p.followupCount??0,
    promptChars:p.promptChars??null,
    refinementChars:p.refinementChars??null,
  };
});
assert(rows.length,'No first-word timing evidence');
const metrics=Object.keys(rows[0]).filter(key=>key.endsWith('Ms'));
const summary=Object.fromEntries(metrics.map(key=>{
  const values=rows.map(row=>row[key]).filter(Number.isFinite).sort((a,b)=>a-b);
  const mid=Math.floor(values.length/2);
  return [key,{count:values.length,median:values.length?(values[mid]+values[Math.floor((values.length-1)/2)])/2:null,max:values.at(-1)??null}];
}));
const value={
  status:report.status,
  stoppedCleanly:report.stoppedCleanly,
  model:report.model,effort:report.effort,tier:report.tier,
  speechConfiguration:report.speechConfiguration,
  scope:'Recorded client-received retained first word, not whole-answer completion or internal generation. Stages can overlap under speculation; negative input-after-confirmation values indicate input sent earlier. These intervals must not be summed as independent costs. The post-consumption interval includes cloud inference, transport, framing and local delivery; it does not isolate model compute. Small descriptive samples, not broad p95 or correctness certification.',
  rows,summary,
};
await writeFile(path.join(directory,'latency-stage-audit.json'),JSON.stringify(value,null,2));
console.log(JSON.stringify(value,null,2));
