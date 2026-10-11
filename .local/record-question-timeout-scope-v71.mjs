import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const files=['src-tauri/src/openai/codex.rs','src-tauri/src/meeting/questions.rs','src-tauri/src/runtime.rs','src-tauri/src/meeting/scheduler.rs'],sources={};
for(const file of files){const raw=await readFile(file);sources[file]={sha256:hash(raw),lines:raw.toString().split('\n')};}
const locate=(file,needle,meaning)=>{const source=sources[file],index=source.lines.findIndex(line=>line.includes(needle));assert(index>=0,needle);return {file,line:index+1,source:source.lines[index].trim(),meaning};};
const traceFile='docs/evidence/early-refinement-retry-v71.json',traceBytes=await readFile(traceFile),trace=JSON.parse(traceBytes);assert.equal(trace.source.sha256,sources[files[0]].sha256);
const mechanisms=[
 locate(files[1],'pub const END_WAIT_MS','The confirmation quiet-time constant is declared in the question detector; it is not a guarantee that the whole multipart source question ended.'),
 locate(files[1],'now.saturating_sub(t) >= END_WAIT_MS','Confirmation requires the detector stop signal to satisfy its quiet wait, alongside the other VAD/ASR readiness checks.'),
 locate(files[1],'self.last_remote_activity}else','For independent local ASR, readiness is relative to the latest acoustic activity known to the detector, not future speech.'),
 locate(files[1],'now.saturating_sub(t) <= 3000','The detector permits a previous question to continue shortly after a stop, preserving its earlier source wording.'),
 locate(files[0],'const FINAL_CONSUMPTION_WAIT','The short final-refinement consumption guard has a separate duration from the overall answer timer.'),
 locate(files[0],'reuse,false,Some(corrected.context)','A once-only fresh retry disables the short refinement restart guard.'),
 locate(files[0],'let deadline = tokio::time::sleep(Duration::from_secs(120));','The overall answer timer is instantiated after the initial turn/start acknowledgement, once before the attempt event loop.'),
 locate(files[0],'if turn_finished {','Follow-up turn/start requests occur inside that existing attempt loop; they do not recreate its overall deadline.'),
 locate(files[0],'_=&mut deadline=>return Err("Codex answer timed out".into())','The overall deadline yields an answer error, not the refinement-stall sentinel that triggers the fresh retry.'),
 locate(files[0],'const RPC_TIMEOUT','RPC acknowledgement has its own timeout. Matching-input receipt and first answer text are distinct later observations.')
];
const report={recordedAt:new Date().toISOString(),sourceHashes:Object.fromEntries(Object.entries(sources).map(([file,source])=>[file,source.sha256])),mechanisms,
 evidence:{file:traceFile,sha256:hash(traceBytes),round:trace.round,responseVersion:trace.responseVersion},
 interpretation:'The application can confirm a locally finalized speech segment, spend its one short refinement retry, then receive a continuation of the same physical source question. The preserved systems trace directly shows retry cleanup and new decoded prefix before the physical voiced endpoint. The second attempt has no short restart guard, and the overall answer timer remains tied to the attempt loop rather than every later final confirmation. This is a source-backed lifecycle explanation; it does not prove provider-side scheduling, explain every tail, or establish that an overall timeout fired in the cited trace.',
 pinnedBackendSourceInvestigation:{installedVersion:'0.160.1',officialRelease:'https://github.com/openai/codex/releases/tag/rust-v0.160.1',releaseTag:'rust-v0.160.1',releaseCommitAbbreviation:'d27764b',
  inspectedAt:new Date().toISOString(),engineSourceVerified:false,
  failedSourceURLs:['https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/codex.rs','https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/src/codex_message_processor.rs','https://raw.githubusercontent.com/openai/codex/rust-v0.160.1/codex-rs/core/src/codex.rs','https://raw.githubusercontent.com/openai/codex/rust-v0.160.1/codex-rs/app-server/src/codex_message_processor.rs'],
  scope:'The official release page identifies this version/tag and abbreviated commit. Fetches of these assumed engine-source paths returned 404; the tag-tree fetch returned a cache miss. No engine scheduling conclusion or official-binary byte identity follows from the release page or those failures.'},
 finalJournalBindingPending:trace.finalJournalBindingPending,independentAccuracyPending:true,productionBehaviorChanged:false,goalComplete:false};
const file='docs/evidence/question-and-timeout-scope-v71.json';await writeFile(file,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({file,sourceFacts:mechanisms.length,providerEngineVerified:false}));
