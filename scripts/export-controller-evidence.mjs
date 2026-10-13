// Compact, source-bound synthetic validation evidence. Never copy profiles,
// account databases, tokens or raw session context into reviewable artifacts.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {measureJournal} from './lib/controller-measurements.mjs';
const [journalFile,reviewFile,outFile,...checkFiles]=process.argv.slice(2);
assert(journalFile&&reviewFile&&outFile,'JOURNAL REVIEW OUTPUT [CODE_RESULTS...]');
const root=process.cwd(),out=path.resolve(outFile);
assert(out.startsWith(path.resolve('docs/evidence')+path.sep),'Export only into repository evidence');
const sha=x=>createHash('sha256').update(x).digest('hex');
const bytes=await readFile(journalFile),j=JSON.parse(bytes),reviewBytes=await readFile(reviewFile),reviews=JSON.parse(reviewBytes);
assert.equal(j.status,'complete');assert.equal(reviews.journalSha256,sha(bytes));
assert.equal(j.model,'gpt-6.1-sol');assert.equal(j.effort,'low');
const verdicts=new Map(reviews.rows.map(r=>[r.round,r]));
for(const row of j.rows){assert(verdicts.has(row.round),'Every row requires explicit review');assert.equal(verdicts.get(row.round).answerSha256,sha(row.answer));}
const checks=[];
for(const file of checkFiles){const data=await readFile(file),check=JSON.parse(data);assert.equal(check.journalSha256??check.journal?.sha256,sha(bytes),'Code checks must bind this exact capture');
 checks.push({file:path.relative(root,path.resolve(file)),sha256:sha(data),result:check});}
const evidence={schemaVersion:1,scope:j.scope,reviewScope:reviews.scope,
 journalFile:path.relative(root,path.resolve(journalFile)),journalSha256:sha(bytes),reviewSha256:sha(reviewBytes),
 measurementSourceSha256:sha(await readFile('scripts/lib/controller-measurements.mjs')),
 collectorSha256:j.collectorSha256,nativeBinarySha256:j.nativeBinarySha256,buildEvidence:j.buildEvidence,
 renderer:j.renderer,backend:j.backend,authMode:j.authMode??'isolated',model:j.model,effort:j.effort,tier:j.tier,capabilities:j.capabilities,
 outputDevice:j.outputDevice,manifestSha256:j.manifestSha256,startedAt:j.startedAt,sessionStartedAt:j.sessionStartedAt,
 actualInterviewDurationMs:j.actualInterviewDurationMs,stoppedCleanly:j.stoppedCleanly,pollErrors:j.pollErrors,
 archive:j.archive,archiveBeforeStop:j.archiveBeforeStop??j.rows.at(-1)?.archive??null,
 archiveBeforeStopScope:j.archiveBeforeStop?'Explicit final snapshot before Stop.':'Last recorded row snapshot; older collector top-level archive could be overwritten by a post-Stop sampler poll.',
 archiveAfterStop:j.archiveAfterStop??null,
 resourceSamples:j.resourceSamples,measurements:measureJournal(j,reviews),checks,
 rows:j.rows.map(r=>({round:r.round,name:r.name,question:r.question,recognizedQuestion:r.recognizedQuestion,answer:r.answer,
  answerSha256:sha(r.answer),contextSha256:r.selectedContext==null?null:sha(r.selectedContext),
  expectedReply:r.expectedReply,atMs:r.atMs,applicationAgeMs:r.applicationAgeMs,settle:r.settle,
  responseVersion:r.responseVersion,phase:r.phase,error:r.error,cancelled:r.cancelled,latency:r.latency,
  sourceBinding:r.sourceBinding,waveSha256:r.waveSha256??r.audio?.sha256,referenceEvidence:r.referenceEvidence,
  runningAtSubmission:r.runningAtSubmission,runningAtPlaybackLaunch:r.audio?.runningAtPlaybackLaunch,
  displayedConditionMet:r.displayedConditionMet,faultInjection:r.faultInjection,
  replayAction:r.replayAction,boundParentGenerationId:r.boundParentGenerationId,
  focusBeforeExpansion:r.focusBeforeExpansion,focusAfterExpansion:r.focusAfterExpansion,
  boundDraftGenerationId:r.boundDraftGenerationId,focusBeforeExplicitAcceptance:r.focusBeforeExplicitAcceptance,focusAfterExplicitAcceptance:r.focusAfterExplicitAcceptance,
  firstStreamedWordMeasurement:r.firstStreamedWordMeasurement,
  review:verdicts.get(r.round)}))};
await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(evidence,null,2));
console.log(JSON.stringify({file:outFile,rows:evidence.rows.length,journalSha256:evidence.journalSha256}));
