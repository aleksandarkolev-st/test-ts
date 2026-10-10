// Offline diagnosis only. Never imported by the app or used to authorize reuse.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const directory=path.resolve(process.argv[2]??'');
assert(process.argv[2]&&directory.toLowerCase().startsWith(process.cwd().toLowerCase()+path.sep));
const report=JSON.parse(await readFile(path.join(directory,'interview.json'),'utf8'));
assert.equal(report.status,'complete');assert.equal(report.stoppedCleanly,true);
assert.equal(report.provisionalDiagnostics?.enabled,true);
const identity=text=>typeof text==='string'?text.split(/\s+/u).join(' ').trim():null;
const rows=report.rows.map(row=>{
  const groups=new Map();
  for(const event of row.provisionalPrefixes??[]){
    const p=event.payload,key=JSON.stringify([p.id,p.revision,p.question,p.contextKey]);
    const previous=groups.get(key);
    if(!previous||p.prefix.length>=previous.prefix.length)groups.set(key,p);
  }
  const end=row.speechEndNativeMs;
  const jobId=row.responseVersion?.slice(0,row.responseVersion.lastIndexOf(':'));
  const frame=(row.receivedFrames??[]).map(event=>event.payload).find(p=>p.id===jobId&&p.revision===row.latency?.responseRevision);
  const candidates=(row.candidateObservations??[]).map(event=>event.payload).filter(p=>
    typeof p.text==='string'&&p.floor===row.latency?.remoteSpeechStartedAt&&identity(p.text)===identity(row.recognizedQuestion));
  const prefixes=[...groups.values()].filter(p=>Number.isFinite(p.firstWordObservedAt)).map(p=>({
    id:p.id,revision:p.revision,question:p.question,contextKey:p.contextKey,prefix:p.prefix,
    firstWordFromSpeechEndMs:p.firstWordObservedAt-end,
    sameQuestionText:typeof row.recognizedQuestion==='string'&&identity(p.question)===identity(row.recognizedQuestion),
    sameFinalContextFrame:frame?JSON.stringify(p.contextKey)===JSON.stringify(frame.contextKey):null,
    literalPrefixOfRetainedAnswer:typeof row.answer==='string'&&row.answer.startsWith(p.prefix),
    atCap:p.atCap,
  }));
  const samples=(row.samples??[]).filter(sample=>sample.responseVersion===row.responseVersion);
  const gaps=samples.slice(1).map((sample,index)=>sample.hostMs-samples[index].hostMs);
  const finals=(row.rawAsrBoundaries??[]).filter(event=>event.payload.final).map(event=>{
    const p=event.payload,chars=[...p.text];
    return {observedAt:p.observedAt,startedAt:p.startedAt,endedAt:p.endedAt,
      leadingWhitespace:/^\s/u.test(p.text),trailingWhitespace:/\s$/u.test(p.text),
      firstChars:chars.slice(0,16).join(''),lastChars:chars.slice(-16).join(''),chars:chars.length};
  });
  return {round:row.round,publicQuestion:row.question,recognizedQuestion:row.recognizedQuestion,
    retainedFirstWordFromSpeechEndMs:row.firstWordFromSpeechEndMs,
    firstExactCandidateFromSpeechEndMs:candidates.length?candidates[0].observedAt-end:null,
    firstExactCandidateBeforeFinalAsrMs:candidates.length&&Number.isFinite(row.latency?.transcriptFinalAt)?row.latency.transcriptFinalAt-candidates[0].observedAt:null,
    receivedFinalFrame:frame??null,
    prefixes,earlierDifferentQuestionPrefixes:prefixes.filter(p=>p.firstWordFromSpeechEndMs<0&&!p.sameQuestionText).length,
    literalMatchingPrefixesBeforeEnd:prefixes.filter(p=>p.firstWordFromSpeechEndMs<0&&p.literalPrefixOfRetainedAnswer).length,
    largestRetainedTextUpdateIntervalMs:gaps.length?Math.max(...gaps):null,
    rawFinalBoundaries:finals,modelReview:row.review??null};
});
const audit={scope:'Longest bounded unvalidated decoded prefix per job/revision/question/context frame; shorter cumulative snapshots are not tested for literal matching. Actor-observed exact candidates measure when recognized final text was actually available, not when it was spoken. Exact frame receipt certifies request/context identity only, not answer correctness. Matching final text does not certify either answer. Update intervals are host polling observations, not a human speaking-gap measurement. Raw ASR timestamps refer to the latest submitted chunk, not word alignment. No prefix reuse is authorized by this report.',
  model:report.model,effort:report.effort,tier:report.tier,binarySha256:report.nativeBinarySha256,
  sourceHashes:report.sourceHashes,diagnosticSourceHashes:report.diagnosticSourceHashes,
  speechConfiguration:report.speechConfiguration,rows};
await writeFile(path.join(directory,'provisional-prefix-audit.json'),JSON.stringify(audit,null,2));
console.log(JSON.stringify({output:path.relative(process.cwd(),path.join(directory,'provisional-prefix-audit.json')),
  rows:rows.length,differentQuestionPrefixesBeforeEnd:rows.reduce((s,r)=>s+r.earlierDifferentQuestionPrefixes,0),
  literalMatchingPrefixesBeforeEnd:rows.reduce((s,r)=>s+r.literalMatchingPrefixesBeforeEnd,0)}));
