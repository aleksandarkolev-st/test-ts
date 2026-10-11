import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const attachment='C:/Users/polek/.codex/attachments/da3ba127-66ce-4d6d-817e-22210b6a9528/pasted-text-1.txt';
const raw=await readFile(attachment);
const hour='artifacts/deep-interview-v70/algorithms-hour-t/interview.json';
const current=JSON.parse(await readFile(hour));
const requirements=[
 {id:1,requirement:'Dependent CUDA follow-ups through divergence, masks, shuffles and a valid 19-participant reduction.',state:'partial',evidence:['artifacts/deep-interview-v69/gpu-pilot-r2/interview.json'],remaining:'Six-lane sparse membership was tested; the exact 19-lane chain and independent code verification remain.'},
 {id:2,requirement:'Reject a block barrier under threadIdx.x < 16 in a 128-thread block.',state:'exact_probe_pending',remaining:'Partial-block collective repair was tested; this exact false-premise speech probe remains.'},
 {id:3,requirement:'Reject a dependency created by waiting before the first event record.',state:'partial',evidence:['artifacts/deep-interview-v69/gpu-pilot-r2/interview.json'],remaining:'Event-generation pipeline reasoning was probed; replay the exact never-recorded-event question and check the visible answer.'},
 {id:4,requirement:'Evaluate the two specified FP32 associations of 1e20, -1e20 and 1.',state:'exact_probe_pending',remaining:'Different exact numerical and integer-rounding probes exist. Evaluate this source question exactly and preserve its transcript.'},
 {id:5,requirement:'Replace a GPU histogram answer after reversing to no atomics and highly skewed keys.',state:'exact_probe_pending',remaining:'Late end constraints are exercised, but this histogram reversal and obsolete-visible-text check remain.'},
 {id:6,requirement:'A 30-second question with a 1.5-second internal pause retains its essential trailing condition.',state:'in_progress',evidence:[hour],remaining:'The new harness synthesizes 1.5-second pauses. Inspect source waveform duration, final conditions and painted revisions after execution.'},
 {id:7,requirement:'Recognize 10000 elements and 192 threads and answer 53 blocks.',state:'exact_probe_pending',remaining:'192-thread arithmetic with 1003 elements was tested; the exact 10000-element speech probe remains.'},
 {id:8,requirement:'Switch during streaming from memory coalescing to database phantom reads without stale CUDA text.',state:'partial',evidence:['artifacts/native-interview/rapid-comparison-v66-r1/interview.json',hour],remaining:'Rapid switches have traces, but exact CUDA-to-database streaming switch and paint attribution remain.'},
 {id:9,requirement:'Track the correct exact implementation after 20 or more turns and constraint changes.',state:'in_progress',evidence:[hour],remaining:'The hourly examiner requests a precise older-code reference after 24 turns. Verify actual turn count and retained code identities; instructions alone do not prove it.'},
 {id:10,requirement:'At least 30 minutes of continuous playback-only pressure including short and long questions, false starts, background, rapid follow-ups and silence; audit clause loss, stale answers, memory and latency drift.',state:'in_progress',evidence:[hour],remaining:'Native and recorder resources, actual overlap, recognized text and visible revisions are collected. Verify elapsed duration and delivery coverage from actual audio/events.'},
 {id:'hours-and-topics',requirement:'Full-hour interviews over varied topics, followed by DSA rounds, with latency and accuracy records.',state:'in_progress',evidence:['artifacts/native-interview/algorithms-hour-final-v63/duration-audit.json',hour],remaining:'The old Luna DSA hour is complete. The newer Sol broad hour failed at 44 minutes. Finish the current Sol DSA hour, broad systems hour and independent assessments.'}
];
const record={recordedAt:new Date().toISOString(),source:{file:attachment,sha256:createHash('sha256').update(raw).digest('hex')},
 userPreferences:{candidateModel:'gpt-6.1-sol',candidateEffort:'low',examinerModel:'gpt-6.1-sol',examinerEffort:'low',playbackOutput:'T24E390'},
 currentRun:{file:hour,status:current.status,model:current.model,effort:current.effort,examinerEffort:current.examinerEffort,
  outputDevice:current.outputDevice,nativeProcessId:current.nativeProcessId,toolSessionId:10622},
 requirements,goalComplete:false,scope:'Requirement-by-requirement progress audit, not a completion or accuracy certificate. Missing exact probes are not replaced by similar variants.'};
await writeFile('artifacts/deep-interview-v70/requirements-audit.json',JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify({requirements:requirements.length,output:current.outputDevice,goalComplete:false}));
