import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceFiles=['scripts/summarize-deep-audio-interview.mjs','scripts/summarize-pressure-assessment.mjs',
 'scripts/tests/deep-audio-assessment.test.mjs','.local/run-independent-assessments-v70.ps1'];
const sources=[];
for(const file of sourceFiles){const bytes=await readFile(file);sources.push({file,sha256:hash(bytes)});}
const summary=await readFile(sourceFiles[0],'utf8');
assert(!summary.includes('under800')&&!summary.includes('fails_95_percent_success_requirement'));
assert(!summary.includes('Three answer-adaptive topic pilots'));
const pressureFile='artifacts/deep-interview-v70/continuous-pressure-t/pressure-review-input.json';
const pressureBytes=await readFile(pressureFile),pressure=JSON.parse(pressureBytes);
const overlaps=[];
for(const [index,row] of pressure.rows.entries()){
 for(const prior of pressure.rows.slice(0,index)){
  const before=prior.sourceBinding.recognizedSpan,current=row.sourceBinding.recognizedSpan;
  assert(before.end<=current.end,'Earlier projected question must not include future recognized tokens beyond current input');
  if(before.end>=current.start)overlaps.push({priorRound:prior.round,currentRound:row.round,
   priorSpan:{start:before.start,end:before.end},currentSpan:{start:current.start,end:current.end}});
 }
}
const report={recordedAt:new Date().toISOString(),sources,
 reportingChanges:['Removed the fixed 800 ms joint target and 95-percent pass/fail requirement from deferred interview summaries.',
  'Report verdict counts, missing phrase measurements, cancellation and errors with all recorded rows retained.',
  'Use the shared observed-latency distribution including the midpoint median for even sample sizes.',
  'Describe the supplied recording rather than incorrectly calling full hours a three-pilot sample.',
  'Keep pressure native-job endpoints explicitly separate from physical source-playback endpoints.'],
 validation:{summaryTest:'node --test scripts/tests/deep-audio-assessment.test.mjs',summaryTestPassed:true,
  pressureInputBindings:{file:pressureFile,sha256:hash(pressureBytes),nativeJobs:pressure.rows.length,
   validatedAgainstOriginalJobAnswersQuestionsPhasesAndTimingRows:true},
  pressureEarlierSourceChronology:{noEarlierProjectedQuestionExtendsBeyondCurrentRecognizedEnd:true,
   overlappingSourceSpanPairs:overlaps,
   scope:'The four overlaps are a recorded partial Why job followed by its expanded question, not future trailing constraints supplied to an earlier job.'},
  reviewerLauncherPowerShellSyntaxPassed:true},
 independentModelReviewExecuted:false,productionLogicChanged:false,
 scope:'Reporting and offline input-binding preparation only. No fabricated accuracy judgments, expected-answer injection or new inference during measured playback. Full model assessment, actual backend comparison and remaining live hours are still pending.'};
await writeFile('docs/evidence/independent-review-preparation-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/independent-review-preparation-v70.json',nativeJobs:pressure.rows.length,
  overlappingSourceSpanPairs:overlaps.length,independentModelReviewExecuted:false}));
