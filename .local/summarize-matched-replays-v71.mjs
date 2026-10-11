// Source-bound summaries of declared matched replay protocols, never answer rules.
import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {streamedWordLatency,latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
const [root,kind,output]=process.argv.slice(2);
assert(root&&['policy','architecture'].includes(kind)&&output,'RUN_ROOT policy|architecture OUTPUT');
const digest=x=>createHash('sha256').update(x).digest('hex'),evidence=[];
async function load(file){const bytes=await readFile(file);evidence.push({file,sha256:digest(bytes)});return JSON.parse(bytes);}
const manifestFile=path.join(root,'policy-playback/manifest.json'),manifest=await load(manifestFile);
const protocol=await load(path.join(root,kind==='policy'?'policy-playback/playback.json':'architecture-comparison/comparison.json'));
assert.equal(protocol.status,'complete');assert(protocol.stoppedCleanly);
assert.equal(protocol.manifestSha256,evidence.find(e=>e.file===manifestFile).sha256);
const groups=kind==='policy'?manifest.policies:protocol.variants.map(v=>v.name);
assert(groups.length>=2&&new Set(groups).size===groups.length);
assert.equal(protocol.trials.length,manifest.cases.length*manifest.repetitions*groups.length);
const cohortFile=path.join(root,'review-cohort-audit.json');let cohort=null;
try{await access(cohortFile);cohort=await load(cohortFile);}catch(error){if(error.code!=='ENOENT')throw error;}
const rows=[],combinations=new Set();
for(const trial of protocol.trials){
 const group=kind==='policy'?trial.policy:trial.variant;
 const caseIndex=kind==='policy'?manifest.cases.findIndex(c=>c.name===trial.name):trial.caseIndex;
 const repetition=kind==='policy'?trial.repetition-1:trial.repetition;
 assert(groups.includes(group)&&Number.isInteger(caseIndex)&&caseIndex>=0&&caseIndex<manifest.cases.length);
 assert(Number.isInteger(repetition)&&repetition>=0&&repetition<manifest.repetitions);
 const key=JSON.stringify([caseIndex,repetition,group]);assert(!combinations.has(key));combinations.add(key);
 const source=manifest.cases[caseIndex],file=kind==='policy'?path.join(trial.outputDirectory,'interview.json'):trial.recording;
 const journal=await load(file),journalSha256=evidence.at(-1).sha256;
 assert.equal(journalSha256,trial.journalSha256);assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
 assert.equal(journal.rows.length,1);assert.equal(journal.model,manifest.model);assert.equal(journal.effort,manifest.effort);
 assert.equal(journal.speechConfiguration.selfCapture.physicalMicrophoneUsed,false);
 assert.equal(journal.speechConfiguration.remoteOnly,true);
 const row=journal.rows[0];assert.equal(row.question,source.sourceQuestion);assert.equal(row.audio.sha256,source.wave.sha256);
 assert.deepEqual(row.sourceBinding,source.source);assert.deepEqual(journal.sourceCase,source.source);
 if(row.selectedContext!==null)assert.equal(row.selectedContext,source.selectedContext);
 const word=streamedWordLatency(journal,row).firstRetainedVisibleStreamedWord;
 assert.deepEqual(word,trial.word);
 const reviewed=cohort?.cohorts.find(c=>path.resolve(c.file)===path.resolve(file));
 if(cohort){assert(reviewed,'Completed cohort audit must include every replay');assert.equal(reviewed.journalSha256,journalSha256);assert.equal(reviewed.turns,1);}
 rows.push({caseIndex,repetition,group,file,journalSha256,source:source.source,contextSha256:source.contextSha256,waveSha256:source.wave.sha256,
  word:word??null,phase:row.phase,cancelled:row.cancelled,error:row.error,observationWindowExpired:row.observationWindowExpired,
  independentModelVerdicts:reviewed?.independentModelVerdicts??null});
}
const summaries=groups.map(group=>{
 const trials=rows.filter(r=>r.group===group),counts={};
 for(const trial of trials)for(const [verdict,count] of Object.entries(trial.independentModelVerdicts??{}))counts[verdict]=(counts[verdict]??0)+count;
 return {group,recordedTrials:trials.length,measuredWords:trials.filter(r=>r.word).length,missingWords:trials.filter(r=>!r.word).length,
  cancelled:trials.filter(r=>r.cancelled).length,errors:trials.filter(r=>r.error).length,
  observationWindowsExpired:trials.filter(r=>r.observationWindowExpired).length,
  primaryWordLatencyMs:latencyDistribution(trials.map(r=>r.word?.latencyMs.high)),
  independentModelVerdicts:cohort?counts:null,provisionalCorrectFractionOfAllTrials:cohort?(counts.correct??0)/trials.length:null};
});
const pairs=[];
for(let caseIndex=0;caseIndex<manifest.cases.length;caseIndex++)for(let repetition=0;repetition<manifest.repetitions;repetition++){
 const reference=rows.find(r=>r.caseIndex===caseIndex&&r.repetition===repetition&&r.group===groups[0]);
 for(const group of groups.slice(1)){
  const comparison=rows.find(r=>r.caseIndex===caseIndex&&r.repetition===repetition&&r.group===group);
  assert(reference&&comparison);
  const interval=reference.word&&comparison.word?{low:comparison.word.latencyMs.low-reference.word.latencyMs.high,high:comparison.word.latencyMs.high-reference.word.latencyMs.low}:null;
  pairs.push({caseIndex,repetition,reference:reference.file,comparison:comparison.file,referenceGroup:groups[0],comparisonGroup:group,
   comparisonMinusReferenceMs:interval,comparisonDefinitelyEarlier:interval?interval.high<0:null,
   referenceMissing:!reference.word,comparisonMissing:!comparison.word,referenceError:reference.error,comparisonError:comparison.error,
   referenceVerdicts:reference.independentModelVerdicts,comparisonVerdicts:comparison.independentModelVerdicts});
 }
}
const report={recordedAt:new Date().toISOString(),kind,model:manifest.model,effort:manifest.effort,selection:manifest.selection,
 summaries,pairs,rows,evidence,independentAccuracyPending:!cohort,
 scope:'Dependent diagnostic cases deliberately selected from original tails and medians, replayed with frozen context and fresh meetings. Descriptive matched observations, not population p95 or isolated provider compute. Word latency retains erroneous and cancelled trials with visible words; missing words remain explicit. Independent verdicts, when available, are provisional model judgments over all recorded trials, not executable correctness certification.',goalComplete:false};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,summaries,independentAccuracyPending:report.independentAccuracyPending}));
