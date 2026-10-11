import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const output=process.argv[2];assert(output?.startsWith('docs/evidence/')&&output.endsWith('-v71.json'));
const hash=x=>createHash('sha256').update(x).digest('hex'),files=(await readdir('.local',{withFileTypes:true})).filter(item=>item.isFile()&&/-v71\.(mjs|ps1)$/.test(item.name)).map(item=>'.local/'+item.name).sort();
files.push('src-tauri/src/openai/codex.rs','src-tauri/src/openai/timing.rs','src-tauri/src/runtime.rs','src-tauri/src/meeting/scheduler.rs','src-tauri/src/meeting/questions.rs','tests/fixtures/hard-interview-audio-suite.json');
files.push('.local/lib/recorded-cohort.mjs');
files.push('.local/lib/recorded-row.mjs');
const sources=[];for(const file of files)sources.push({file,sha256:hash(await readFile(file))});
const root='artifacts/deep-interview-v71',queueSnapshots=[];
for(const file of [root+'/recording-queue.jsonl',root+'/deferred-queue.jsonl']){const bytes=await readFile(file);queueSnapshots.push({file,snapshotSha256:hash(bytes),lastRecordedEvent:JSON.parse(bytes.toString('utf8').trim().replace(/^\uFEFF/,'').split('\n').at(-1))});}
const report={recordedAt:new Date().toISOString(),sources,queueSnapshots,
 scope:'Immutable hashes of the current v71 workflow helpers, fixture and architecture sources. This inventory does not assert that every helper executed, that queue-file snapshots prove process liveness, or that a later changed helper has the same bytes. Recorded source/binary hashes, actual process identity, terminal recordings, cached-review input hashes and final execution evidence remain authoritative. Updates after the original preparation are explicit audit/helper revisions; numerical diagnostics do not change production answer policy.',
 productionBehaviorChanged:false,goalComplete:false};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({file:output,sourceFiles:sources.length,queueEvents:queueSnapshots.map(snapshot=>snapshot.lastRecordedEvent.event)}));
