import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='src-tauri/src/openai/codex.rs';
const bytes=await readFile(file),source=bytes.toString('utf8');
const sha256=data=>createHash('sha256').update(data).digest('hex');
const stageFile='artifacts/deep-interview-v70/hard-probes/deep-code-memory/round-09-latency-stage-audit.json';
const stage=JSON.parse(await readFile(stageFile));
const summaryFile='docs/evidence/answer-architecture-audit-corrected-v70.json';
const summary=JSON.parse(await readFile(summaryFile));
const journalBytes=await readFile(stage.source),journal=JSON.parse(journalBytes);
assert.equal(sha256(journalBytes),stage.journalSha256);
assert.equal(journal.sourceHashes[file],sha256(bytes));
const lines=source.split('\n');
const references=[
 {needle:'&& pending_question.is_none() {',finding:'Changed confirmed input is sent only when the prior pending input has cleared.'},
 {needle:'reuse,false,Some(corrected.context)',finding:'The second attempt disables restart_stalled; the outer function retries only once.'},
 {needle:'if restart_stalled&&!terminal_pending&&!consumption_pending',finding:'The pending-final deadline can trigger refinement retirement only while restart_stalled is enabled.'},
 {needle:'pending_question.take().unwrap()',finding:'A matching completed userMessage event clears the pending update and activates its question/context frame.'}
 ].map(({needle,finding})=>{
  const line=lines.findIndex(text=>text.includes(needle));assert(line>=0,`Missing source evidence: ${needle}`);
  return {file,line:line+1,source:lines[line].trim(),finding};
 });
const record={recordedAt:new Date().toISOString(),source:{file,sha256:sha256(bytes)},references,
 representativeTrace:{file:stageFile,journalSha256:stage.journalSha256,round:stage.round,
  physicalEndpointNativeMs:stage.physicalEndpointNativeMs,visibleWord:stage.metric,stages:stage.stages,
  counters:{restarts:stage.pipeline.refinementRestartCount,steers:stage.pipeline.steeringCount,followups:stage.pipeline.followupCount},
  textSizes:{initialPromptChars:stage.pipeline.promptChars,restartPromptChars:stage.pipeline.restartPromptChars,totalRefinementChars:stage.pipeline.refinementChars}},
 completedRecordings:{file:summaryFile,summary:summary.summary},
 conclusion:'The recorded final question was delayed behind an older pending update. The once-only retry removes the short refinement deadline on the second attempt, permitting further waits. This is an application architecture mechanism supported by the trace and matching source. It does not identify the provider-internal cause of the subsequent consumption-event delay.',
 uncertainties:['Consumption is the application processing a matching item/completed userMessage event, not measured provider GPU/reasoning/queue time.',
  'Large prompt and refinement character counts are recorded; their causal contribution has not been isolated.',
  'Backend selection also changes detection, continuation and steering. A final-prompt comparison alone cannot establish end-to-end superiority.'],
 model:stage.model,effort:stage.effort,outputDevice:stage.outputDevice,productionLogicChanged:false,
 scope:'Recording and read-only architecture diagnosis. No answer-specific rules, expected-answer injection or production fixes.'};
await writeFile('docs/evidence/refinement-queue-analysis-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({references,stages:stage.stages,summary:summary.summary,productionLogicChanged:false}));
