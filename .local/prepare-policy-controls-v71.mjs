import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {streamedWordLatency,latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
import {recordedCohort} from './lib/recorded-cohort.mjs';
const root=process.argv[2]??'artifacts/deep-interview-v71',hash=x=>createHash('sha256').update(x).digest('hex');
const recorded=await recordedCohort(root);
const directory=root+'/policy-playback';await mkdir(directory,{recursive:true});
const cases=[],selection=[];
for(const {domain,file:source,requestedDurationMs} of recorded.hours){
 const raw=await readFile(source),journal=JSON.parse(raw);
 assert.equal(journal.status,'complete');assert(journal.stoppedCleanly&&journal.actualInterviewDurationMs>=requestedDurationMs);
 assert.equal(journal.model,recorded.configuration.model);assert.equal(journal.effort,recorded.configuration.effort);
 const measured=journal.rows.map((row,index)=>({row,index,measurement:streamedWordLatency(journal,row)}));
 const eligible=measured.filter(x=>x.measurement.firstRetainedVisibleStreamedWord&&typeof x.row.selectedContext==='string')
  .sort((a,b)=>a.measurement.firstRetainedVisibleStreamedWord.latencyMs.high-b.measurement.firstRetainedVisibleStreamedWord.latencyMs.high);
 assert(eligible.length>=2,'Need two distinct source-bound measured cases');
 const median=latencyDistribution(eligible.map(x=>x.measurement.firstRetainedVisibleStreamedWord.latencyMs.high)).median;
 const tail=eligible.at(-1),middle=eligible.filter(x=>x.index!==tail.index).sort((a,b)=>Math.abs(a.measurement.firstRetainedVisibleStreamedWord.latencyMs.high-median)-Math.abs(b.measurement.firstRetainedVisibleStreamedWord.latencyMs.high-median))[0];
 const picked=[{kind:'slowest_observed',entry:tail},{kind:'nearest_observed_median',entry:middle}];
 for(const {kind,entry:{row,index,measurement}} of picked){
  const waveFile=path.join(path.dirname(source),row.audio.waveFile),wave=await readFile(waveFile);
  assert.equal(hash(wave),row.audio.sha256);
  cases.push({name:path.basename(path.dirname(source))+'-round-'+row.round,domain,selectionKind:kind,source:{file:source,sha256:hash(raw),round:row.round,index},
   sourceQuestion:row.question,recognizedQuestion:row.recognizedQuestion,selectedContext:row.selectedContext,
   contextSha256:hash(row.selectedContext),wave:{file:waveFile,sha256:hash(wave),bytes:wave.length},
   sourcePriorQuestions:journal.rows.slice(0,index).map(r=>({round:r.round,question:r.question})),
   originalRetainedWord:measurement.firstRetainedVisibleStreamedWord,originalPhase:row.phase,originalCancelled:row.cancelled,originalError:row.error});
 }
 selection.push({domain,sourceSha256:hash(raw),allTurns:measured.length,eligible:eligible.length,
  excluded:measured.filter(x=>!eligible.includes(x)).map(x=>({round:x.row.round,missingRetainedWord:!x.measurement.firstRetainedVisibleStreamedWord,missingExplicitContext:typeof x.row.selectedContext!=='string'})),
  observedMedianAmongEligibleMs:median,selected:picked.map(x=>({kind:x.kind,round:x.entry.row.round}))});
 globalThis.gc?.();
}
const manifest={recordedAt:new Date().toISOString(),model:recorded.configuration.model,effort:recorded.configuration.effort,serviceTier:'fast',repetitions:2,
 policies:['existing','final'],cases,selection,
 collectorSourceHashes:{'.local/prepare-policy-controls-v71.mjs':hash(await readFile(new URL(import.meta.url))),'.local/lib/recorded-cohort.mjs':hash(await readFile(new URL('./lib/recorded-cohort.mjs',import.meta.url)))},
 protocol:'Same saved waveform and exact recorded selected context in a fresh native meeting per trial. Start/stop closes Codex to avoid previous-trial native history. Alternate policy order by case and repetition. Existing acceptance_freeze_context sets the existing or final-only debug policy; production policy is unchanged. No examiner or reviewer inference during control playback.',
 observationBudgetMs:130000,
 scope:'Diagnostic deliberately selected tail and median examples, not an unbiased p95 cohort. Repeated cases and ASR nondeterminism remain dependent. Original complete-hour accuracy retains every turn, including excluded/unassigned/cancelled/error turns. Final-only refers to finalized ASR segments, not foreknowledge of the end of a multipart utterance; internal pauses can still produce confirmed fragments and later corrections. These controls examine pipeline behavior; changing multiple aspects of speculation at once does not identify a single algorithmic cause.',
 goalComplete:false};
await writeFile(directory+'/manifest.json',JSON.stringify(manifest,null,2),{flag:'wx'});
console.log(JSON.stringify({file:directory+'/manifest.json',cases:cases.length,trials:cases.length*manifest.repetitions*manifest.policies.length,selection}));
