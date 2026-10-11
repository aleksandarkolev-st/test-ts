import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const files=['docs/evidence/backend-routing-differences-v70.json','docs/evidence/backend-runtime-findings-v70.json','docs/evidence/answer-architecture-audit-corrected-v70.json','docs/evidence/deep-interview-results-v70.json'];
const records=[];for(const file of files){const raw=await readFile(file);records.push({file,sha256:hash(raw),value:JSON.parse(raw)});}
const route=records[0].value,architecture=records[2].value,baseline=records[3].value;
const currentRouting=[];for(const [file,expected] of Object.entries(route.sourceHashes)){const raw=await readFile(file),actual=hash(raw);assert.equal(actual,expected);currentRouting.push({file,baselineSha256:expected,currentSha256:actual,unchanged:true});}
const codexFile='src-tauri/src/openai/codex.rs',expected=architecture.sourceAnalysis.find(s=>s.file===codexFile).sha256;
const head=execFileSync('git',['show','HEAD:'+codexFile],{maxBuffer:2*1024*1024});
const headCrLf=Buffer.from(head.toString().replace(/\r?\n/g,'\r\n'));
const headBom=Buffer.concat([Buffer.from([239,187,191]),head]),headCrLfBom=Buffer.concat([Buffer.from([239,187,191]),headCrLf]);
const representations={gitBlob:hash(head),windowsLineEndings:hash(headCrLf),gitBlobWithUtf8Bom:hash(headBom),windowsLineEndingsWithUtf8Bom:hash(headCrLfBom)};
const matchingRepresentation=Object.entries(representations).find(([,sha])=>sha===expected)?.[0]??null;
console.log(JSON.stringify({expected,representations,matchingRepresentation}));
const report={recordedAt:new Date().toISOString(),evidence:records.map(({file,sha256})=>({file,sha256})),currentRouting,
 codex:{file:codexFile,baselineSha256:expected,gitRepresentations:representations,matchingRepresentation,currentDiagnosticSourceSha256:hash(await readFile(codexFile)),
  diffScope:'The inspected worktree diff against Git HEAD adds acceptance/debug-only matching-input receipt, queue and callback counters, their test assertions, an explicit unchanged collection type, and equivalent statement formatting. The measured debug binary has additional observation overhead. This diff does not by itself prove Git HEAD is identical to the archived v70 source hash.'},
 historicalDirectPromptComparison:baseline.workingVariantRequestTiming,
 historicalNativeChatgptDetection:baseline.architecture.nativeChatgptDetection,
 caveats:['These are the preserved earlier backend executions, not new v71 backend trials. Routing source equivalence supports architectural applicability but cannot guarantee identical provider load, service behavior, cache state or future outcomes.','The direct comparison excludes ASR, native detection, live question updates, authentication/preparation and overlay rendering; its lower first-word latency cannot establish better end-to-end interviews.','The revised HTTP timeout finding in backend-runtime-findings-v70 supersedes the earlier mistaken no-timeout analysis.','New v71 matched policy controls test the Codex question pipeline, not a repaired ChatGPT route or a new production deployment.'],
 freshHourAccuracyPending:true,goalComplete:false};
assert(report.historicalDirectPromptComparison&&report.historicalNativeChatgptDetection);
const output='docs/evidence/backend-baseline-applicability-v71.json';await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({output,unchangedRoutingFiles:currentRouting.length,baselineCodexMatchesGitRepresentation:Boolean(matchingRepresentation)}));
