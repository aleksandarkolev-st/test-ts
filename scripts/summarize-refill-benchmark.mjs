import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve('artifacts/live-service');
const policies = JSON.parse(await readFile(path.join(directory, 'refill-policies-20.json'), 'utf8'));
const audio = JSON.parse(await readFile(path.join(directory, 'refill-audio-20.json'), 'utf8'));
function check(run, keys) {
  assert.equal(run.status, 'passed');
  assert.equal(run.requestedSamplesPerConfiguration, 20);
  assert(run.restored.idle && !run.cleanupFailed);
  assert(run.metadata.embeddedAssets && run.metadata.freshSessionPerSample && run.metadata.preparedStartupPoolSize === 3);
  for (const sample of run.samples) {
    const t = sample.timeline;
    for (const field of ['candidateDetected','codexStreamEntered','semaphoreAcquired','warmThreadTaken','turnStartSent','turnStartAck','firstAgentDelta','turnCompleted','questionConfirmed','firstVisible']) assert(Number.isFinite(t[field]));
    assert(t.codexStreamEntered >= t.candidateDetected && t.semaphoreAcquired >= t.codexStreamEntered && t.warmThreadTaken >= t.semaphoreAcquired && t.turnStartSent >= t.warmThreadTaken && t.turnStartAck >= t.turnStartSent && t.firstAgentDelta >= t.turnStartSent && t.turnCompleted >= t.firstAgentDelta && t.firstVisible >= t.firstAgentDelta && t.firstVisible >= t.questionConfirmed);
    if (sample.refillPolicy === 'disabled') assert(t.refillStarted == null && t.refillCompleted == null && t.refillThreadsCreated === 0);
    else {
      assert(Number.isFinite(t.refillCompleted) && !t.refillError);
      if (t.refillThreadsCreated > 0) assert(Number.isFinite(t.refillStarted) && t.refillCompleted >= t.refillStarted);
      else assert(t.refillStarted == null);
    }
    if (sample.refillPolicy === 'immediate') assert(sample.immediateRefillBeforeFirstDelta);
    if (sample.refillPolicy === 'first_token') for (const { timeline: attempt } of sample.attempts) {
        if (attempt.refillStarted != null) assert(attempt.refillStarted >= (attempt.firstAgentDelta ?? attempt.turnCompleted) && (attempt.firstAgentDelta ?? attempt.turnCompleted) != null);
    }
  }
  for (const key of keys) {
    const samples = run.samples.filter(s => s.configuration === key);
    assert.equal(samples.length, 20);
    assert.equal(new Set(samples.map(s => s.round)).size, 20);
    assert(samples.every(s => s.contextAnswerMatched));
  }
}
check(policies, ['A', 'B', 'C']); check(audio, ['80ms', '160ms']);
assert.equal(new Set(audio.samples.map(s => s.questionPlayback.sha256)).size, 1);
assert.equal(new Set(audio.samples.map(s => s.contextPlayback.sha256)).size, 1);
assert.equal(policies.metadata.executableSha256, audio.metadata.executableSha256);
assert.deepEqual(policies.metadata.sourceSha256, audio.metadata.sourceSha256);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? { count: sorted.length, min: sorted[0], median: median(sorted), p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) } : null;
}
function summarize(run) {
  return Object.fromEntries([...new Set(run.samples.map(s => s.configuration))].map(key => {
    const samples = run.samples.filter(s => s.configuration === key);
    return [key, {
      count: samples.length,
      contextRecall: samples.filter(s => s.contextAnswerMatched).length,
      durations: Object.fromEntries(Object.keys(samples[0].durations).map(metric => [metric, stats(samples.map(s => s.durations[metric]))])),
      preparedThreadAgeMs: stats(samples.map(s => s.timeline.preparedThreadAgeMs)),
      partialUpdates: stats(samples.map(s => s.latency.remotePartialUpdates)),
      totalAttempts: samples.reduce((sum, s) => sum + s.attempts.length, 0),
      cancelledAttempts: samples.flatMap(s => s.attempts).filter(a => a.timeline.cancelled).length,
      noOpRefills: samples.filter(s => s.refillPolicy !== 'disabled' && s.timeline.refillThreadsCreated === 0).length,
      immediateRefillBeforeFirstDelta: samples.filter(s => s.immediateRefillBeforeFirstDelta).length,
      allSamples: samples.map(s => ({ round: s.round, timeline: s.timeline, durations: s.durations })),
    }];
  }));
}
// Pair within each rotated round; deterministic bootstrap resamples those pairs.
// This interval describes these trials, not service-wide latency guarantees.
function paired(run, first, second, metric) {
  const differences = Array.from({ length: 20 }, (_, index) => {
    const a = run.samples.find(s => s.configuration === first && s.round === index + 1);
    const b = run.samples.find(s => s.configuration === second && s.round === index + 1);
    return a.durations[metric] - b.durations[metric];
  });
  assert(differences.every(Number.isFinite));
  let seed = 20261007;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const bootstrap = Array.from({ length: 10000 }, () => median(Array.from({ length: 20 }, () => differences[Math.floor(random() * 20)]))).sort((a, b) => a - b);
  const higherIsBetter = metric.endsWith('HeadStartMs');
  return { first, second, metric, higherIsBetter, differenceIsFirstMinusSecond: true, medianPairedDifferenceMs: median(differences), secondBetterRounds: differences.filter(n => higherIsBetter ? n < 0 : n > 0).length, bootstrap95PercentIntervalMs: [bootstrap[249], bootstrap[9749]], differencesMs: differences };
}
const summary = {
  status: 'passed', completedAt: new Date().toISOString(),
  metadata: policies.metadata, audioMetadata: audio.metadata,
  policies: summarize(policies), audio: summarize(audio),
  comparisons: [paired(policies, 'A', 'B', 'sendToFirstDeltaMs'), paired(policies, 'A', 'C', 'sendToFirstDeltaMs'), paired(audio, '160ms', '80ms', 'firstPartialFromSpeechStartMs'), paired(audio, '160ms', '80ms', 'firstCandidateHeadStartMs'), paired(audio, '160ms', '80ms', 'speechEndToNativeVisibilityMs')],
  method: '20 fresh sessions per configuration, no discarded samples, rotated order. Nearest-rank p95. Paired differences within each round; 10,000 deterministic bootstrap draws, seed 20261007. A positive head-start difference means the second configuration starts later because head start is speech end minus candidate time.',
  restored: { policies: policies.restored, audio: audio.restored },
};
await writeFile(path.join(directory, 'refill-benchmark-summary.json'), JSON.stringify(summary, null, 2));
const fields = ['round', 'configuration', 'refillPolicy', 'speechChunkMs', ...Object.keys(policies.samples[0].durations)];
const csv = [fields.join(','), ...[...policies.samples, ...audio.samples].map(s => fields.map(f => s[f] ?? s.durations[f] ?? '').join(','))].join('\n') + '\n';
await writeFile(path.join(directory, 'refill-benchmark-samples.csv'), csv);
console.log(JSON.stringify({ policies: Object.fromEntries(Object.entries(summary.policies).map(([key, value]) => [key, { ...value, allSamples: undefined }])), audio: Object.fromEntries(Object.entries(summary.audio).map(([key, value]) => [key, { ...value, allSamples: undefined }])), comparisons: summary.comparisons }, null, 2));
