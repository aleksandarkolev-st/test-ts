import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const audioFile='src-tauri/src/audio/mod.rs',audio=await readFile(audioFile);
const source=audio.toString();
const skip=source.split('\n').findIndex(line=>line.includes('if source==SpeakerSource::Self_')&&line.includes('COPILOT_ACCEPTANCE_REMOTE_ONLY'));
assert(skip>0);
assert(source.split('\n')[skip-1].includes('cfg(all(feature="acceptance",debug_assertions))'));
assert(!source.split('\n')[skip].includes('acceptance_mode'));
const recordedFile='artifacts/deep-interview-v70/systems-hour-t/interview.json';
const recordedBytes=await readFile(recordedFile),recorded=JSON.parse(recordedBytes);
assert(recorded.stoppedCleanly&&recorded.status==='complete');
assert.equal(recorded.sourceHashes[audioFile],hash(audio));
assert.equal(recorded.speechConfiguration.remoteOnly,true);
assert.equal(recorded.speechConfiguration.selfCapture.physicalMicrophoneUsed,false);
const binaryFile='src-tauri/target/debug/meeting-copilot.exe',binaryHash=hash(await readFile(binaryFile));
assert.equal(binaryHash,recorded.nativeBinarySha256);
const document={recordedAt:new Date().toISOString(),source:{file:audioFile,sha256:hash(audio)},
 nativeBinary:{file:binaryFile,sha256:binaryHash},referenceRecording:{file:recordedFile,sha256:hash(recordedBytes)},
 skipGuardLine:skip+1,featureGuard:'all(feature="acceptance",debug_assertions)',
 remoteOnlyRequiresAcceptanceAuthentication:false,normalAuthenticationCompatibleWithRemoteOnly:true,
 productionLogicChanged:false,backendPlaybackPending:true,
 scope:'Read-only source and binary binding. This exact debug binary and audio source were used by the clean completed remote-only systems recording. The microphone skip depends on the acceptance build feature and remote-only environment variable, independently of acceptance authentication. The normal-auth playback helper must retain this binary binding; runtime speech events are still recorded separately.'};
await writeFile('docs/evidence/normal-auth-remote-only-capture-v70.json',JSON.stringify(document,null,2),{flag:'wx'});
console.log(JSON.stringify({nativeBinarySha256:binaryHash,skipGuardLine:skip+1,normalAuthenticationCompatibleWithRemoteOnly:true,backendPlaybackPending:true}));
