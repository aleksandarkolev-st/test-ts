import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex'),sources=[];
async function load(file){const raw=await readFile(file);sources.push({file,sha256:hash(raw)});return JSON.parse(raw);}
const directory='artifacts/deep-interview-v71/systems-hour-t',audit=await load(directory+'/duration-audit.json');assert.equal(audit.status,'complete');assert(audit.stoppedCleanly&&audit.durationVerified);
const journalFile=directory+'/interview.json',journalHash=createHash('sha256');for await(const bytes of createReadStream(journalFile))journalHash.update(bytes);assert.equal(journalHash.digest('hex'),audit.journalSha256);
const inputs=[
 {before:'docs/evidence/architecture-systems-r3-clocks-v71.json',after:'docs/evidence/architecture-systems-r3-final-row-v71.json'},
 {before:'docs/evidence/architecture-systems-r32-checkpoint-v71.json',after:'docs/evidence/architecture-systems-r32-final-row-v71.json'},
 {before:'docs/evidence/architecture-systems-r36-missing-word-v71.json',after:'docs/evidence/architecture-systems-r36-final-row-v71.json'}
],rows=[];
for(const input of inputs){
 const before=await load(input.before),after=await load(input.after),measured=audit.rows.find(row=>row.round===after.round);assert(measured);
 assert.equal(before.round,after.round);assert.equal(before.responseVersion.split(':')[0],after.responseVersion.split(':')[0]);
 assert.equal(after.responseVersion,measured.responseVersion);assert.equal(before.question,after.question);assert.equal(measured.question,after.question);
 assert.deepEqual(before.audioClockAnchors,after.audioClockAnchors);assert.deepEqual(before.audioPlayback,after.audioPlayback);
 assert.deepEqual(after.firstStreamedWordMeasurement.firstRetainedVisibleStreamedWord,measured.firstRetainedVisibleStreamedWord);
 const fields=['questionConfirmed','latestInputSent','latestInputReaderReceived','latestInputConsumed','retainedFirstDelta'];
 const timingChanges=fields.filter(field=>before.pipeline[field]!==after.pipeline[field]).map(field=>({field,checkpoint:before.pipeline[field],final:after.pipeline[field]}));
 rows.push({...input,round:after.round,responseVersion:after.responseVersion,sourceQuestionSha256:after.sourceQuestionSha256,
  earlyRowSnapshotSha256:before.rowSnapshotSha256,finalRowSnapshotSha256:after.rowSnapshotSha256,
  earlyAnswerSha256:hash(before.answer??''),finalAnswerSha256:hash(after.answer??''),phase:after.phase,cancelled:after.cancelled,error:after.error,
  firstVisibleStreamedWord:measured.firstVisibleStreamedWord,firstRetainedVisibleStreamedWord:measured.firstRetainedVisibleStreamedWord,missingReason:measured.missingReason,
  checkpointInputTimingsUnchanged:timingChanges.length===0,timingChanges,
  earlyFirstRetainedWordMatchesFinal:JSON.stringify(before.firstStreamedWordMeasurement?.firstRetainedVisibleStreamedWord??null)===JSON.stringify(measured.firstRetainedVisibleStreamedWord),
  finalPipeline:after.pipeline});
}
const report={recordedAt:new Date().toISOString(),journal:{file:journalFile,sha256:audit.journalSha256,status:audit.status,stoppedCleanly:audit.stoppedCleanly},sources,rows,
 summary:{actualInterviewDurationMs:audit.actualInterviewDurationMs,evaluatedTurns:audit.rows.length,firstRetainedVisibleWordMs:audit.summary.firstRetainedVisibleWordMs,missingVisibleWords:audit.summary.turnsWithoutVisibleWord,cancelled:audit.summary.cancelled,errors:audit.summary.errors},
 scope:'The preserved early-retry, 43-second tail and missing-word timeout checkpoints bind to specific final responses in the completed SHA-verified systems hour. Early answer snapshots remain historical; final answer hashes and measurement rows are authoritative. Pipeline changes, if any, are shown rather than concealed. A clean recording stop does not mean every answer succeeded. Independent model reviews and substantive code checks remain pending.',independentAccuracyPending:true,goalComplete:false};
const file='docs/evidence/systems-final-checkpoint-bindings-v71.json';await writeFile(file,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file,summary:report.summary,bindings:rows.map(row=>({round:row.round,phase:row.phase,error:row.error,checkpointInputTimingsUnchanged:row.checkpointInputTimingsUnchanged,earlyFirstRetainedWordMatchesFinal:row.earlyFirstRetainedWordMatchesFinal}))}));
