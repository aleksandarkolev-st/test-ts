// Offline diagnosis only. Input identity never authorizes answer reuse/display.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {decodedInputObservations} from './lib/decoded-input-observations.mjs';

const flags=process.argv.slice(2),snapshot=flags.includes('--snapshot');
const [source,destination]=flags.filter(arg=>arg!=='--snapshot');
assert(source&&destination,'Usage: node scripts/analyze-answer-latency.mjs JOURNAL OUTPUT [--snapshot]');
const inside=file=>{const p=path.resolve(file);assert(p.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));return p;};
const bytes=await readFile(inside(source)),report=JSON.parse(bytes);
if(!snapshot)assert(['complete','failed'].includes(report.status)&&report.stoppedCleanly,'Require clean terminal evidence or explicit --snapshot');
const exact=text=>typeof text==='string'?text.trim().replace(/\s+/gu,' '):null;
const diff=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?a-b:null;
const rows=report.rows.map(row=>{
 const l=row.latency??{},p=l.pipeline??{},end=row.speechEndNativeMs;
 const {frame,firstDecoded,differentContextObservations,unknownContextObservations}=decodedInputObservations(row);
 const observed=(row.candidateObservations??[]).map(event=>event.payload).filter(event=>event.floor===l.remoteSpeechStartedAt&&Number.isFinite(event.observedAt)&&typeof event.text==='string'&&event.text.trim()&&(!Number.isFinite(l.questionConfirmedAt)||event.observedAt<=l.questionConfirmedAt)).sort((a,b)=>a.observedAt-b.observedAt);
 const same=event=>exact(event.text)===exact(row.recognizedQuestion);
 const firstExact=observed.find(same)?.observedAt;
 const lastDifferent=observed.findLast(event=>!same(event));
 const stableExact=observed.find(event=>same(event)&&(!lastDifferent||event.observedAt>lastDifferent.observedAt))?.observedAt;
 return {round:row.round,ignored:row.ignored,question:row.question,recognizedQuestion:row.recognizedQuestion,
  modelVerdict:row.review?.verdict??null,responseVersion:row.responseVersion??null,
  fullRecognizedClauses:row.preservesAllRecognizedClauses??null,retainedFrameObserved:Boolean(frame),
  nativeSpeechEndAt:end,firstWordAt:l.firstWordAt??null,
  firstWordFromSpeechEndMs:diff(l.firstWordAt,end),firstWordFromLatestInputMs:diff(l.firstWordAt,p.latestInputSent),
  asrFinalizationMs:diff(l.transcriptFinalAt,end),confirmationAfterAsrMs:diff(l.questionConfirmedAt,l.transcriptFinalAt),
  firstExactCandidateAt:firstExact??null,lastDifferentCandidateAt:lastDifferent?.observedAt??null,stableExactCandidateAt:stableExact??null,
  stableRecognizedTextFromSpeechEndMs:diff(stableExact,end),stableRecognizedTextBeforeAsrFinalMs:diff(l.transcriptFinalAt,stableExact),
  latestInputAfterStableRecognizedTextMs:diff(p.latestInputSent,stableExact),latestInputConsumptionMs:diff(p.latestInputConsumed,p.latestInputSent),
  firstWordAfterLatestConsumptionMs:diff(l.firstWordAt,p.latestInputConsumed),
  firstDecodedMatchingInputAt:Number.isFinite(firstDecoded)?firstDecoded:null,
  firstDecodedMatchingInputFromSpeechEndMs:diff(firstDecoded,end),retainedAfterFirstMatchingDecodedMs:diff(l.firstWordAt,firstDecoded),
  sameQuestionDifferentContextObservations:differentContextObservations,sameQuestionUnknownContextObservations:unknownContextObservations,
  foregroundSlotWaitMs:diff(p.semaphoreAcquired,p.codexStreamEntered),preparedThreadWaitMs:diff(p.warmThreadTaken,p.semaphoreAcquired),
  renderAfterRetainedMs:diff(p.firstVisible,l.firstWordAt),restarts:p.refinementRestartCount??0,steers:p.steeringCount??0,followups:p.followupCount??0,
  promptChars:p.promptChars??null,refinementChars:p.refinementChars??null};
});
const metrics=Object.keys(rows[0]??{}).filter(key=>key.endsWith('Ms'));
const distribution=key=>{const values=rows.map(row=>row[key]).filter(Number.isFinite).sort((a,b)=>a-b),n=values.length;return {count:n,median:n?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null,sampleP95:n?values[Math.ceil(n*.95)-1]:null,max:values.at(-1)??null};};
const result={recordedAt:new Date().toISOString(),source:{file:source,sha256:createHash('sha256').update(bytes).digest('hex'),status:report.status,stoppedCleanly:report.stoppedCleanly??null},
 snapshot,model:report.model,effort:report.effort,tier:report.tier,realAudio:report.realAudio,intentMode:report.intentMode,speechConfiguration:report.speechConfiguration,
 scope:'Retrospective client-received retained first alphanumeric character, no word/sentence completion wait. Explicit live snapshots are partial evidence, not completed interviews. Whitespace-only identity preserves operators/case. Stable recognized wording means no later observed different nonempty candidate before confirmation on this acoustic floor; it is not proof of request completeness, ASR fidelity, current context identity, or future stability. Matching decoded input compares job, question and context digest, not response-generation identity or text compatibility. It does not isolate protocol decoding cost or authorize reuse. Stages can overlap and must not be added as independent costs. Post-consumption duration includes model, network, framing and delivery, not pure compute. Sample p95 is descriptive, not population certification.',
 sourceHashes:report.sourceHashes,diagnosticSourceHashes:report.diagnosticSourceHashes,nativeBinarySha256:report.nativeBinarySha256,
 rows,summary:Object.fromEntries(metrics.map(key=>[key,distribution(key)])),targetAchieved:false};
result.analysisToolSha256=Object.fromEntries(await Promise.all(['scripts/analyze-answer-latency.mjs','scripts/lib/decoded-input-observations.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(inside(file))).digest('hex')])));
await mkdir(path.dirname(inside(destination)),{recursive:true});await writeFile(inside(destination),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({output:destination,status:report.status,snapshot,rounds:rows.length,summary:result.summary}));
