import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const files=['src-tauri/src/openai/codex.rs','src-tauri/src/openai/client.rs','src-tauri/src/meeting/context.rs','src-tauri/src/runtime.rs','src-tauri/src/meeting/intent.rs'];
const sources={};for(const file of files){const bytes=await readFile(file);sources[file]={sha256:hash(bytes),lines:bytes.toString().split('\n')};}
const reference=(file,needle,claim)=>{const i=sources[file].lines.findIndex(line=>line.includes(needle));assert(i>=0,needle);return {file,line:i+1,source:sources[file].lines[i].trim(),claim};};
const checkpointFile='docs/evidence/architecture-tail-checkpoint-v71.json',checkpointBytes=await readFile(checkpointFile),checkpoint=JSON.parse(checkpointBytes);
const runtimeManifestBytes=await readFile('.local/codex/manifest.json'),runtime=JSON.parse(runtimeManifestBytes.toString().replace(/^\uFEFF/,''));
const report={recordedAt:new Date().toISOString(),sourceHashes:Object.fromEntries(files.map(f=>[f,sources[f].sha256])),
 codexRuntime:{manifestSha256:hash(runtimeManifestBytes),version:runtime.version,binarySha256:runtime.binarySha256,
  actualBinarySha256:hash(await readFile('.local/codex/codex.exe'))},
 officialDocumentation:[
  {url:'https://learn.chatgpt.com/docs/app-server',fetchedOn:'2026-10-11',section:'Steer an active turn',finding:'The app-server accepts additional input on the active turn and returns its turn identifier. It does not start a separate turn for that request.'},
  {url:'https://developers.openai.com/api/docs/guides/steering',fetchedOn:'2026-10-11',section:'Queue input and handle the continuation',finding:'Responses steering acceptance acknowledges queued input. Application of the update can wait for current output and hosted work to finish.',qualification:'This documents the current Responses API. It does not establish that pinned Codex 0.160.1 used that exact transport or account route during these recordings.'}
 ],
 sourceFindings:[
  reference(files[0],'&& pending_question.is_none() {','The application permits one outstanding input frame before submitting another changed final question.'),
  reference(files[0],'reuse,false,Some(corrected.context)','Its once-only second attempt disables the short final-refinement restart deadline.'),
  reference(files[0],'const FINAL_CONSUMPTION_WAIT:','The configured short final-refinement wait is 400ms, not a fixed ten-second sleep.'),
  reference(files[0],'let steer=service.rpc("turn/steer"','The reply acknowledgement is distinct from the later matching userMessage consumption event.'),
  reference(files[1],'.connect_timeout(std::time::Duration::from_secs(10))','The normal HTTP client has a ten-second connect timeout. Codex automatic answering takes the native app-server branch; that HTTP timeout is not evidence of a ten-second sleep on its steering path.'),
  reference(files[1],'self.codex.as_ref().ok_or("Codex runtime is unavailable")?.stream_question','The selected Codex answer branch uses native app-server question updates.'),
  reference(files[2],'pub const ANSWER_CONTEXT_CHARS:','The nominal 8000-character value is not an enforced cap on the complete composite context.'),
  reference(files[2],'let history=if answers.is_empty()','Exact code/prior-answer history is appended after selected transcript sections.'),
  reference(files[2],'while self.code_history.len()>1','The code archive evicts whole earlier entries when its archive budget is exceeded and preserves one accepted entry, even if its paired question takes it over the budget.'),
  reference(files[0],'let partial_budget_available=','The history-character heuristic suppresses extra partial refinements after the budget is spent; changed confirmed inputs still follow the final-update path.'),
  reference(files[0],'&& prior_chars+history_chars<MAX_REUSABLE_HISTORY_CHARS','The 80000-character condition restricts later native-history reuse; it is not a model token limit or a hard cap on all confirmed inputs within the current attempt.'),
  reference(files[3],'if candidate_changed && intent_mode==meeting::intent::Mode::Existing','The final-only control suppresses generation from candidate transcript changes. It still uses the normal confirmed-question route, so an internal pause can produce a confirmed fragment before the utterance continues.')
 ],
 observedTail:{file:checkpointFile,sha256:hash(checkpointBytes),round:checkpoint.round,questionId:checkpoint.questionId,
  retainedVisibleWordMs:checkpoint.word.latencyMs,stages:checkpoint.stages,
  readerFullQueueCount:checkpoint.pipeline.readerFullQueueCount,readerQueuePeak:checkpoint.pipeline.readerQueuePeak,
  readerSendMaxUs:checkpoint.pipeline.readerSendMaxUs,deltaCallbackMaxUs:checkpoint.pipeline.deltaCallbackMaxUs,
  promptChars:checkpoint.pipeline.promptChars,refinementChars:checkpoint.pipeline.refinementChars},
 conclusion:'The final-update serialization and disabled second-attempt short deadline are application mechanisms that permit long waits. The fresh recorded tail has no observed per-thread full queue and negligible reader-to-consumer processing delay. The ten-second pre-receipt interval cannot be assigned to a fixed HTTP connect wait or to provider-internal reasoning from these observations. Ongoing old-frame generation and repeated context transmission remain hypotheses to distinguish with event trajectories and matched fresh-meeting controls.',
 controls:{command:'.\\.local\\run-policy-controls-v71.ps1',plannedCases:6,repetitions:2,plannedNativeExecutions:24,
  selection:'Slowest retained visible word and the nearest observed median from each of three freshly completed hours, subject to a bound recorded context and waveform. No correctness filter.',
  policies:['existing','final'],freezeSameContext:true,sameRecordedWave:true,newMeetingPerTrial:true,
  status:'prepared_helpers_only_not_executed',limitations:'Selected dependent cases do not estimate population p95. Final-only waits for normal confirmations, not a known physical end of a multipart question. The original full-hour cohort retains every turn.'},
 productionBehaviorChanged:false,goalComplete:false,
 pending:['Finish three new hour recordings and attached hard/pressure recordings','Run matched controls without concurrent examiner/grader inference','Bind tail trajectories and checkpoint to final journals','Complete deferred independent accuracy and substantive checks','Audit full requirements and publish the completed report']};
assert.equal(report.codexRuntime.actualBinarySha256,report.codexRuntime.binarySha256);
await writeFile('docs/evidence/architecture-protocol-analysis-v71.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/architecture-protocol-analysis-v71.json',sourceFindings:report.sourceFindings.length,runtimeVersion:runtime.version,controlsExecuted:false}));
