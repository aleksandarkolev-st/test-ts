import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=async file=>{const b=await readFile(file);return {file,sha256:hash(b),value:JSON.parse(b)};};
const root='artifacts/deep-interview-v70';
const playback=await read(`${root}/backend-playback-comparison/playback.json`),failed=await read(`${root}/chatgpt-response-diagnostic/response-diagnostic.json`),omitted=await read(`${root}/chatgpt-response-diagnostic-no-tier/response-diagnostic.json`);
assert(playback.value.status==='complete'&&playback.value.stoppedCleanly);
const clientBytes=await readFile('src-tauri/src/openai/client.rs'),client=clientBytes.toString();
assert(client.includes('.connect_timeout(std::time::Duration::from_secs(10))')&&client.includes('.timeout(std::time::Duration::from_secs(120))'));
const old=await read('docs/evidence/backend-observation-policy-v70.json');
assert.equal(hash(clientBytes),old.value.sourceHashes['src-tauri/src/openai/client.rs']);
const cases=playback.value.cases.map(c=>({backend:c.backend,name:c.name,waveHashes:c.waves.map(w=>w.sha256),sourceQuestions:c.waves.map(w=>w.sourceQuestion),
 speechConfiguration:c.speechConfiguration,stoppedCleanly:c.stoppedCleanly,settledAfterPlayback:c.settledAfterPlayback,
 questionCandidateEvents:c.events.filter(e=>e.name==='question.candidate').length,questionConfirmedEvents:c.events.filter(e=>e.name==='question.confirmed').length,
 answerStartedEvents:c.events.filter(e=>e.name==='answer.started').length,answerCompletedEvents:c.events.filter(e=>e.name==='answer.completed').length,
 finalTranscripts:c.events.filter(e=>e.name==='transcript'&&e.payload.final).map(e=>e.payload.text),timingRows:c.timings.length,pollErrors:c.pollErrors.length}));
for(const c of cases.filter(c=>c.backend==='codex')){const other=cases.find(o=>o.name===c.name&&o.backend==='chatgpt');assert.deepEqual(c.waveHashes,other.waveHashes);assert.deepEqual(c.speechConfiguration,other.speechConfiguration);}
assert.equal(failed.value.sanitizedErrorDetails.detail,'Unsupported service_tier: fast');assert.equal(omitted.value.httpStatus,200);
const report={recordedAt:new Date().toISOString(),evidence:[playback,failed,omitted].map(({file,sha256})=>({file,sha256})),cases,
 transportDiagnosis:{originalFastTierStatus:400,actualErrorDetail:failed.value.sanitizedErrorDetails.detail,omitOptionalTierStatus:200,
 scope:'One untimed follow-up diagnostic confirms HTTP acceptance when the optional tier is omitted. A 200 header alone is not a completed model answer or comparative latency measurement; separate preserved final-prompt trials are queued.'},
 detectionFinding:{nativeChatgptCases:3,nativeChatgptWaveforms:4,questionCandidateEvents:0,questionConfirmedEvents:0,answerStartedEvents:0,
 explanation:'The captured imperative requests were transcribed but the ChatGPT route started no question jobs. Runtime sets semantic_intent only for Codex. The ChatGPT fallback requires interrogative score >=4 or an existing related question; these imperative openings do not qualify. Consequently these native cases did not reach the failing answer POST.',
 scope:'Observed on these exact cases, not every ChatGPT question or every speech style. The ChatGPT topic-switch source was eventually played after the recorder wait expired; it did not interrupt a streaming ChatGPT answer because none existed.'},
 correction:{supersedesArchitecturalFindingIn:old.file,priorFileSha256:old.sha256,
 previousFindingIncorrect:true,sourceUnchanged:true,actualNormalAuthHttpClient:{connectTimeoutSeconds:10,totalTimeoutSeconds:120,redirectPolicy:'none'},
 explanation:'The earlier audit inspected reqwest library defaults and mistook the acceptance fixture Client::new branch for normal production construction. Normal saved authentication uses Client::builder with explicit 10-second connect and 120-second total timeout. The same source hash proves this is an audit correction, not a new production change. The comparison still has a shared outer 180-second observation budget; no trial exercised that branch.'},
 documentation:{url:'https://developers.openai.com/api/reference/python/resources/responses',accessedAt:new Date().toISOString(),
 observation:'Official Responses reference documents fast and priority and omission defaulting to auto. The actual account-backed endpoint rejected fast here; this is an observed route incompatibility, not a claim that fast is globally invalid.'},
 productionLogicChanged:false,scope:'Source-bound recording and corrected static architecture interpretation. Original failures, recordings and historical reports remain preserved. No expected answers, production fixes, performance threshold or backend winner is introduced.'};
await writeFile('docs/evidence/backend-runtime-findings-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,chatgptNativeJobs:0,fastStatus:400,omittedTierStatus:200,normalHttpTimeoutCorrectionRecorded:true}));
