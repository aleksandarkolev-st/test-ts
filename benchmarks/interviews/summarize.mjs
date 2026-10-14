// Summarize actual collected trials. Preparation and pilots never enter these counts.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const file=process.argv[2]??'artifacts/interview-suite/results.json';
const raw=await readFile(file);
const report=JSON.parse(raw);
if(report.pilot)throw Error('Pilot evidence is excluded from counted interview statistics');
let reviews;
try{reviews=JSON.parse(await readFile('docs/evidence/interview-contract-reviews.json','utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;}
const sha=value=>createHash('sha256').update(value).digest('hex');
const completed=report.rows.filter(row=>row.status==='responses_complete');
const rounds=completed.flatMap(row=>row.attempts.at(-1).rounds);
const retainedRounds=report.rows.flatMap(row=>row.attempts.flatMap(attempt=>attempt.rounds));
const distribution=key=>{
 const values=rounds.map(round=>round[key]).filter(Number.isFinite).sort((a,b)=>a-b);
 const percentile=p=>values.length?values[Math.ceil(values.length*p)-1]:null;
 return{samples:values.length,minMs:values[0]??null,medianMs:percentile(.5),p95Ms:percentile(.95),maxMs:values.at(-1)??null};
};
const rows=completed.map(row=>{
 const attempt=row.attempts.at(-1);
 const review=reviews?.runId===report.runId&&JSON.stringify(reviews.fingerprint)===JSON.stringify(report.fingerprint)
  ?reviews.entries.find(entry=>entry.id===row.id&&entry.kind===row.kind&&entry.finalAnswerSha256===sha(attempt.rounds[2].answer)):null;
 return{id:row.id,kind:row.kind,attempts:row.attempts.length,incompleteAttempts:row.attempts.filter(a=>!a.completedAt).length,
  markerCorrect:attempt.rounds.every(round=>round.markerCorrect),
  functionalPassed:attempt.functionalPassed,
  firstImplementationPassed:attempt.rounds[1]?.grade?.passed??false,
  finalImplementationPassed:attempt.rounds[2]?.grade?.passed??false,
  renderedSourceMatches:attempt.rounds.every(round=>round.renderedSourceMatches),
  acceptedPaints:attempt.rounds.reduce((sum,round)=>sum+round.paints.filter(p=>p.accepted).length,0),
  paintSourceMatches:attempt.rounds.every(round=>round.paints.length>0&&round.paints.every(p=>p.accepted&&p.id===round.id&&round.answer.slice(p.start,p.end)===p.source)),
  keyboardPassed:attempt.reading?.passed??false,
  manualContractReview:review?{passed:review.finalContractPassed,note:review.note,evidence:review.evidence}:row.manualContractReview,
  diagnosisReview:review?.diagnosisReview??row.diagnosisReview};
});
console.log(JSON.stringify({source:file,sourceSha256:createHash('sha256').update(raw).digest('hex'),
 runId:report.runId,status:report.status,model:report.model,reasoningEffort:report.reasoningEffort,
 required:report.required,completed:{regular:completed.filter(r=>r.kind==='regular').length,bug:completed.filter(r=>r.kind==='bug').length},
 scope:'Text-driven native trials. Functional fixture counts are separate from contract and diagnosis review. No ASR accuracy claim.',
 latencyScope:'Latest completed attempt per interview. Incomplete/retried responses remain in raw evidence and retainedResponses counts.',
 retainedResponses:{total:retainedRounds.length,completedAttemptResponses:rounds.length,
  incompleteAttempts:report.rows.reduce((sum,row)=>sum+row.attempts.filter(a=>!a.completedAt).length,0)},
 checks:{denominator:rows.length,firstImplementationFixturesPassed:rows.filter(r=>r.firstImplementationPassed).length,
  finalImplementationFixturesPassed:rows.filter(r=>r.finalImplementationPassed).length,
  allMarkersCorrect:rows.filter(r=>r.markerCorrect).length,paintSourcesExact:rows.filter(r=>r.paintSourceMatches).length,
  keyboardPassed:rows.filter(r=>r.keyboardPassed).length,finalContractsReviewed:rows.filter(r=>typeof r.manualContractReview==='object').length,
  finalContractsPassed:rows.filter(r=>r.manualContractReview?.passed===true).length},
 firstWord:distribution('firstWordMs'),completion:distribution('completedMs'),firstPaint:distribution('firstPaintMs'),
 incomplete:report.rows.filter(r=>r.status!=='responses_complete').map(r=>({id:r.id,status:r.status,attempts:r.attempts.length})),rows},null,2));
