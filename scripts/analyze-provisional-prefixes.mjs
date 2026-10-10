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
  const prefixes=[...groups.values()].filter(p=>Number.isFinite(p.firstWordObservedAt)).map(p=>({
    id:p.id,revision:p.revision,question:p.question,contextKey:p.contextKey,prefix:p.prefix,
    firstWordFromSpeechEndMs:p.firstWordObservedAt-end,
    sameQuestionText:typeof row.recognizedQuestion==='string'&&identity(p.question)===identity(row.recognizedQuestion),
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
    prefixes,earlierDifferentQuestionPrefixes:prefixes.filter(p=>p.firstWordFromSpeechEndMs<0&&!p.sameQuestionText).length,
    literalMatchingPrefixesBeforeEnd:prefixes.filter(p=>p.firstWordFromSpeechEndMs<0&&p.literalPrefixOfRetainedAnswer).length,
    largestRetainedTextUpdateIntervalMs:gaps.length?Math.max(...gaps):null,
    rawFinalBoundaries:finals,modelReview:row.review??null};
});
const audit={scope:'Longest bounded unvalidated decoded prefix per job/revision/question/context frame; shorter cumulative snapshots are not tested for literal matching. Matching question text does not establish matching context or correctness; matching final text does not certify either answer. Update intervals are host polling observations, not a human speaking-gap measurement. Raw ASR timestamps refer to the latest submitted chunk, not word alignment. No prefix reuse is authorized by this report.',
  model:report.model,effort:report.effort,tier:report.tier,binarySha256:report.nativeBinarySha256,
  sourceHashes:report.sourceHashes,diagnosticSourceHashes:report.diagnosticSourceHashes,
  speechConfiguration:report.speechConfiguration,rows};
await writeFile(path.join(directory,'provisional-prefix-audit.json'),JSON.stringify(audit,null,2));
console.log(JSON.stringify({output:path.relative(process.cwd(),path.join(directory,'provisional-prefix-audit.json')),
  rows:rows.length,differentQuestionPrefixesBeforeEnd:rows.reduce((s,r)=>s+r.earlierDifferentQuestionPrefixes,0),
  literalMatchingPrefixesBeforeEnd:rows.reduce((s,r)=>s+r.literalMatchingPrefixesBeforeEnd,0)}));
