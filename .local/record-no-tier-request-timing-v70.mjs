import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {retainedStreamTiming} from '../scripts/lib/retained-stream-timing.mjs';
import {latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=async file=>{const b=await readFile(file);return {file,sha256:hash(b),value:JSON.parse(b)};};
const root='artifacts/deep-interview-v70',base=`${root}/chatgpt-backend-comparison-no-tier`;
const original=await read(`${root}/backend-comparison-cases.json`),manifest=await read(`${root}/backend-comparison-no-tier-cases.json`);
const complete=await read(`${base}/complete.json`),provenance=await read(`${base}/execution-provenance.json`);
assert.equal(complete.value.status,'complete');assert.equal(complete.value.manifestSha256,manifest.sha256);assert.equal(provenance.value.manifestSha256,manifest.sha256);
const old=structuredClone(original.value),fresh=structuredClone(manifest.value);delete old.serviceTier;delete fresh.configurationVariant;
assert.deepEqual(old,fresh);assert.equal(manifest.value.configurationVariant.originalManifestSha256,original.sha256);
for(const [file,expected] of Object.entries(provenance.value.compiledSourceHashes))assert.equal(hash(await readFile(file)),expected);
assert.equal(hash(await readFile('src-tauri/examples/compare-answer-backends.rs')),provenance.value.comparisonSourceSha256);
const evidence=[original,manifest,complete,provenance].map(({file,sha256})=>({file,sha256})),rows=[];
for(let repetition=1;repetition<=manifest.value.repetitions;repetition++)for(const [index,source] of manifest.value.cases.entries()){
 const expectedInput=hash(Buffer.from(`${source.selectedContext}\n\nCURRENT QUESTION\n${source.recognizedQuestion}`));
 for(const backend of ['codex','chatgpt']){
  const trial=await read(`${base}/repeat-${repetition}-case-${String(index+1).padStart(2,'0')}-${backend}.json`),t=trial.value;
  assert.equal(t.backend,backend);assert.equal(t.case,index+1);assert.equal(t.repetition,repetition);assert.deepEqual(t.source,source);
  assert.equal(t.inputSha256,expectedInput);assert.equal(t.model,manifest.value.model);assert.equal(t.effort,manifest.value.effort);assert.equal(t.serviceTier,null);assert.equal(t.codexContinuity,false);
  const count=t.streamEventsBeforeObservationEnd??t.streamEvents.length;assert(Number.isInteger(count)&&count>=0&&count<=t.streamEvents.length);
  const timing=retainedStreamTiming(t.streamEvents.slice(0,count),t.answer);
  rows.push({backend,case:t.case,repetition,inputSha256:t.inputSha256,error:t.error,answerChars:t.answer.length,
   firstRetainedCompleteWordFromRequestMs:timing.firstRetainedWordMs,elapsedMs:t.elapsedMs,observationBudgetExhausted:t.observationBudgetExhausted,
   cleanupBudgetExhausted:t.cleanupBudgetExhausted,actualReportedServiceTier:t.pipeline.actualServiceTier??null,reportedCachedInputTokens:t.pipeline.cachedInputTokens??null});
  evidence.push({file:trial.file,sha256:trial.sha256});
 }
}
const summaries=Object.fromEntries(['codex','chatgpt'].map(backend=>{const group=rows.filter(r=>r.backend===backend);return [backend,{
 trials:group.length,errors:group.filter(r=>r.error).length,observationLimits:group.filter(r=>r.observationBudgetExhausted).length,cleanupLimits:group.filter(r=>r.cleanupBudgetExhausted).length,
 missingRetainedWords:group.filter(r=>r.firstRetainedCompleteWordFromRequestMs===null).length,
 firstRetainedCompleteWordFromRequestMs:latencyDistribution(group.map(r=>r.firstRetainedCompleteWordFromRequestMs)),
 operationElapsedMs:latencyDistribution(group.map(r=>r.elapsedMs)),
 reportedTierCounts:Object.fromEntries([...new Set(group.map(r=>r.actualReportedServiceTier??'unreported'))].map(t=>[t,group.filter(r=>(r.actualReportedServiceTier??'unreported')===t).length]))}];}));
const pairs=rows.filter(r=>r.backend==='codex').map(c=>{const g=rows.find(r=>r.backend==='chatgpt'&&r.case===c.case&&r.repetition===c.repetition);return {
 case:c.case,repetition:c.repetition,inputSha256:c.inputSha256,chatgptMinusCodexFirstWordMs:Number.isFinite(g.firstRetainedCompleteWordFromRequestMs)&&Number.isFinite(c.firstRetainedCompleteWordFromRequestMs)?g.firstRetainedCompleteWordFromRequestMs-c.firstRetainedCompleteWordFromRequestMs:null};});
const report={recordedAt:new Date().toISOString(),evidence,rows,summaries,pairs,
 pairCounts:{total:pairs.length,chatgptEarlier:pairs.filter(p=>p.chatgptMinusCodexFirstWordMs!==null&&p.chatgptMinusCodexFirstWordMs<0).length,
 codexEarlier:pairs.filter(p=>p.chatgptMinusCodexFirstWordMs>0).length,tied:pairs.filter(p=>p.chatgptMinusCodexFirstWordMs===0).length,missingEither:pairs.filter(p=>p.chatgptMinusCodexFirstWordMs===null).length},
 independentAccuracyPending:true,productionLogicChanged:false,
 scope:'Completed fixed-final-prompt request diagnostics, using the same 12 captured input cases twice with alternating route order and omitted optional tier on both routes. Successful streaming answers are now recorded. Token retrieval and prepared-thread setup precede the request clock; ASR, live steering, native overlay and speech endpoints are excluded. Codex retains its distinct automatic-intent output protocol. Model effort/name and source input bytes match; actual serving tier is recorded only where the route reports it. These dependent repetitions do not establish population performance or end-to-end meeting superiority. All wrong answers remain pending separate blinded accuracy review; no speed winner is used as a production rule.'};
await writeFile('docs/evidence/no-tier-backend-request-timing-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({summaries,pairCounts:report.pairCounts,independentAccuracyPending:true}));
