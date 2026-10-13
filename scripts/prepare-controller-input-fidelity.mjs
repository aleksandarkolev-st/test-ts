// Evaluation data only: never imported by production recognition or answering.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {replayContextCheckpoint} from './lib/deep-replay-context.mjs';

const [sourceJournal,outputFile,roundSelection]=process.argv.slice(2);
assert(sourceJournal&&outputFile&&roundSelection,
 'Usage: node scripts/prepare-controller-input-fidelity.mjs <completed-journal> <output-manifest> <comma-separated-rounds>');
const root=process.cwd(),sha=x=>createHash('sha256').update(x).digest('hex');
const inside=file=>{const absolute=path.resolve(file);assert(absolute.startsWith(root+path.sep),'Keep validation data inside the workspace');return absolute;};
const rounds=roundSelection.split(',').map(Number);
assert(rounds.length&&rounds.every(r=>Number.isInteger(r)&&r>0));assert.equal(new Set(rounds).size,rounds.length);
const bytes=await readFile(inside(sourceJournal)),journal=JSON.parse(bytes);
assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
assert.equal(journal.model,'gpt-6.1-sol');assert.equal(journal.effort,'low');
const sources=[];
for(const round of rounds){
 const row=journal.rows.find(r=>r.round===round);assert(row?.audio?.waveFile&&row.recognizedQuestion,'Select recorded audio with recognized text');
 const checkpoint=replayContextCheckpoint(journal,row);
 assert.equal(checkpoint.provenance.kind,'public_native_state_before_question_playback');
 assert(Buffer.byteLength(checkpoint.text)<=160000,'Frozen-context acceptance limit exceeded; do not silently truncate');
 const wave=await readFile(inside(row.audio.waveFile));assert.equal(sha(wave),row.audio.sha256);
 sources.push({row,checkpoint,waveSha256:sha(wave)});
}
const turns=[];
for(const repetition of [1,2]){
 for(const {row,checkpoint,waveSha256}of repetition===1?sources:[...sources].reverse()){
  for(const modality of repetition===1?['canonical','recognized','audio']:['audio','recognized','canonical']){
   turns.push({name:`source-${row.round}-${modality}-rep${repetition}`,
    question:modality==='recognized'?row.recognizedQuestion:row.question,
    fixedContext:checkpoint.text,
    ...(modality==='audio'?{waveFile:row.audio.waveFile,waveSha256}:{automaticRecognized:true}),
    ...(Object.hasOwn(row,'ordinaryFollowup')?{ordinaryFollowup:row.ordinaryFollowup}:{}),
    sourceFidelity:{sourceRound:row.round,repetition,modality,
     originalQuestion:row.question,recognizedQuestion:row.recognizedQuestion,
     sourceJournal:{file:sourceJournal,sha256:sha(bytes)},
     publicPreSourceContextSha256:sha(checkpoint.text),preSourceProvenance:checkpoint.provenance,
     waveFile:row.audio.waveFile,waveSha256,
     scope:'Original target is reviewer metadata. Answering input is exactly turn.question and fixedContext. Text is injected finalized speech through automatic acceptance; audio is unchanged native playback. Fresh ASR state does not reproduce the original aged recognizer.'}});
  }
 }
}
const manifest={model:journal.model,effort:journal.effort,objective:'detailed',serviceTier:null,continuousSession:true,turns,
 scope:'Recorded-input fidelity comparison using caller-selected rounds, without question/content rules. Canonical text, actually recognized text and original waveform share the same public pre-question snapshot. Repetition two reverses condition/target order. The same manifest is required for both backends. No expected answer, future response, input correction or fixture oracle enters production generation. Text conditions exclude acoustic/ASR latency; original strict failures remain in their original journals.'};
assert(!/"(?:access_token|refresh_token|client_secret|id_token)"\s*:|Bearer\s+[A-Za-z0-9._-]{20,}/i.test(JSON.stringify(manifest)));
await mkdir(path.dirname(inside(outputFile)),{recursive:true});await writeFile(outputFile,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({outputFile,sha256:sha(await readFile(outputFile)),sources:rounds,turns:turns.length,nativeRun:false,
 contextBytes:sources.map(s=>({round:s.row.round,bytes:Buffer.byteLength(s.checkpoint.text),sha256:sha(s.checkpoint.text)}))}));
