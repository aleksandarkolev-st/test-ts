// Actual elapsed-hour workload, using public source audio and explicit changed
// constraints. This is evaluation data; no production decision reads this file.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const source='tests/fixtures/controller-hour-session.json';
const bytes=await readFile(source),hour=JSON.parse(bytes);
const out=path.resolve(process.argv[2]??'artifacts/controller-v72/prepared/marathon-session.json');
assert(out.startsWith(process.cwd()+path.sep));
const turns=[];
for(let block=0;block<3;block++){
 for(const item of hour.turns){
  // The application and ledger never restart during this workload. Frozen
  // process-age controls belong to their separate factorial cells.
  if(item.fixedContext!=null)continue;
  const turn={...item,name:`hour-${block+1}-${item.name}`,atMs:block*3600000+item.atMs};
  delete turn.clearFixedContext;
  if(block>0&&item.name==='first-code'){
   turn.question=block===1
    ? 'Correction to the Foo implementation from the first hour: the guard is now x <= -1. Preserve the original version. Show both exact code versions and evaluate each at -1. Which version is currently requested?'
    : 'Refer to the Foo correction in the second hour. Keep both source versions. Give a concrete input where the two versions differ, explain why, and repeat the original first-hour function byte for byte in one code fence.';
  }
  if(block>0&&item.name==='session-decision'){
   delete turn.waveFile;delete turn.waveSha256;
   turn.question=block===1
    ? 'New separate decision: project Sigma retains data for exactly 29 days, owner Nils, checkpoint Sigma_29. Delta remains separate. Keep both decisions and identify the scope of each.'
    : 'Correction for Sigma only: retention becomes 31 days and owner becomes Ada. Preserve Sigma\'s prior decision as a superseded version. Delta remains unchanged. Explain the difference between a correction and an independent decision.';
  }
  if(block>0&&item.name==='code-after-20-plus-turns'){
   turn.question='Recall the original first-hour Foo function exactly, including its original comparison operator and formatting. Then separately give the later corrected version, and evaluate both at -1. Do not replace the original with the correction.';
  }
  if(block>0&&item.name.startsWith('decision-after-')){
   turn.question='Recall the original Delta retention decision and checkpoint from the first hour. Then give the current Sigma decision and its previous version, if any. Explain which source statement changed which project; do not combine their retention periods or owners.';
  }
  turns.push(turn);
 }
 turns.push({name:`hour-${block+1}-reasoning-challenge`,atMs:block*3600000+3510000,
  question: block===0
   ? 'Challenge your previous CUDA and algorithm proofs: identify an essential precondition from each, construct a concrete counterexample when it is removed, and distinguish an actual correctness failure from a performance concern. Refer to actual claims from this meeting.'
   : block===1
    ? 'Return to the read/write quorum example from an earlier hour. Give the concrete incomplete-write, two-read execution again, using distinct replica sets. State exactly which step read write-back repairs and which concurrency assumptions are still necessary. Do not assume an unfinished writer must finish.'
    : 'Audit your reasoning across this meeting: select a CUDA synchronization claim and a numerical-stability claim, state the precise contract of each, and give a changed condition that invalidates it. If you made a wrong earlier claim, identify the exact statement and correct it rather than defending it.'});
 turns.push({name:`hour-${block+1}-why`,atMs:block*3600000+3540000,question:'Why?',ordinaryFollowup:true});
}
turns.push({name:'three-hour-original-recall',atMs:10800000,
 question:'After three hours, repeat the original first-hour Foo function exactly, then its corrected version separately. Recall the original Delta decision, Sigma\'s initial decision and its correction. Distinguish exact recognized source facts from any uncertainty or suggestion. Explain the branch result at -1 in each code version.'});
turns.sort((a,b)=>a.atMs-b.atMs);
await mkdir(path.dirname(out),{recursive:true});
await writeFile(out,JSON.stringify({model:hour.model,effort:hour.effort,objective:hour.objective,serviceTier:hour.serviceTier,
 minimumDurationMs:10800000,continuousSession:true,sourceFixture:{file:source,sha256:createHash('sha256').update(bytes).digest('hex')},turns},null,2)+'\n');
console.log(JSON.stringify({plan:path.relative(process.cwd(),out),turns:turns.length,minimumElapsedMs:10800000,continuousSession:true}));
