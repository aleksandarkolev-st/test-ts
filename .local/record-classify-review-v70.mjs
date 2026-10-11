import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/algorithms-hour-t';
const manifest=JSON.parse(await readFile(`${directory}/code-review/round4/round-4.manifest.json`));
const bytes=await readFile(`${directory}/code-review/round4/oracle-evidence.json`),oracle=JSON.parse(bytes);
const hash=text=>createHash('sha256').update(text).digest('hex');
await writeFile(`${directory}/independent-review.json`,JSON.stringify({recordedAt:new Date().toISOString(),
 scope:'Selective execution-backed review of one retained source answer, not a full interview accuracy rate. No generated source was patched.',
 findings:[{round:4,questionSha256:hash(manifest.question),answerSha256:manifest.answerSha256,verdict:'incorrect',
  finding:'The source requires the exact string minus-INF for unbounded costs. The generated function returns positive floating-point infinity instead. It failed that output contract in 574 of 1004 independent oracle cases; its vertex classifications matched after an explicit diagnostic-only encoding translation.',
  recognitionFinding:'The requested sentinel sign is absent in the recognized question. An earlier negative edge cost also lost its sign between intended source and recognized text. Synthesis versus ASR cause is not established.',
  evidence:{file:'code-review/round4/oracle-evidence.json',sha256:hash(bytes),sourceSha256:oracle.sourceSha256,
   cases:oracle.cases,sourceContractFailures:oracle.sourceContractFailures,classificationOnlyFailuresAfterExplicitEncodingTranslation:oracle.classificationOnlyFailuresAfterExplicitEncodingTranslation},
  scopeLimit:'Original code and output contract tested on these cases only. Other rounds, all inputs, physical GPU behavior, and phonetic ground truth remain unverified.'}]},null,2),{flag:'wx'});
console.log('Recorded source-bound independent finding for DSA round 4.');
