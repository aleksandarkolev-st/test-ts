import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='artifacts/deep-interview-v71';await mkdir(root,{recursive:true});
const attachment='C:/Users/polek/.codex/attachments/93ef9b35-9207-44e2-827f-2b2f551e98c1/pasted-text-1.txt';
const files=[attachment,'src-tauri/src/openai/codex.rs','src-tauri/src/openai/timing.rs','src-tauri/src/runtime.rs','src-tauri/src/meeting/scheduler.rs','scripts/native-signed-interview.mjs','scripts/lib/deep-audio-interview.mjs','tests/fixtures/hard-interview-audio-suite.json','tests/fixtures/continuous-interview-pressure.json','src-tauri/target/debug/meeting-copilot.exe','src-tauri/target/debug/examples/adaptive-interview.exe','.local/run-recordings-v71.ps1','.local/run-deep-hour-v71.ps1','.local/run-hard-probes-v71.ps1','.local/run-continuous-pressure-v71.ps1'];
const sources=await Promise.all(files.map(async file=>{const bytes=await readFile(file);return {file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}));
const report={recordedAt:new Date().toISOString(),attachment,sources,
 model:'gpt-6.1-sol',effort:'low',output:'T24E390',microphone:false,productionBehaviorChanged:false,
 diagnostics:'Acceptance/debug-only matched input receipt, reader queue depth/full count/send duration, and delta callback duration. Release excludes these fields and calls. No prompt, routing, restart, timing policy or answer logic changes.',
 requirements:[
  'Fresh elapsed hour of varied non-software topics with adaptive, rapid and fragmentary follow-ups',
  'Fresh elapsed hour of broad technical systems topics with adaptive, rapid and fragmentary follow-ups',
  'Fresh elapsed hour of DSA rounds with executable code, proofs, changed constraints and older implementations',
  'Replay all ten attached hard requirements in new recordings, including thirty-minute playback-only continuous pressure',
  'Physical synthetic voiced endpoint to retained first complete word in the actual overlay, intervals and missing responses retained',
  'Deferred source-bound isolated accuracy assessment, useful phrase latency, cancelled/error/incomplete/unverified counts',
  'Deep architecture analysis of final update queuing, reader receipt versus consumer processing, callback waits, context size and resource/recorder overhead',
  'Explain p95 distributions and worst turns without mixing inference/grader/HTTP-error latency or summing marginal p95s',
  'Keep existing ChatGPT backend observations in scope and distinguish direct prompt performance from native routing/delivery',
  'Source and executable provenance, clean shutdown, measured delivery/topic coverage and explicit limitations'
 ],
 preflight:{transportTestsPassed:13,transportTestScope:'Non-live openai::codex tests, including full-queue acknowledgement stall and matched reader receipt before consumer drain; rerun after diagnostic edits.',nativeAndExaminerBuild:'cargo build --features acceptance --bin meeting-copilot --example adaptive-interview completed exit 0'},
 baseline:'docs/evidence/deep-interview-results-v70.json',
 pending:['three fresh hour recordings','new attached hard probes and continuous pressure','accuracy assessment','architecture and completion audit'],goalComplete:false};
await writeFile(root+'/preparation.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:root+'/preparation.json',sources:sources.length,requirements:report.requirements.length}));
