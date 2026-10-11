import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {extractRecordedRow} from './lib/recorded-row.mjs';
import {waveformEvidence} from '../scripts/lib/deep-delivery.mjs';
const [directory,roundArgument,sourceHashSnapshot,output]=process.argv.slice(2),round=Number(roundArgument);
assert(directory&&sourceHashSnapshot&&output&&Number.isSafeInteger(round)&&round>0,'RECORDING_DIRECTORY ROUND SOURCE_HASH_SNAPSHOT OUTPUT_JSON');
const hash=x=>createHash('sha256').update(x).digest('hex'),file=path.resolve(directory,'interview.json');
const {row,text}=await extractRecordedRow(file,round),snapshotBytes=await readFile(sourceHashSnapshot),snapshot=JSON.parse(snapshotBytes);
assert.equal(path.resolve(snapshot.file),file);assert.equal(snapshot.property,'sourceHashes');
const sourceFiles=['src-tauri/src/transcription/nemotron.rs','src-tauri/src/transcription/vad.rs','src-tauri/src/runtime.rs'],sources=[];
for(const sourceFile of sourceFiles){const sha256=hash(await readFile(sourceFile));assert.equal(sha256,snapshot.value[sourceFile]);sources.push({file:sourceFile,sha256});}
const waveFile=path.resolve(directory,row.audio.waveFile),wave=await readFile(waveFile);assert.equal(hash(wave),row.audio.sha256);
const waveform=waveformEvidence(wave,row.audio.waveformEvidence?.requestedPause??{split:0,pauseMs:0});
const names=['speech.started','speech.activity','speech.ended','transcript','asr.candidate_observed','question.candidate','question.confirmed','question.ignored'];
const events=(row.events??[]).filter(event=>names.includes(event.name));
const counts=Object.fromEntries(names.map(name=>[name,events.filter(event=>event.name===name).length]));
const report={recordedAt:new Date().toISOString(),source:{file,liveFileMetadata:await stat(file).then(item=>({bytes:item.size,modifiedAt:item.mtime.toISOString()})),rowSnapshotSha256:hash(text)},
 sourceHashEvidence:{file:sourceHashSnapshot,sha256:hash(snapshotBytes)},sources,round,question:row.question,sourceQuestionSha256:hash(row.question),
 phase:row.phase,responseVersion:row.responseVersion,recognizedQuestion:row.recognizedQuestion,answerCharacters:(row.answer??'').length,
 error:row.error??null,cancelled:row.cancelled??false,recoveredByDismiss:row.recoveredByDismiss??false,
 wave:{file:waveFile,sha256:hash(wave),waveform,nonzeroSpanMs:(waveform.lastNonzeroFrame+1-waveform.firstNonzeroFrame)/16},
 playback:row.audio.playback,clockAnchors:row.audio.clockAnchors,
 eventCounts:counts,events,recordedPriorRunningAnswerIds:row.audio.runningAtPlaybackLaunch??[],
 speechActivityWithoutRecordedTranscript:counts['speech.started']>0&&counts.transcript===0,
 collectorSourceHashes:{'.local/inspect-turn-capture-v71.mjs':hash(await readFile(new URL(import.meta.url))),'.local/lib/recorded-row.mjs':hash(await readFile(new URL('./lib/recorded-row.mjs',import.meta.url)))},
 scope:'Caller-selected recorded turn, unchanged SHA-verified source waveform and observed ASR/lifecycle events. Speech/VAD activity is distinct from recognition, confirmation, answer correctness and visible text. Absence of a transcript event in this recorded window does not isolate local ASR inference, its socket, native dispatch or event-capture internals. The prior running answer IDs are contextual evidence and are not assigned to this source turn. Live row and source-hash snapshots require final completed-journal binding; unanswered turns remain in the full-cohort denominator.',
 finalJournalBindingPending:true,independentAccuracyPending:true,goalComplete:false};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,round,phase:row.phase,sourceQuestion:row.question,nonzeroSpanMs:report.wave.nonzeroSpanMs,eventCounts:counts,speechActivityWithoutRecordedTranscript:report.speechActivityWithoutRecordedTranscript}));
