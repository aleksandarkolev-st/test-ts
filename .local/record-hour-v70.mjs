import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base='artifacts/deep-interview-v70/algorithms-hour-t',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalRaw=await readFile(base+'/duration-audit.json'),original=JSON.parse(originalRaw);
const correctedRaw=await readFile(base+'/duration-audit-unassigned-turn-fix.json'),corrected=JSON.parse(correctedRaw);
if(original.journalSha256!==corrected.journalSha256)throw Error('Journal identity changed between audits');
const missing=corrected.rows.find(r=>r.round===38),originalMissing=original.rows.find(r=>r.round===38),later=original.rows.find(r=>r.round===49);
if(missing.questionId!==null||missing.firstVisibleStreamedWord!==null||originalMissing.questionId!==later.questionId)throw Error('Unexpected assignment correction');
const correction={recordedAt:new Date().toISOString(),journalSha256:corrected.journalSha256,
 originalReportSha256:hash(originalRaw),correctedReportSha256:hash(correctedRaw),
 finding:'Original fallback assigned round 49 to round 38, which had no native question id. The revised metric leaves that turn unassigned and missing; it does not invent a latency. No original audio, journal, painted samples or report was changed.',
 originalBorrowedQuestionId:originalMissing.questionId,originalBorrowedLatencyMs:originalMissing.firstVisibleStreamedWord.latencyMs,
 regressionTest:'scripts/tests/streamed-word-latency.test.mjs',
 correctedReport:'duration-audit-unassigned-turn-fix.json',correctedCsv:'round-metrics-unassigned-turn-fix.csv'};
await writeFile(base+'/timing-assignment-correction.json',JSON.stringify(correction,null,2),{flag:'wx'});
const record={recordedAt:new Date().toISOString(),model:corrected.model,effort:corrected.effort,
 examinerModel:corrected.examinerModel,examinerEffort:corrected.examinerEffort,
 status:corrected.status,stoppedCleanly:corrected.stoppedCleanly,durationVerified:corrected.durationVerified,
 requestedDurationMs:corrected.requestedDurationMs,actualInterviewDurationMs:corrected.actualInterviewDurationMs,
 output:corrected.outputDevice,speechConfiguration:corrected.speechConfiguration,
 journalSha256:corrected.journalSha256,correctedReportSha256:hash(correctedRaw),
 summary:corrected.summary,
 source:base+'/duration-audit-unassigned-turn-fix.json',
 originalReportPreserved:base+'/duration-audit.json',correctionEvidence:base+'/timing-assignment-correction.json',
 independentExecutionEvidence:['docs/evidence/selective-dsa-execution-v70.json','docs/evidence/window-median-execution-v70.json',
  base+'/code-review/round32/oracle-evidence.json',base+'/code-review/round40/oracle-evidence.json'],
 examinerHistoryLimitation:base+'/examiner-history-audit.json',
 scope:'Completed synthetic playback-only DSA interview through local ASR, native scheduler and actual overlay. Finite word latency does not imply correctness. Full, partial and missing grades remain separate, as do cancelled answers and unassigned turns. Examiner history could retain earlier truncated prefixes; independent full assessment is pending. This is an adaptive correlated sample, not a population latency guarantee or thirty minutes of continuous audio. Diagnostic recorder growth is distinct from native app and process-tree memory. GPU allocations are excluded.',
 fullIndependentAccuracyVerified:false,continuousPressureVerified:false,goalComplete:false};
await writeFile('docs/evidence/interview-duration-v70-dsa.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({saved:'docs/evidence/interview-duration-v70-dsa.json',minutes:record.actualInterviewDurationMs/60000,
 turns:record.summary.evaluatedTurns,medianMs:record.summary.firstVisibleWordMs.median}));
