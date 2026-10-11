import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const file='artifacts/deep-interview-v70/algorithms-hour-t/interview.json',bytes=await readFile(file),j=JSON.parse(bytes);
assert(j.status==='complete'&&j.stoppedCleanly);
const synthesisFile='scripts/synthesize-interview-question.ps1',synthesis=await readFile(synthesisFile),text=synthesis.toString();
assert(text.includes('$speaker.Speak($questionText)')&&text.includes('[Security.SecurityElement]::Escape'));
assert.equal(j.diagnosticSourceHashes[synthesisFile],hash(synthesis));
const report={recordedAt:new Date().toISOString(),journal:{file,sha256:hash(bytes)},synthesizer:{file:synthesisFile,sha256:hash(synthesis),
 mechanism:'The exact text file is given to the installed English System.Speech voice. Pause variants XML-escape the same text into SSML; exact-gap variants separately synthesize unchanged pieces.'},
 examples:[3,4,39,40].map(n=>{const r=j.rows.find(r=>r.round===n);return {round:n,intendedSourceText:r.question,recognizedQuestion:r.recognizedQuestion,waveformSha256:r.audio.sha256,waveFile:r.audio.waveFile};}),
 interpretation:{accuracyReference:'Independent reviewers judge against the intended source text and see the actual recognized question separately. These are intended-source recorded-answer judgments, not a pure underlying-model accuracy estimate.',
 phoneticGroundTruthIndependentlyValidated:false,
 lexicalEditMetric:'Source-text versus recognized-text edit rate includes number spelling, punctuation and spoken-code representations. It is not semantic accuracy or an isolated ASR error estimate.',
 signAttribution:'Raw tuple signs and sentinel spellings differ in the examples. The saved waveform proves which audio was played but not how every symbol was pronounced. A missing minus sign cannot be attributed solely to ASR without independently checking the waveform pronunciation; synthesis, recognition and answer handling are distinct possible contributors.',
 identifierCase:'Spoken identifier capitalization can be ambiguous. The general CRT lowercase/uppercase entry-point mismatch is retained as a source-text contract check separately from its mathematical execution diagnostic.',
 noRetcon:'Recorded text, audio, answers, cached model verdicts and strict code-contract results remain unchanged. This qualification does not convert failed text contracts into passes.'},
 scope:'Read-only audit of recorded synthesis and grading scope. It does not claim a new audio transcription, human listening check, synthesis fault or recognition fault. No source question, candidate answer or production behavior is changed.'};
await writeFile('docs/evidence/speech-source-accuracy-scope-v70.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({synthesisSourceHashMatchesRecording:true,phoneticGroundTruthIndependentlyValidated:false,intendedSourceAccuracyScopeRecorded:true}));
