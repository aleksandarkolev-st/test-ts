// Post-capture comparison of all primary cells, retaining setup failures.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {measureJournal} from './lib/controller-measurements.mjs';
const [runDirectory,outFile,codeRun='r3']=process.argv.slice(2);
assert(runDirectory&&outFile,'RUN_DIRECTORY OUTPUT_FILE');
assert(/^r\d+$/.test(codeRun),'Code run must identify a preserved grader run');
const sha=b=>createHash('sha256').update(b).digest('hex');
const root=process.cwd(),out=path.resolve(outFile);
assert(out.startsWith(path.resolve('docs/evidence')+path.sep));
const manifestBytes=await readFile(path.join(runDirectory,'policy-playback/manifest.json')),manifest=JSON.parse(manifestBytes);
const cells=[],pairs=[];
for(let repetition=1;repetition<=manifest.repetitions;repetition++)for(let index=0;index<manifest.cases.length;index++){
 const source=manifest.cases[index],pair={caseIndex:index,name:source.name,repetition,waveSha256:source.wave.sha256,contextSha256:source.contextSha256,cells:[]};
 for(const variant of ['baseline','controller']){
  const name=`case-${index}-rep${repetition}-${variant}`,directory=path.join(runDirectory,'native',name),pbytes=await readFile(path.join(directory,'playback.json')),playback=JSON.parse(pbytes);
  assert(['complete','failed'].includes(playback.status),'Comparison capture still running');
  assert.equal(playback.model,'gpt-6.1-sol');assert.equal(playback.effort,'low');
  const cell={name,variant,caseIndex:index,repetition,captureStatus:playback.status,playbackSha256:sha(pbytes),nativeBinarySha256:playback.nativeBinarySha256,buildEvidence:playback.buildEvidence,renderer:playback.renderer,
   failure:playback.error??null,correctness:'unverified',reasoningVerdict:'unverified',answerLatencyAvailable:false,codeRequired:[0,2,4,5].includes(index),codeChecksPending:false};
  if(playback.status==='complete'){
   const trial=playback.trials[0],bytes=await readFile(path.join(trial.outputDirectory,'interview.json')),journal=JSON.parse(bytes);
   assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);assert.equal(journal.rows.length,1);
   const r=journal.rows[0],reviewBytes=await readFile(path.join(runDirectory,'reviews',name+'-reviewed.json')),review=JSON.parse(reviewBytes);
   assert.equal(review.journalSha256,sha(bytes));assert.equal(review.rows[0].answerSha256,sha(r.answer));
   assert.equal(r.audio.sha256,source.wave.sha256);assert.equal(r.selectedContext,source.selectedContext);
   const metrics=measureJournal(journal,review),measurement=metrics.rows[0],p=r.latency?.pipeline??{};
   Object.assign(cell,{journalSha256:sha(bytes),reviewSha256:sha(reviewBytes),question:r.question,recognizedQuestion:r.recognizedQuestion,answer:r.answer,
    correctness:review.rows[0].correctness,reasoningVerdict:review.rows[0].reasoningVerdict,reviewScope:review.scope,reviewNote:review.rows[0].note,
    phase:r.phase,error:r.error,measurement,panelTransitions:metrics.panelTransitions,latency:r.latency,answerLatencyAvailable:true,codeChecksPending:cell.codeRequired,
    legacyAcceptedToLatestSendAttemptMs:Number.isFinite(p.latestInputSent)?p.latestInputSent-r.latency.questionConfirmedAt:null,
    legacySendScope:variant==='baseline'?'Baseline send attempt, not instrumented actual wire write. Obsolete input echoes can delay it.':'Instrumented actual write is reported separately; do not substitute this field.'});
   if(cell.codeRequired){
    const checkFile=path.join(runDirectory,'code','control-'+codeRun+'-'+name,'results.json');
    try{const checkBytes=await readFile(checkFile),check=JSON.parse(checkBytes);assert.equal(check.journalSha256,sha(bytes));
     cell.codeChecks={file:path.relative(root,path.resolve(checkFile)),sha256:sha(checkBytes),results:check.results};cell.codeChecksPending=false;
     assert(cell.correctness!=='correct'||check.results.every(r=>r.pass),'Executable failure requires an updated source-bound verdict: '+name);
    }catch(error){if(error.code!=='ENOENT')throw error;}
   }
  }else cell.failureScope='Primary capture failed. No successful answer, ASR correctness or answer latency is imputed; preserve setup failure separately from a submitted missing response.';
  cells.push(cell);pair.cells.push(name);
 }
 const [before,after]=cells.slice(-2);
 pair.pairedAnswerLatenciesAvailable=before.answerLatencyAvailable&&after.answerLatencyAvailable;
 if(pair.pairedAnswerLatenciesAvailable){
  const old=before.measurement.firstWordMs,next=after.measurement.firstWordMs;
  pair.firstWordDifferenceMs=old&&next?{low:next.low-old.high,high:next.high-old.low}:null;
  const oldUseful=before.measurement.usefulFeedbackMs,nextUseful=after.measurement.usefulFeedbackMs;
  pair.usefulFeedbackDifferenceMs=oldUseful&&nextUseful?{low:nextUseful.low-oldUseful.high,high:nextUseful.high-oldUseful.low}:null;
 }
 pairs.push(pair);
}
const counts={};
for(const variant of ['baseline','controller']){
 const own=cells.filter(c=>c.variant===variant);
 counts[variant]={all:own.length,capturesComplete:own.filter(c=>c.captureStatus==='complete').length,captureFailures:own.filter(c=>c.captureStatus==='failed').length,
  correct:own.filter(c=>c.correctness==='correct').length,incorrect:own.filter(c=>c.correctness==='incorrect').length,correctnessUnverified:own.filter(c=>c.correctness==='unverified').length,
  reasoningPass:own.filter(c=>c.reasoningVerdict==='pass').length,missingSubmittedAnswers:own.filter(c=>c.measurement?.missing).length};
}
await mkdir(path.dirname(out),{recursive:true});
await writeFile(out,JSON.stringify({schemaVersion:1,manifestSha256:sha(manifestBytes),model:manifest.model,effort:manifest.effort,requestedTier:manifest.serviceTier,
 collectorSha256:sha(await readFile(new URL(import.meta.url))),measurementSourceSha256:sha(await readFile('scripts/lib/controller-measurements.mjs')),counts,pairs,cells,
 scope:'All primary source-bound frozen c704a75/84612ef native cells with shared served renderer. Identical waveform/context within each pair; actual ASR and outputs may differ. Alternated order in repetition2; neither provider drift nor observer cost is isolated. Setup failures remain in denominators. Manual correctness/proof review and executable code checks are separate. These heterogeneous questions are not the ordinary-follow-up latency population or a final corrected-source benchmark.'},null,2));
console.log(JSON.stringify({outFile,counts,pairedAnswers:pairs.filter(p=>p.pairedAnswerLatenciesAvailable).length}));
