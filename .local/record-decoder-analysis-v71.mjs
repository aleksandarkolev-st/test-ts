import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file='src-tauri/src/openai/codex.rs',raw=await readFile(file),lines=raw.toString().split('\n');
const reference=(needle,meaning)=>{const line=lines.findIndex(x=>x.includes(needle));assert(line>=0,needle);return {file,line:line+1,source:lines[line].trim(),meaning};};
const report={recordedAt:new Date().toISOString(),source:{file,sha256:createHash('sha256').update(raw).digest('hex')},
 facts:[
  reference('pub fn automatic_reply_schema()', 'The automatic answer contains intent and text, without an echoed question field.'),
  reference('if intent!=Some(false){return Ok(None);}', 'Text is not emitted until a complete answer intent has been decoded. A text-first answer cannot emit until the subsequent intent field arrives.'),
  reference('Ok((!delta.is_empty()).then_some(delta))','Once answer intent is available, decoded nonempty text prefixes are emitted incrementally; closing the whole JSON object is not required.'),
  reference('let (intent,text)=reply_prefix(&self.raw)?;','The accumulated JSON prefix is reparsed on each chunk; work can grow with cumulative output and chunk count. This is a source-level cost, not a measured tail attribution.'),
  reference('let gated=if automatic{reply_gate.feed(delta)?}','Decoder execution happens before the callback-duration timer; small callback times do not measure decoder cost.'),
  reference('trace.mark(Stage::FirstAgentDelta)','FirstAgentDelta is marked in dispatch, before filtering blocked old agent items and before JSON gating. It is not reset per final answer frame.'),
  reference('intent_framing_preserves_exact_code_and_split_escapes_without_metadata','The existing passing framing test checks incremental exact text and split escapes and withholding a text-first ignore reply; it is not a latency benchmark.')
 ],measurementLimitations:[
  'Current recordings do not preserve raw agent JSON chunks or final-frame first raw delta timestamps. Actual field order and decoder execution time cannot be reconstructed reliably.',
  'The measured same-response confirmation-to-send and send-to-reader waits occur before decoding the final response. JSON gating cannot explain those intervals.',
  'Consumer-to-retained-delta includes backend output arrival, decoding, frame/context filtering and native processing; it is not isolated model compute time.',
  'No production behavior, prompts, or backend routing changed. No new build or expensive decoder benchmark during measured capture.'
 ],newEmpiricalDecoderBenchmarkExecuted:false,independentAccuracyPending:true,goalComplete:false};
const output='docs/evidence/architecture-decoder-analysis-v71.json';
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({output,facts:report.facts.length}));
