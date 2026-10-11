import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {extractRecordedRow} from './lib/recorded-row.mjs';
const [directory,output,...pairs]=process.argv.slice(2);
assert(directory&&output&&pairs.length>0&&pairs.length%2===0,'RECORDING_DIRECTORY OUTPUT_JSON CHECKPOINT FINAL_ROW [CHECKPOINT FINAL_ROW ...]');
const hash=x=>createHash('sha256').update(x).digest('hex'),sources=[];
async function load(file){const bytes=await readFile(file);sources.push({file,sha256:hash(bytes)});return JSON.parse(bytes);}
const audit=await load(path.join(directory,'duration-audit.json'));
assert.equal(audit.status,'complete');assert(audit.stoppedCleanly);
const journalFile=path.resolve(directory,'interview.json'),initialMetadata=await stat(journalFile),digest=createHash('sha256');
for await(const bytes of createReadStream(journalFile))digest.update(bytes);
assert.equal(digest.digest('hex'),audit.journalSha256);
const bindings=[];
for(let index=0;index<pairs.length;index+=2){
 const checkpointFile=pairs[index],finalRowFile=pairs[index+1],before=await load(checkpointFile),after=await load(finalRowFile);
 assert.equal(before.round,after.round);assert.equal(path.resolve(after.file),journalFile);
 const checkpointJournal=before.file??before.journalSnapshot?.file;
 if(checkpointJournal)assert.equal(path.resolve(checkpointJournal),journalFile);
 const {row,text}=await extractRecordedRow(journalFile,after.round);
 assert.equal(hash(text),after.rowSnapshotSha256,'Final row does not match completed journal');
 const measured=audit.rows.find(item=>item.round===after.round);assert(measured);
 assert.equal(row.question,before.question);assert.equal(row.question,after.question);assert.equal(row.question,measured.question);
 assert.equal(after.responseVersion,row.responseVersion);assert.equal(measured.responseVersion,row.responseVersion);
 assert.equal(after.answer,row.answer);assert.deepEqual(after.pipeline,row.latency?.pipeline??{});
 assert.deepEqual(after.audioClockAnchors,row.audio?.clockAnchors);assert.deepEqual(after.audioPlayback,row.audio?.playback);
 const finalWord=measured.firstRetainedVisibleStreamedWord??null;
 assert.deepEqual(after.firstStreamedWordMeasurement?.firstRetainedVisibleStreamedWord??null,finalWord);
 const checkpointWord=before.firstStreamedWordMeasurement?.firstRetainedVisibleStreamedWord??before.word??null;
 const timingFields=['questionConfirmed','latestInputSent','latestInputReaderReceived','latestInputConsumed','retainedFirstDelta'];
 const timingChanges=timingFields.filter(field=>(before.pipeline?.[field]??null)!==(after.pipeline?.[field]??null))
  .map(field=>({field,checkpoint:before.pipeline?.[field]??null,final:after.pipeline?.[field]??null}));
 bindings.push({checkpointFile,finalRowFile,round:row.round,question:row.question,sourceQuestionSha256:hash(row.question),
  checkpointResponseVersion:before.responseVersion,finalResponseVersion:row.responseVersion,
  nativeQuestionIdChanged:before.responseVersion?.split(':')[0]!==row.responseVersion?.split(':')[0],
  checkpointAnswerSha256:hash(before.answer??before.answerAtCheckpoint??''),finalAnswerSha256:hash(row.answer??''),
  phase:row.phase,cancelled:row.cancelled??false,error:row.error??null,firstRetainedVisibleStreamedWord:finalWord,
  missingReason:measured.missingReason,checkpointInputTimingsUnchanged:timingChanges.length===0,timingChanges,
  checkpointRetainedWordMatchesFinal:JSON.stringify(checkpointWord)===JSON.stringify(finalWord),finalPipeline:after.pipeline});
}
const finalMetadata=await stat(journalFile);assert.equal(finalMetadata.size,initialMetadata.size);assert.equal(finalMetadata.mtimeMs,initialMetadata.mtimeMs);
const collectorSourceHashes={};
for(const file of ['.local/bind-recorded-checkpoints-v71.mjs','.local/lib/recorded-row.mjs'])collectorSourceHashes[file]=hash(await readFile(file));
const report={recordedAt:new Date().toISOString(),journal:{file:journalFile,sha256:audit.journalSha256,status:audit.status,stoppedCleanly:audit.stoppedCleanly},
 sources,collectorSourceHashes,bindings,allRecordedTurns:audit.rows.length,
 scope:'Caller-selected historical checkpoints are matched against exact row bytes in a SHA-verified completed recording. Question, revision, answer and timing changes remain explicit. No topic, round or expected answer determines the binding rules. These diagnostic cases do not replace the full-cohort accuracy or latency measurements.',goalComplete:false};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,bindings:bindings.map(({round,phase,error,checkpointInputTimingsUnchanged,checkpointRetainedWordMatchesFinal})=>({round,phase,error,checkpointInputTimingsUnchanged,checkpointRetainedWordMatchesFinal}))}));
