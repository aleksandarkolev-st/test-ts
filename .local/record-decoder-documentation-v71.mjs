import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex'),file='src-tauri/src/openai/codex.rs',raw=await readFile(file),text=raw.toString();
assert(text.includes('"properties":{"intent":'));assert(text.includes('"required":["intent","text"]'));
const prior='docs/evidence/architecture-decoder-analysis-v71.json',priorBytes=await readFile(prior);
const report={recordedAt:new Date().toISOString(),source:{file,sha256:hash(raw)},qualifies:{file:prior,sha256:hash(priorBytes)},
 documentation:{url:'https://developers.openai.com/api/docs/guides/structured-outputs',fetchedOn:'2026-10-11',sections:['Key ordering','Supply your schema in the API call'],
  findings:['Documented Structured Outputs preserve the schema key order.','The first use of a schema can add schema-processing latency; repeated requests with that schema do not have that additional setup latency.'],
  scope:'Current public API documentation. This is not a captured wire trace or proof of the exact implementation used by pinned Codex 0.160.1.'},
 sourceObservations:['The automatic-answer schema defines intent before text.','It is the same two-field schema for every automatic question and refinement.'],
 interpretation:'Text-first gating is a behavior the local decoder permits, but it should not be treated as an observed or leading explanation for these tails. Under the documented schema-order contract and this schema, intent precedes text. Actual raw chunks are absent, so pinned runtime field order and decoder cost remain unmeasured. Likewise, a repeated unchanged schema does not establish recurring setup delay.',
 productionBehaviorChanged:false,newDecoderBenchmarkExecuted:false,goalComplete:false};
const output='docs/evidence/architecture-decoder-documentation-v71.json';await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({output}));
