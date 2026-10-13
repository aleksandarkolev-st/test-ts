import {createHash} from 'node:crypto';
// Evaluation-only: refer to a name actually used in an earlier recorded answer.
// Never feed the answer back as a hint, or manufacture a failed source answer.
export function recordedCodeReference(item,rows){
 if(!item.referenceTurn)return {question:item.question};
 const source=rows.find(row=>row.name===item.referenceTurn);
 const code=source?.answer?.match(/```(?:cpp|cuda|c\+\+)\s*\n([\s\S]*?)```/)?.[1];
 const names=[...new Set([...code?.matchAll(/__device__[^;{}]*?\bfloat\s+([A-Za-z_]\w*)\s*\(/g)??[]].map(m=>m[1]))];
 const sha=x=>createHash('sha256').update(x).digest('hex');
 if(!source||!code||!names.length)return {question:item.question.replaceAll('{{function}}','the earlier device function'),referenceEvidence:{sourceTurn:item.referenceTurn,available:false,reason:'Earlier complete device code is absent; recall cannot receive source-match credit.'}};
 return {question:item.question.replaceAll('{{function}}',names.join(', ')),
  referenceEvidence:{sourceTurn:item.referenceTurn,available:true,answerSha256:sha(source.answer),codeSha256:sha(code),names,
   scope:'Only actual function names enter this question; original code is not injected as a recall hint.'}};
}
