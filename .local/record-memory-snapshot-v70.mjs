import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fencedSources} from '../scripts/lib/fenced-sources.mjs';
const file='artifacts/deep-interview-v70/hard-probes/deep-code-memory/interview.json';
const raw=await readFile(file),j=JSON.parse(raw),probe=j.olderCodeProbe;
assert(probe&&probe.interveningTurns>=20);
const first=j.rows.find(r=>r.round===probe.probeRound),clarified=j.rows.find(r=>r.round===probe.probeRound+1);
assert(first.phase==='complete'&&clarified.phase==='complete');
const hash=text=>createHash('sha256').update(text).digest('hex');
assert.equal(hash(probe.sourceAnswer),probe.sourceAnswerSha256);
const sourceBlocks=fencedSources(probe.sourceAnswer);
const evidence=row=>({round:row.round,question:row.question,answer:row.answer,
 questionSha256:hash(row.question),answerSha256:hash(row.answer),responseVersion:row.responseVersion,
 firstVisibleWordLatencyHighMs:row.firstStreamedWordMeasurement?.firstVisibleStreamedWord?.latencyMs.high??null,
 closedCodeBlocks:fencedSources(row.answer).length,
 selectedContextSha256:typeof row.selectedContext==='string'?hash(row.selectedContext):null,
 selectedContextContainsEveryOriginalCodeBlock:typeof row.selectedContext==='string'?sourceBlocks.every(b=>row.selectedContext.includes(b.text)):null});
const record={recordedAt:new Date().toISOString(),sourceJournal:file,sourceSnapshotSha256:hash(raw),sourceSnapshotStatus:j.status,
 model:j.model,effort:j.effort,output:j.outputDevice,sourceRound:probe.sourceRound,
 probeRound:probe.probeRound,interveningTurns:probe.interveningTurns,sourceAnswerSha256:probe.sourceAnswerSha256,
 originalCodeBlockSha256:sourceBlocks.map(b=>hash(b.text)),firstReference:evidence(first),clarifiedReference:evidence(clarified),
 review:{type:'Selective source-grounded recording-agent review',clarifiedRequestVerdict:'incomplete',
  originalConstraintDistinctionCorrect:true,recordedImplementationReproduced:false,
  finding:'The clarified request explicitly selected the original three-field, at-most-K version. The completed response correctly distinguished it from exactly-K, cleanup, counting and sampling revisions, but supplied no implementation and asked for the original function body again.',
  firstProbeLimitation:'The automatic reference cut the original question off mid-sentence before its K upper bound and at-most-K contract. Its clarification response is not treated as a definitive version-tracking failure. The examiner supplied a clear subsequent reference without giving the original code.'},
 scope:'Actual recorded questions, source answers, context strings and completed responses. Literal code absence in selected context does not reconstruct hidden backend thread history or prove the sole cause. The journal is ongoing; verify these answer identities again after termination. This is a selective memory/completeness finding, not a full interview accuracy rate. Application answer logic was unchanged.'};
await writeFile('docs/evidence/older-code-retention-v70.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({saved:'docs/evidence/older-code-retention-v70.json',sourceRound:record.sourceRound,
 probeRound:record.probeRound,clarifiedRound:clarified.round,verdict:record.review.clarifiedRequestVerdict,
 originalCodeInClarifiedContext:record.clarifiedReference.selectedContextContainsEveryOriginalCodeBlock}));
