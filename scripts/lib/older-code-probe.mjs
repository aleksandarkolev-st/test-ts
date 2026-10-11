import {createHash} from 'node:crypto';
import {fencedSources} from './fenced-sources.mjs';

// Evaluation interviewer behavior only. Candidate sees an earlier public
// question reference, never the code or a private expected answer.
export function olderCodeProbe(rows,latest,nextRound){
 for(const row of rows){
  if(nextRound-row.round<=20)continue;
  const id=row.responseVersion?.split(':')[0],job=latest.get(id);
  if(!job||job.cancelled||job.latency?.completedAt==null||!fencedSources(job.answer).length)continue;
  const reference=row.question.split(/\s+/u).slice(0,45).join(' ');
  return {text:`Return to the FIRST completed implementation you supplied for this original question: ${reference} Refer to that exact original implementation, including its entry-point signature and return contract. Distinguish it from later corrected or superseding versions in our conversation. Explain which original constraints apply. Reproduce that implementation rather than inventing a replacement; if the reference is genuinely ambiguous, ask a precise clarification.`,
   sourceRound:row.round,probeRound:nextRound,turnDistance:nextRound-row.round,interveningTurns:nextRound-row.round-1,
   sourceResponseVersion:`${id}:${job.latency.responseRevision??0}`,
   sourceAnswerSha256:createHash('sha256').update(job.answer).digest('hex'),
   sourceQuestion:row.question,sourceAnswer:job.answer,
   provenanceScope:'Actual completed earlier public answer observed before probe preparation. Stored for independent version comparison; its code is not supplied in the new spoken question.'};
 }
 return null;
}
