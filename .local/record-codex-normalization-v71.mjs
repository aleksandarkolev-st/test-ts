import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex'),file='src-tauri/src/openai/codex.rs';
const baselineFile='docs/evidence/answer-architecture-audit-corrected-v70.json',baselineBytes=await readFile(baselineFile),baseline=JSON.parse(baselineBytes);
const expected=baseline.sourceAnalysis.find(s=>s.file===file).sha256;
const head=execFileSync('git',['show','HEAD:'+file],{maxBuffer:2*1024*1024}),normalized=Buffer.from(head.toString().replace(/\r\n/g,'\n'));
const text=head.toString(),crlf=(text.match(/\r\n/g)??[]).length,lf=(text.match(/\n/g)??[]).length;
const previous='docs/evidence/backend-baseline-applicability-v71.json',previousBytes=await readFile(previous);
const report={recordedAt:new Date().toISOString(),file,baseline:{file:baselineFile,sha256:hash(baselineBytes),recordedCodexSha256:expected},
 gitBlobSha256:hash(head),gitBlobLfNormalizedSha256:hash(normalized),recordedBaselineMatchesLfNormalizedGitBlob:hash(normalized)===expected,
 newlineCounts:{crlf,bareLf:lf-crlf},qualifies:{file:previous,sha256:hash(previousBytes)},
 interpretation:hash(normalized)===expected?'The Git blob has mixed CRLF and bare LF newlines. Converting its CRLF to LF exactly reproduces the recorded baseline file hash. The inspected worktree diff can therefore be classified against the baseline source after newline normalization. This is source equivalence, not proof that debug diagnostics add zero measurement overhead.':'LF normalization does not resolve the source mismatch. Keep Codex baseline/current transport equivalence unproven; four other routing files remain independently byte-identical.',
 currentDiagnosticSourceSha256:hash(await readFile(file)),productionPerformanceFixesApplied:false,goalComplete:false};
assert(Number.isSafeInteger(crlf));
const output='docs/evidence/codex-baseline-normalization-v71.json';await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({output,...report,newlineCounts:report.newlineCounts}));
