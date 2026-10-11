import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {extractRecordedRow} from './lib/recorded-row.mjs';
const [directory,roundArgument,output]=process.argv.slice(2),round=Number(roundArgument);
assert(directory&&output&&Number.isSafeInteger(round)&&round>0,'RECORDING_DIRECTORY ROUND OUTPUT_JSON');
const hash=value=>createHash('sha256').update(value).digest('hex'),file=path.resolve(directory,'interview.json');
const {row,text}=await extractRecordedRow(file,round),id=row.responseVersion?.split(':')[0];
const report={recordedAt:new Date().toISOString(),file,liveFileMetadata:await stat(file).then(item=>({bytes:item.size,modifiedAt:item.mtime.toISOString()})),
 rowSnapshotSha256:hash(text),collectorSourceHashes:{[import.meta.url]:hash(await readFile(new URL(import.meta.url))),
 '.local/lib/recorded-row.mjs':hash(await readFile(new URL('./lib/recorded-row.mjs',import.meta.url)))},
 round,question:row.question,sourceQuestionSha256:hash(row.question),recognizedQuestion:row.recognizedQuestion,
 responseVersion:row.responseVersion,answer:row.answer,phase:row.phase,error:row.error??null,cancelled:row.cancelled??false,
 pipeline:row.latency?.pipeline??{},latency:row.latency,audioClockAnchors:row.audio?.clockAnchors,audioPlayback:row.audio?.playback,
 firstStreamedWordMeasurement:row.firstStreamedWordMeasurement,
 frameEvents:(row.events??[]).filter(event=>event.name==='answer.provisional_prefix'&&event.payload?.id===id),
 scope:'Exact complete row bytes extracted with bounded memory. Source journal may still be recording. Decoded-prefix activity is limited to this row capture window and this native question ID; absence does not establish absence of inference. Final journal SHA binding and independent accuracy review remain required.',
 finalJournalBindingPending:true,independentAccuracyPending:true,goalComplete:false};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:output,round,responseVersion:row.responseVersion,word:row.firstStreamedWordMeasurement?.firstRetainedVisibleStreamedWord}));
