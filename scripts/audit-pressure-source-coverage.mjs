import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [directory]=process.argv.slice(2);assert(directory,'RECORDING_DIRECTORY');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>{const bytes=await readFile(file);return {file,sha256:hash(bytes),data:JSON.parse(bytes)};};
const recording=await read(path.join(directory,'interview.json'));
const alignment=await read(path.join(directory,'pressure-token-alignment.json'));
const projection=await read(path.join(directory,'pressure-review-input.json'));
assert(recording.data.status==='complete'&&recording.data.stoppedCleanly);
assert.equal(alignment.data.journalSha256,recording.sha256);
assert.equal(projection.data.derivedFrom.journalSha256,recording.sha256);
assert.equal(projection.data.derivedFrom.tokenAlignmentSha256,alignment.sha256);
const rows=recording.data.continuousPressure.segments.map(segment=>{
 const aligned=alignment.data.alignment.filter(item=>item.sourceIndex!==null&&alignment.data.source[item.sourceIndex].sequence===segment.sequence);
 const recognized=aligned.filter(item=>item.recognizedIndex!==null).map(item=>item.recognizedIndex);
 const jobs=projection.data.rows.filter(row=>recognized.some(index=>index>=row.sourceBinding.recognizedSpan.start&&index<=row.sourceBinding.recognizedSpan.end));
 const covered=recognized.filter(index=>jobs.some(row=>index>=row.sourceBinding.recognizedSpan.start&&index<=row.sourceBinding.recognizedSpan.end));
 return {sequence:segment.sequence,clipId:segment.clipId,kind:segment.kind,sourceText:segment.text,
  sourceTextSha256:hash(Buffer.from(segment.text)),sourceWords:aligned.length,alignedRecognizedWords:recognized.length,
  sourceWordsDeletedByAsr:aligned.filter(item=>item.kind==='deletion').map(item=>alignment.data.source[item.sourceIndex]),
  sourceWordsSubstitutedByAsr:aligned.filter(item=>item.kind==='substitution').map(item=>({source:alignment.data.source[item.sourceIndex],recognized:alignment.data.recognized[item.recognizedIndex]})),
  recognizedWordsRepresentedInFinalNativeQuestions:covered.length,
  everyAlignedRecognizedWordRepresentedInFinalNativeQuestion:covered.length===recognized.length,
  nativeJobs:jobs.map(row=>({trial:row.trial,id:row.sourceBinding.nativeQuestionId,phase:row.phase,cancelled:row.cancelled,
   error:row.error,answerChars:row.answer.length,answerSha256:hash(Buffer.from(row.answer)),
   sourceFragments:row.sourceBinding.sourceFragments.filter(fragment=>fragment.sequence===segment.sequence)}))};
});
const summary={sourceUtterances:rows.length,sourceWords:rows.reduce((sum,row)=>sum+row.sourceWords,0),
 asrDeletedSourceWords:rows.reduce((sum,row)=>sum+row.sourceWordsDeletedByAsr.length,0),
 asrSubstitutedSourceWords:rows.reduce((sum,row)=>sum+row.sourceWordsSubstitutedByAsr.length,0),
 utterancesWithoutAnyFinalNativeJob:rows.filter(row=>!row.nativeJobs.length).length,
 utterancesWithRecognizedWordsAbsentFromFinalNativeQuestions:rows.filter(row=>!row.everyAlignedRecognizedWordRepresentedInFinalNativeQuestion).length,
 utterancesRepresentedAcrossMultipleNativeJobs:rows.filter(row=>row.nativeJobs.length>1).length,
 backgroundOnlyFinalNativeJobs:projection.data.rows.filter(row=>row.sourceBinding.sourceFragments.every(fragment=>fragment.kind==='background')).length,
 sourceKinds:Object.fromEntries([...new Set(rows.map(row=>row.kind))].map(kind=>[kind,rows.filter(row=>row.kind===kind).length]))};
const record={recordedAt:new Date().toISOString(),evidence:[recording,alignment,projection].map(({file,sha256})=>({file,sha256})),
 model:recording.data.model,effort:recording.data.effort,outputDevice:recording.data.outputDevice,summary,rows,
 semanticAccuracyCertified:false,
 scope:'Per-played-source utterance diagnostic of global lexical alignment and exact recorded native question spans. Every recognized token can be retained while its job is ignored, cancelled, incomplete, or answers a later topic. Source substitutions and deletions remain separate failures. Repeated words permit alternative alignments; this is not a semantic clause-preservation certificate, an assertion that all utterances were answered, or an invented per-utterance response deadline. Per-native-job accuracy and concrete continuation/background/stale findings are recorded separately.'};
await writeFile(path.join(directory,'pressure-source-coverage-audit.json'),JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify(summary));
