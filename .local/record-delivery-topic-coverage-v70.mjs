import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const base='artifacts/deep-interview-v70',hard=await readdir(`${base}/hard-probes`,{withFileTypes:true});
const directories=[`${base}/algorithms-hour-t`,...hard.filter(entry=>entry.isDirectory()).map(entry=>`${base}/hard-probes/${entry.name}`)];
const records=[];
for(const directory of directories){
 const file=`${directory}/delivery-coverage-audit.json`,bytes=await readFile(file),audit=JSON.parse(bytes);
 assert.equal(audit.journal.sha256,hash(await readFile(path.join(directory,'interview.json'))));
 assert(audit.summary.allQuestionAndBackgroundWaveHashesValidated);
 assert(audit.remoteOnly&&audit.microphoneCapture.physicalMicrophoneUsed===false);
 assert.equal(audit.model,'gpt-6.1-sol');assert.equal(audit.effort,'low');assert(audit.outputDevice.includes('T24E390'));
 const immediate=audit.rows.filter(row=>row.incomingOrigin==='prepared_contextual_probe_after_actual_visible_answer');
 records.push({directory,audit:{file,sha256:hash(bytes)},journalSha256:audit.journal.sha256,sourceQuestions:audit.rows.length,
  backgroundUtterances:audit.background.length,shortQuestions:audit.summary.shortestQuestions,
  activeAnswerOverlapLaunches:audit.summary.activeAnswerOverlapLaunches,
  precedingJobOverlapLaunches:audit.summary.precedingJobOverlapLaunches,
  immediatePreparedFollowups:{count:immediate.length,matchingVisiblePriorPrefix:immediate.filter(row=>row.priorAnswerBasis?.matchingVisiblePaintObservedBeforeBasis).length,
   precedingJobOverlap:immediate.filter(row=>row.precedingJobRunningAtLaunch).length,
   priorVisiblePrefixBasisToPlaybackSubmissionMs:latencyDistribution(immediate.map(row=>row.priorAnswerBasis?.basisToPlaybackSubmissionMs))},
  rows:directory.endsWith('algorithms-hour-t')?audit.rows:undefined});
}
const dsa=records.find(record=>record.directory.endsWith('algorithms-hour-t'));
const groups=[
 ['Graph costs, negative cycles, DAG ordering and bounded-size SCCs',[1,2,3,4,21,22,23,24,37,38,39,40]],
 ['PostgreSQL retries, uniqueness races and durable deduplication',[5,6,7,49]],
 ['Incremental TCP parsing, iterator ownership and lifecycle',[8,9,10,11,12]],
 ['Dynamic connectivity, rollback union-find and bipartiteness',[13,14,15,16]],
 ['C++20 acquire/release and sequentially consistent fences',[17,18,19]],
 ['GPU performance and serialized host/device timing',[20]],
 ['Streaming sliding-window lower medians, expiration and heap rebuilding',[25,26,27,28]],
 ['Binary64 numerical cancellation and stable quadratic roots',[29,30,31]],
 ['Exactly-K interval scheduling, cleanup and witness reconstruction',[32,33,34,35,36]],
 ['Finite-field cryptographic algebra, truncated tags and linear witnesses',[41,42,43,44,45,46,47,48]]
];
const annotated=new Set();
const topics=groups.map(([topic,rounds])=>({topic,sourceRows:rounds.map(round=>{
 assert(!annotated.has(round));annotated.add(round);
 const row=dsa.rows.find(row=>row.round===round);assert(row);
 return {round,sourceQuestionSha256:hash(row.question),question:row.question};
})}));
assert.equal(annotated.size,dsa.sourceQuestions);
const report={recordedAt:new Date().toISOString(),records:records.map(({rows,...record})=>record),
 summary:{completedRecordings:records.length,questionWaveformsHashValidated:records.reduce((sum,record)=>sum+record.sourceQuestions,0),
  backgroundWaveformsHashValidated:records.reduce((sum,record)=>sum+record.backgroundUtterances,0),
  dsaSourceTopicFamilies:topics.length,dsaShortQuestions:dsa.shortQuestions.length,
  dsaActualAnswerOverlapLaunches:dsa.activeAnswerOverlapLaunches,dsaImmediatePreparedFollowups:dsa.immediatePreparedFollowups},
 dsaTopicAnnotations:topics,
 annotationScope:'Manual labels for the exact spoken source questions, including context-carrying terse references. Each source-question hash binds the label. Topic breadth is not a factual accuracy or recognized-constraint verdict.',
 endpointConvention:'The playback helper legacy lastNonzeroFrame field is the exclusive consumed-frame end position. The waveform checker separately reports the zero-based last nonzero frame index and asserts endPosition=index+1. The recorded device-position host intervals are unchanged.',
 pending:['Full-hour systems and general recordings and their delivery/topic audits.','The literal midpoint-pause runtime probe.','Independent model review and source-bound accuracy/phrase summaries.','ChatGPT final-prompt and actual playback backend comparison.'],
 productionLogicChanged:false,goalComplete:false,
 scope:'Offline verification of actual completed playback delivery, waveform identity, question breadth and request overlap. Prepared follow-up launch gaps use recorded prior answer-basis time, not an inferred human reaction time or latency pass/fail target. All accuracy, cancellation and missing-word findings remain separate.'};
await writeFile('docs/evidence/delivery-and-topic-coverage-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:'docs/evidence/delivery-and-topic-coverage-v70.json',summary:report.summary}));
