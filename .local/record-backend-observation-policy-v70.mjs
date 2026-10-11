import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const manifestFile='artifacts/deep-interview-v70/backend-comparison-cases.json';
const manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes);
assert.equal(manifest.model,'gpt-6.1-sol');assert.equal(manifest.effort,'low');
assert(manifest.requestObservationBudgetMs>0&&manifest.cleanupObservationBudgetMs>0);
const journals=new Map();
for(const item of manifest.cases){
 if(!journals.has(item.sourceJournal)){
  const bytes=await readFile(item.sourceJournal);assert.equal(hash(bytes),item.journalSha256);
  journals.set(item.sourceJournal,JSON.parse(bytes));
 }
 const row=journals.get(item.sourceJournal).rows.find(row=>row.round===item.sourceRound);assert(row);
 assert.equal(row.question,item.spokenQuestion);assert.equal(row.recognizedQuestion,item.recognizedQuestion);
 assert.equal(row.selectedContext,item.selectedContext);
}
const pinnedClient='C:/Users/polek/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/reqwest-0.12.28/src/async_impl/client.rs';
const libraryBytes=await readFile(pinnedClient),library=libraryBytes.toString();
assert(library.includes('read_timeout: None')&&library.includes('timeout: None')&&library.includes('connect_timeout: None'));
const sources={};
for(const file of ['src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/src/openai/client.rs',
 'src-tauri/src/openai/codex.rs','src-tauri/examples/compare-answer-backends.rs',
 '.local/prepare-backend-review-v70.mjs','scripts/summarize-answer-backend-comparison.mjs'])sources[file]=hash(await readFile(file));
const report={recordedAt:new Date().toISOString(),manifest:{file:manifestFile,sha256:hash(manifestBytes)},sourceHashes:sources,
 unchangedSourceCaseBindingsValidated:manifest.cases.length,
 pinnedReqwestDefaults:{version:'0.12.28',file:pinnedClient,sha256:hash(libraryBytes),connectTimeout:null,readTimeout:null,totalTimeout:null},
 architecturalFinding:'The existing app ChatGPT HTTP client uses reqwest::Client::new and adds no request deadline around sending or reading the response. It remains cancellable. The existing Codex stream attempt has its own 120-second deadline.',
 experimentPolicy:{requestObservationBudgetMs:manifest.requestObservationBudgetMs,cleanupObservationBudgetMs:manifest.cleanupObservationBudgetMs,
  sharedByBothRoutes:true,cutoffsRemainInDenominator:true,cutoffErrorOrigin:'experiment_observation_limit',
  tokenRefreshAllowedToFinish:true,readOnlyCatalogRequestBounded:true,answerFrozenAtObservationEnd:true,
  rawCleanupOutputRetainedSeparately:true,cleanupCallbacksExcludedFromCanonicalTiming:true},
 javascriptSyntaxChecksPassed:true,RustHelperBuildAndExecutionPending:true,productionLogicChanged:false,
 scope:'Read-only pinned-source deadline diagnosis and unexecuted comparison configuration. Observation windows bound the experiment and introduce no latency pass/fail target or expected-answer rule. Captured public question, recognition and selected context remain byte matched. The Rust cancellation/snapshot branch has not yet been compiled or exercised.'};
await writeFile('docs/evidence/backend-observation-policy-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({sourceCasesValidated:manifest.cases.length,requestObservationBudgetMs:manifest.requestObservationBudgetMs,productionLogicChanged:false,RustHelperBuildAndExecutionPending:true}));
