// Offline measurement only. Never imported by the live assistant.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const difference = (end, start) => Number.isFinite(end) && Number.isFinite(start) ? end - start : null;

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
  return {count:n, median:n ? (sorted[Math.floor((n-1)/2)] + sorted[Math.floor(n/2)]) / 2 : null,
    sampleP95:n ? sorted[Math.ceil(.95*n)-1] : null, max:sorted.at(-1) ?? null};
}

// Lexical disagreement with the synthesized source, not semantic accuracy.
// Case and punctuation are ignored; numeral/name normalization is not guessed.
export function transcriptWordError(reference, transcript) {
  if (typeof reference !== 'string' || typeof transcript !== 'string') return null;
  const words = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const a = words(reference), b = words(transcript);
  if (!a.length) return null;
  let previous = Array.from({length:b.length+1}, (_, i) => i);
  for (let i=1; i<=a.length; i++) {
    const current = [i];
    for (let j=1; j<=b.length; j++) current[j] = Math.min(
      previous[j]+1, current[j-1]+1, previous[j-1]+Number(a[i-1] !== b[j-1]));
    previous = current;
  }
  return {referenceWords:a.length, transcriptWords:b.length, edits:previous[b.length],
    rate:previous[b.length]/a.length};
}

export function qualitySummary(rows) {
  const verdicts = ['correct','incorrect','incomplete'];
  const graded = rows.filter(row => verdicts.includes(row.modelGrade));
  const grades = Object.fromEntries(verdicts.map(verdict => [verdict, graded.filter(row => row.modelGrade===verdict).length]));
  const booleanDimension = key => {
    const assessed = rows.filter(row => typeof row[key] === 'boolean');
    const passed = assessed.filter(row => row[key]).length;
    return {assessed:assessed.length, true:passed, false:assessed.length-passed};
  };
  const lexical = rows.map(row => row.transcriptWordError).filter(Boolean);
  const referenceWords = lexical.reduce((sum, row) => sum+row.referenceWords, 0);
  const edits = lexical.reduce((sum, row) => sum+row.edits, 0);
  return {
    modelGrades:grades, graded:graded.length, ungraded:rows.length-graded.length,
    modelGradedCorrectRate:graded.length ? grades.correct/graded.length : null,
    constraintTracking:booleanDimension('constraintTracking'),
    missingInformationHandled:booleanDimension('missingInformationHandled'),
    unsupportedAssumption:booleanDimension('unsupportedAssumption'),
    recognizedClausePreservation:booleanDimension('preservesRecognizedClauses'),
    lexicalAsr:{assessed:lexical.length, referenceWords, edits, normalizedWordErrorRate:referenceWords ? edits/referenceWords : null},
  };
}

export function counterSummary(rows, key) {
  const known = rows.map(row => row[key]).filter(Number.isFinite);
  return {assessed:known.length, total:known.length ? known.reduce((sum,value)=>sum+value,0) : null,
    roundsWithAny:known.filter(value=>value>0).length};
}

export function interviewCoverage(rows) {
  const questions=new Map(),topics=new Map();
  let knownQuestions=0,knownTopics=0;
  for (const row of rows) {
    if (typeof row.question==='string' && row.question.trim()) {
      // Case and operators can change a coding question's meaning.
      const key=row.question.trim().replace(/\s+/gu,' ');
      questions.set(key,[...(questions.get(key)??[]),row.round]);
      knownQuestions++;
    }
    const topic=row.review?.currentTopic;
    if (typeof topic==='string' && topic.trim()) {
      const key=topic.trim();
      topics.set(key,(topics.get(key)??0)+1);
      knownTopics++;
    }
  }
  return {knownQuestions,unknownQuestions:rows.length-knownQuestions,uniqueQuestions:questions.size,
    repeatedQuestionGroups:[...questions.values()].filter(rounds=>rounds.length>1),
    knownTopics,unknownTopics:rows.length-knownTopics,modelTopicCounts:Object.fromEntries(topics),
    scope:'Exact question repetitions normalize whitespace only. Unique strings do not establish semantic novelty or uniform randomness. Topic descriptions are free-form model assessments of actual questions, not independently certified coverage.'};
}

export function exactTranscriptAvailability(row) {
  const floor=row.latency?.remoteSpeechStartedAt;
  const text=value=>typeof value==='string'&&value.trim()?value.trim().replace(/\s+/gu,' '):null;
  const finalText=text(row.recognizedQuestion);
  const observations=Number.isFinite(floor)&&Array.isArray(row.candidateObservations)
    ? row.candidateObservations.map(event=>event.payload)
      .filter(event=>event?.floor===floor&&Number.isFinite(event.observedAt))
      .sort((a,b)=>a.observedAt-b.observedAt) : [];
  const matches=event=>finalText!==null&&text(event.text)===finalText;
  const first=observations.find(matches);
  let stable=null;
  for (let i=observations.length-1;i>=0&&matches(observations[i]);i--) stable=observations[i];
  return {candidateObservations:observations.length,
    firstExactTextFromSpeechEndMs:difference(first?.observedAt,row.speechEndNativeMs),
    lastStableExactTextFromSpeechEndMs:difference(stable?.observedAt,row.speechEndNativeMs),
    stableExactTextToRequestMs:difference(row.latency?.pipeline?.latestInputSent,stable?.observedAt)};
}

export function verifiedReviewFindings(report, review) {
  if (!review) return null;
  const hash = text => createHash('sha256').update(text).digest('hex');
  assert(Array.isArray(review.findings),'Independent review must provide findings');
  for (const finding of review.findings) {
    const row = report.rows.find(row => row.round===finding.round);
    assert(row && typeof row.question==='string' && typeof row.answer==='string','Review round lacks recorded answer');
    assert.equal(finding.questionSha256,hash(row.question),'Review question identity mismatch');
    assert.equal(finding.answerSha256,hash(row.answer),'Review answer identity mismatch');
  }
  return {scope:review.scope??null, findings:review.findings,
    roundsWithFindings:new Set(review.findings.map(finding=>finding.round)).size,
    scopeLimit:'Recorded findings are a selective review, not a correctness rate for every round.'};
}
