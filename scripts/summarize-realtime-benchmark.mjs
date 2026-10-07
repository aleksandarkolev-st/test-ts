import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('artifacts/live-service');
const read = async file => JSON.parse(await readFile(path.join(dir, file), 'utf8'));
const efforts = await read('realtime-efforts-20.json');
const audio = await read('realtime-audio-20.json');
function validate(run, keys) {
  assert.equal(run.status, 'passed');
  assert.equal(run.requestedSamplesPerConfiguration, 20);
  assert(run.restored.idle && !run.cleanupFailed);
  assert(run.metadata.productionBuild && run.metadata.embeddedAssets && run.metadata.serviceTier === 'fast');
  assert.equal(run.samples.length, 20 * keys.length);
  for (const key of keys) {
    const samples = run.samples.filter(s => s.configuration === key);
    assert.equal(samples.length, 20);
    assert.equal(new Set(samples.map(s => s.round)).size, 20);
  }
  for (const s of run.samples) {
    assert(s.contextAnswerMatched && !s.timeline.cancelled && !s.timeline.refillError);
    for (const key of ['candidateDetected','turnStartSent','firstAgentDelta','retainedFirstDelta','questionConfirmed','firstVisible','turnCompleted']) assert(Number.isFinite(s.timeline[key]));
    assert(s.timeline.retainedFirstDelta >= s.timeline.turnStartSent);
    assert(s.timeline.firstVisible >= s.timeline.retainedFirstDelta && s.timeline.firstVisible >= s.timeline.questionConfirmed);
    for (const a of s.attempts) if (a.timeline.refillStarted != null) {
      const fence = a.timeline.firstAgentDelta ?? a.timeline.turnCompleted;
      assert(fence != null && a.timeline.refillStarted >= fence);
    }
  }
}
validate(efforts, ['none','low','medium']); validate(audio, ['80ms','160ms']);
assert.equal(efforts.metadata.executableSha256, audio.metadata.executableSha256);
assert.deepEqual(efforts.metadata.sourceSha256, audio.metadata.sourceSha256);
assert.deepEqual(efforts.metadata.fixturePlayerSha256, audio.metadata.fixturePlayerSha256);
assert.deepEqual(efforts.metadata.audioDevices, audio.metadata.audioDevices);
assert.equal(efforts.metadata.speechGpuName, audio.metadata.speechGpuName);
assert.equal(efforts.metadata.speechGpuIndex, audio.metadata.speechGpuIndex);
assert.equal(new Set(audio.samples.map(s => s.questionPlayback.sha256)).size, 1);
assert.equal(new Set(audio.samples.map(s => s.contextPlayback.sha256)).size, 1);
const median = values => { const a = [...values].sort((a,b)=>a-b), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m-1]+a[m])/2; };
function stats(values) {
  const a = values.filter(Number.isFinite).sort((a,b)=>a-b);
  return a.length ? { count:a.length, min:a[0], median:median(a), p95:a[Math.ceil(a.length*.95)-1], max:a.at(-1) } : null;
}
function summarize(run) {
  return Object.fromEntries([...new Set(run.samples.map(s=>s.configuration))].map(key=>{
    const samples = run.samples.filter(s=>s.configuration===key);
    return [key, { count:samples.length, correct:samples.filter(s=>s.contextAnswerMatched).length,
      durations:Object.fromEntries(Object.keys(samples[0].durations).map(k=>[k,stats(samples.map(s=>s.durations[k]))])),
      attempts:samples.reduce((n,s)=>n+s.attempts.length,0), cancellations:samples.flatMap(s=>s.attempts).filter(a=>a.timeline.cancelled).length,
      steering:stats(samples.map(s=>s.timeline.steeringCount)), followups:stats(samples.map(s=>s.timeline.followupCount)),
      promptChars:stats(samples.map(s=>s.timeline.promptChars)), refinementChars:stats(samples.map(s=>s.timeline.refinementChars)), partialUpdates:stats(samples.map(s=>s.latency.remotePartialUpdates)) }];
  }));
}
function paired(run, first, second, metric) {
  const differences = Array.from({length:20},(_,i)=>run.samples.find(s=>s.round===i+1&&s.configuration===first).durations[metric]-run.samples.find(s=>s.round===i+1&&s.configuration===second).durations[metric]);
  assert(differences.every(Number.isFinite));
  let seed=20261007;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const bootstrap=Array.from({length:10000},()=>median(Array.from({length:20},()=>differences[Math.floor(random()*20)]))).sort((a,b)=>a-b);
  return {first,second,metric,medianFirstMinusSecondMs:median(differences),bootstrap95PercentIntervalMs:[bootstrap[249],bootstrap[9749]],differencesMs:differences};
}
const summary={status:'passed',totalSamples:100,completedAt:new Date().toISOString(),metadata:efforts.metadata,audioMetadata:audio.metadata,
  efforts:summarize(efforts),audio:summarize(audio),
  interruptions:{efforts:efforts.previousFailures||[],audio:audio.previousFailures||[]},
  censoredAnswerTrials:[...efforts.previousFailures||[],...audio.previousFailures||[]].filter(f=>f.stage.endsWith('_answer')),
  comparisons:[paired(efforts,'none','low','sendToRetainedDeltaMs'),paired(efforts,'low','medium','sendToRetainedDeltaMs'),paired(audio,'160ms','80ms','speechEndToNativeVisibilityMs')],
  method:'20 completed fresh sessions per configuration, rotated order, all completed final-run samples retained. Percentiles are conditional on completion; censored answer trials and startup interruptions are listed separately. Nearest-rank p95. Paired median differences with 10,000 deterministic bootstrap resamples (seed 20261007); intervals describe these trials, not service-wide performance. Correctness is recall of one controlled fact.',
  restored:{efforts:efforts.restored,audio:audio.restored}};
await writeFile(path.join(dir,'realtime-benchmark-summary.json'),JSON.stringify(summary,null,2));
const fields=['mode','round','configuration','reasoningEffort','speechChunkMs',...Object.keys(efforts.samples[0].durations)];
const csv=[fields.join(','),...[efforts,audio].flatMap(run=>run.samples.map(s=>fields.map(k=>k==='mode'?run.mode:s[k]??s.durations[k]??'').join(',')))].join('\n')+'\n';
await writeFile(path.join(dir,'realtime-benchmark-samples.csv'),csv);
console.log(JSON.stringify(summary,null,2));
