import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=async file=>{const b=await readFile(file);return {file,sha256:hash(b),value:JSON.parse(b)};};
const base='artifacts/deep-interview-v70/general-hour-t';
const journal=await read(`${base}/interview.json`),duration=await read(`${base}/duration-audit.json`),delivery=await read(`${base}/delivery-coverage-audit.json`),states=await read(`${base}/observed-turn-state-audit.json`);
const split=await read('docs/evidence/general-split-question-v70.json'),numerical=await read('docs/evidence/general-numerical-checks-v70.json');
const crt=await read(`${base}/code-review/crt-execution-evidence.json`),erasure=await read(`${base}/code-review/erasure-execution-evidence.json`),publication=await read(`${base}/code-review/publication-execution-evidence.json`);
assert(journal.value.status==='complete'&&journal.value.stoppedCleanly);assert.equal(duration.value.journalSha256,journal.sha256);assert.equal(delivery.value.journal.sha256,journal.sha256);assert.equal(states.value.journalSha256,journal.sha256);
assert.equal(split.value.journal.sha256,journal.sha256);assert.equal(numerical.value.journal.sha256,journal.sha256);
assert.equal(crt.value.sourceJournalSha256,journal.sha256);assert.equal(erasure.value.sourceJournalSha256,journal.sha256);
const families=[{name:'Operations, staffing, outsourcing, service contracts',rounds:[1,2,3,4,39,40]},
 {name:'Exact arithmetic, floating-point counterexamples, signed bounds',rounds:[5,6,7,12,25,26,37,38]},
 {name:'Streaming and rolling-window statistics, arbitrary arrival and concurrency',rounds:[8,9,10,11,20,21,22,23,24]},
 {name:'Marketing experiments, causality, Simpson paradox and sequential stopping',rounds:[13,14,15,16]},
 {name:'Distributed quorum and atomic register semantics',rounds:[17,18,19]},
 {name:'Physics and heat balance',rounds:[27]},
 {name:'Public older-code reference',rounds:[28]},
 {name:'RSA common-modulus, nonunit messages and CRT candidate construction',rounds:[29,30,31,32,33,34,35,36]},
 {name:'Filesystem atomicity, generation publication, reader protection and reclamation',rounds:[41,42,43,44,45,46,47,48,49,50,51,52]},
 {name:'Error-correcting codes, miscorrection, erasures and binary elimination',rounds:[53,54,55,56,57,58]}];
assert.deepEqual(families.flatMap(f=>f.rounds).sort((a,b)=>a-b),journal.value.rows.map(r=>r.round));
const report={recordedAt:new Date().toISOString(),evidence:[journal,duration,delivery,states,split,numerical,crt,erasure,publication].map(({file,sha256})=>({file,sha256})),
 model:journal.value.model,effort:journal.value.effort,examinerModel:journal.value.examinerModel,examinerEffort:journal.value.examinerEffort,
 outputDevice:journal.value.outputDevice,speechConfiguration:journal.value.speechConfiguration,actualInterviewDurationMs:journal.value.actualInterviewDurationMs,
 recordedTurns:journal.value.rows.length,primaryFirstRetainedVisibleWordMs:duration.value.summary.firstRetainedVisibleWordMs,
 missingVisibleWords:duration.value.summary.turnsWithoutVisibleWord,cancelled:duration.value.summary.cancelled,errors:duration.value.summary.errors,
 delivery:delivery.value.summary,observedTurnStates:states.value.summary,
 manuallyAnnotatedActualTopicFamilies:families.map(f=>({...f,sourceQuestions:f.rounds.map(n=>({round:n,question:journal.value.rows.find(r=>r.round===n).question}))})),
 selectedSubstantiveChecks:{numerical:numerical.file,crtStrictEntryPointFailures:crt.value.strictEntryPointContract.failures,
 crtDiagnosticFailures:crt.value.translatedEntryPointMathematicalDiagnostic.failures,erasureFiniteFailures:erasure.value.failures,
 publicationOwnTestsPassed:publication.value.candidateAuthoredMainTestsPassed,originalCandidateSourcesPatched:false},
 sourceSplitQualification:'Round 8 spans two native jobs; its earlier clauses occur in actual final selected context. The row-only 60 percent lexical disagreement does not establish captured-clause deletion; ordered native-job union disagreement is 7.826 percent.',
 olderReferenceQualification:'Round 28 references round 7 after twenty intervening source turns. Round 7 contained counterexample assignments, not a function implementation with a signature; asking for an exact implementation is ambiguous. This probe is not treated as a definitive code-memory failure.',
 durationCutoff:{round:58,recordedPhase:journal.value.rows.at(-1).phase,recordedAnswerChars:journal.value.rows.at(-1).answer.length,
 completedAt:journal.value.rows.at(-1).latency.completedAt,error:journal.value.rows.at(-1).error,
 finalObservedAnswerDifferent:states.value.rows.at(-1).capturedAnswerEqualsLastObserved===false,
 explanation:'The duration cap ended during the final response. A subsequent native observation contains 47 additional characters, still without completion. The exact answer captured at turn end remains the grading input. This is observation censoring, not a recorded backend timeout.'},
 resources:{native:duration.value.summary.nativeProcessResources,recorder:duration.value.summary.recordingProcessResources,nativeTree:duration.value.summary.nativeProcessTreeResources},
 independentAccuracyPending:true,scope:'Final clean general-hour recording with immutable source, actual delivery and topics, selected finite checks and final-state qualifications. Code-entry-point capitalization and algorithm mathematics remain separate. Finite execution and candidate-authored tests do not certify every answer, arbitrary concurrency or crash durability. No production changes or source-answer injection.'};
await writeFile('docs/evidence/completed-general-recording-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({minutes:report.actualInterviewDurationMs/60000,turns:report.recordedTurns,topicFamilies:families.length,primary:report.primaryFirstRetainedVisibleWordMs,missing:report.missingVisibleWords,cancelled:report.cancelled,errors:report.errors,independentAccuracyPending:true}));
