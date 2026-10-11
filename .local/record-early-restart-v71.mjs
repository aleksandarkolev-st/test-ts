import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const file='docs/evidence/architecture-systems-r3-clocks-v71.json',raw=await readFile(file),r=JSON.parse(raw),p=r.pipeline;
const a=r.audioClockAnchors,low=Math.max(...a.map(x=>x.nativeMs-x.hostAfterMs)),high=Math.min(...a.map(x=>x.nativeMs-x.hostBeforeMs));assert(low<=high);
const end={low:r.audioPlayback.lastVoicedDevicePositionLowerHostMs+low,high:r.audioPlayback.lastVoicedDevicePositionUpperHostMs+high};
const first=r.frameEvents.find(e=>e.name==='answer.provisional_prefix'&&e.payload.observedAt>=p.cleanupTerminalAt);assert(first);
const sourceFile='src-tauri/src/openai/codex.rs',source=await readFile(sourceFile),lines=source.toString().split('\n');
const locate=(needle,meaning)=>{const index=lines.findIndex(line=>line.includes(needle));assert(index>=0);return {file:sourceFile,line:index+1,source:lines[index].trim(),meaning};};
const report={recordedAt:new Date().toISOString(),evidence:{file,sha256:hash(raw)},source:{file:sourceFile,sha256:hash(source)},
 round:r.round,responseVersion:r.responseVersion,physicalVoicedEndpointNativeMs:end,clockOffsetIntervalMs:{low,high},
 restartCount:p.refinementRestartCount,cleanupStartedAt:p.cleanupStartedAt,cleanupTerminalAt:p.cleanupTerminalAt,
 cleanupTerminalBeforePhysicalSpeechEndMs:{low:end.low-p.cleanupTerminalAt,high:end.high-p.cleanupTerminalAt},
 firstDecodedPrefixAfterCleanup:first.payload,postCleanupPrefixBeforePhysicalSpeechEndMs:{low:end.low-first.payload.observedAt,high:end.high-first.payload.observedAt},
 exactRestartRequestSentAt:null,
 mechanisms:[
  locate('if result.as_ref().err().map(String::as_str)!=Some(REFINEMENT_STALLED)','Only this failed-refinement outcome triggers the one outer retry.'),
  locate('if let Some(trace)=&trace{trace.refinement_restarted();trace.reset_answer();}','The retry count increments after obsolete-thread terminal cleanup.'),
  locate('reuse,false,Some(corrected.context)','The second attempt disables restart_stalled.'),
  locate('if restart_stalled&&!terminal_pending&&!consumption_pending=>','The short final-refinement deadline is enabled only while restart_stalled is true.')
 ],
 interpretation:'A once-only refinement retry is already active and decoding a still-incomplete question frame more than eight seconds before the actual source utterance ends. The final question then reaches the second attempt, whose short refinement-restart deadline is disabled. This demonstrates that the short restart can be spent during a multipart question rather than reserving it for its actual final condition. The final submission gate and matching-input receipt waits in the preserved row remain directly measured; the exact fresh restart-request send timestamp and provider-internal scheduling are not captured.',
 scope:'Source-bound immutable live-row checkpoint with physical playback/native clock calibration. This is a measured application lifecycle example, not an isolated causal intervention, answer grade or complete systems-hour result. Native ASR-final segments and question confirmations are distinct from the physical end of a multipart source utterance.',
 finalJournalBindingPending:true,independentAccuracyPending:true,goalComplete:false};
assert(p.refinementRestartCount===1&&report.postCleanupPrefixBeforePhysicalSpeechEndMs.low>0);
const output='docs/evidence/early-refinement-retry-v71.json';await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({output,cleanupBeforePhysicalEndMs:report.cleanupTerminalBeforePhysicalSpeechEndMs,decodedPrefixBeforePhysicalEndMs:report.postCleanupPrefixBeforePhysicalSpeechEndMs}));
