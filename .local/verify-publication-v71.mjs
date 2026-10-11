// Verify actual remote branch heads before recording publication evidence.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [output,...branches]=process.argv.slice(2);
assert(output&&branches.length,'Supply output and branch names');
const git=args=>execFileSync('git',args,{encoding:'utf8',windowsHide:true,
 env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}}).trim();
const origin=git(['remote','get-url','origin']);
const url=new URL(origin);assert(!url.username&&!url.password,'Credential-free remote required');
const refs=branches.map(branch=>{git(['check-ref-format','--branch',branch]);return 'refs/heads/'+branch;});
const remoteOutput=git(['ls-remote','origin',...refs]);
const remote=new Map(remoteOutput.split(/\r?\n/).filter(Boolean).map(line=>line.split(/\s+/).reverse()));
const verified=branches.map((branch,index)=>{
 const local=git(['rev-parse','--verify',refs[index]]),published=remote.get(refs[index]);
 assert.equal(published,local,'Remote differs from local: '+branch);
 return {branch,localCommit:local,remoteCommit:published,matched:true};
});
const sourceAudit='docs/evidence/measured-goal-scope-audit-v71.json';
const bytes=await readFile(sourceAudit),audit=JSON.parse(bytes);
assert.equal(audit.status,'recording_and_review_scope_verified');
assert.equal(audit.allSpecifiedTestsExecutedAndReviewed,true);
const result={verifiedAt:new Date().toISOString(),origin,branches:verified,
 status:'remote_heads_verified',sourceAudit:{file:sourceAudit,
 sha256:createHash('sha256').update(bytes).digest('hex')},
 scope:'Published branch heads at verification time. Later documentation commits may advance main. Recording/review completion does not certify all expected product behaviors or universal candidate improvement.',
 allRequiredProductBehaviorsDemonstrated:audit.allRequiredProductBehaviorsDemonstrated,
 candidateUniversalImprovementEstablished:audit.candidateUniversalImprovementEstablished};
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,status:result.status,branches:verified}));
