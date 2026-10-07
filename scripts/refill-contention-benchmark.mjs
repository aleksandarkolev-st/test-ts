import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectNativePages } from './lib/native-cdp.mjs';

const root = process.cwd();
const mode = process.env.COPILOT_BENCH_MODE || 'policies';
const count = Number(process.env.COPILOT_BENCH_SAMPLES || 20);
const filename = process.env.COPILOT_BENCH_FILE || `refill-${mode}.json`;
assert(['policies', 'audio'].includes(mode));
assert(Number.isInteger(count) && count >= 1 && count <= 20);
assert(path.basename(filename) === filename && filename.endsWith('.json'));
const output = path.join(root, 'artifacts/live-service', filename);
const timeoutMs = 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const prompt = 'Synthetic meeting fact: the launch target is February 19. What is our launch date? Reply in one short sentence using only this fact.';
const sha = value => createHash('sha256').update(value).digest('hex');
const connection = await connectNativePages(Number(process.env.COPILOT_CDP_PORT || 9557));
const { main, overlay } = connection;
const invoke = (name, args = {}) => main.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
let originalSettings, started = false, stage = 'bootstrap';
let result = { status: 'in_progress', mode, requestedSamplesPerConfiguration: count, samples: [], startedAt: new Date().toISOString() };
if (process.argv.includes('--resume')) {
  result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.mode, mode); assert.equal(result.requestedSamplesPerConfiguration, count);
  result.previousFailures = [...(result.previousFailures || []), ...(result.failure ? [result.failure] : [])];
  result.resumedAt = [...(result.resumedAt || []), new Date().toISOString()];
  result.status = 'in_progress'; delete result.failure; delete result.completedAt;
}
await mkdir(path.dirname(output), { recursive: true });
async function persist() { await writeFile(output, JSON.stringify(result, null, 2)); }
async function until(predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requestAt = Date.now();
    const snapshot = await invoke('get_snapshot');
    const responseAt = Date.now();
    if (snapshot.error) throw Error('Native app reported an error');
    if (predicate(snapshot)) return { snapshot, requestAt, responseAt };
    await sleep(20);
  }
  throw Error(`Timed out at ${stage}`);
}
async function visible() {
  let lower = Date.now();
  const deadline = lower + timeoutMs;
  while (Date.now() < deadline) {
    const requestAt = Date.now();
    const shown = await overlay.evaluate(() => {
      const paragraph = document.querySelector('.answer p[aria-live="polite"]');
      if (!paragraph?.textContent.trim()) return false;
      const rect = paragraph.getBoundingClientRect(), style = getComputedStyle(paragraph);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const responseAt = Date.now();
    if (shown) return { lowerHostMs: lower, upperHostMs: responseAt, spanMs: responseAt - lower };
    lower = requestAt;
    await sleep(10);
  }
  throw Error('No rendered answer');
}
async function play(filename) {
  const audio = path.join(root, '.local/audio', filename);
  await access(audio);
  const start = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/play-fixture.ps1'), '-InputPath', audio], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Fixture playback failed')));
  });
  return { startHostMs: start, endHostMs: Date.now(), sha256: sha(await readFile(audio)) };
}
function durations(t, latency, attempts) {
  const gap = (end, start) => t[end] == null || t[start] == null ? null : t[end] - t[start];
  return {
    candidateToStreamMs: gap('codexStreamEntered', 'candidateDetected'),
    semaphoreWaitMs: gap('semaphoreAcquired', 'codexStreamEntered'),
    preparedThreadWaitMs: gap('warmThreadTaken', 'semaphoreAcquired'),
    preparedToSendMs: gap('turnStartSent', 'warmThreadTaken'),
    sendToAckMs: gap('turnStartAck', 'turnStartSent'),
    sendToFirstDeltaMs: gap('firstAgentDelta', 'turnStartSent'),
    ackToFirstDeltaMs: gap('firstAgentDelta', 'turnStartAck'),
    candidateToFirstDeltaMs: gap('firstAgentDelta', 'candidateDetected'),
    candidateToNativeVisibilityMs: gap('firstVisible', 'candidateDetected'),
    deltaToNativeVisibilityMs: gap('firstVisible', 'firstAgentDelta'),
    refillDurationMs: gap('refillCompleted', 'refillStarted'),
    firstPartialFromSpeechStartMs: latency.firstRemotePartialAt == null ? null : latency.firstRemotePartialAt - latency.remoteSpeechStartedAt,
    firstPartialToCredibleCandidateMs: latency.firstCredibleCandidateAt == null ? null : latency.firstCredibleCandidateAt - latency.firstRemotePartialAt,
    firstCandidateToRetainedStreamMs: latency.firstCredibleCandidateAt == null ? null : t.codexStreamEntered - latency.firstCredibleCandidateAt,
    firstCandidateHeadStartMs: latency.firstCredibleCandidateAt == null ? null : latency.speechStoppedAt - latency.firstCredibleCandidateAt,
    earliestStreamHeadStartMs: latency.speechStoppedAt - Math.min(...attempts.map(a => a.timeline.codexStreamEntered).filter(Number.isFinite)),
    streamHeadStartMs: latency.speechStoppedAt - t.codexStreamEntered,
    speechEndToFirstDeltaMs: t.firstAgentDelta - latency.speechStoppedAt,
    speechEndToNativeVisibilityMs: t.firstVisible - latency.speechStoppedAt,
  };
}
try {
  const boot = await invoke('bootstrap');
  assert(!boot.debug && !boot.snapshot.active, 'An idle release app is required');
  originalSettings = boot.settings;
  if (process.argv.includes('--inspect')) {
    console.log(JSON.stringify({ debug: boot.debug, active: boot.snapshot.active, settings: { model: boot.settings.model, answerBackend: boot.settings.answerBackend, serviceTier: boot.settings.serviceTier, reasoningEffort: boot.settings.reasoningEffort, codexRefillPolicy: boot.settings.codexRefillPolicy }, mainUrl: main.url }));
  } else {
    assert(!main.url.includes('127.0.0.1:1420'), 'Embedded assets are required');
    const models = await invoke('list_models');
    assert(models.some(m => m.slug === 'gpt-6-luna'), 'Requested model must appear in the account catalog');
    const settings = { ...boot.settings, model: 'gpt-6-luna', answerBackend: 'codex', serviceTier: 'fast', reasoningEffort: 'xhigh', speechBackend: 'nemotron', speechChunkMs: 160 };
    assert(settings.microphone && settings.output && settings.modelPath && settings.nemotronRuntime);
    const executable = process.env.COPILOT_BENCH_EXECUTABLE;
    assert(executable, 'Provide the actual running executable path');
    const metadata = {
      model: settings.model, serviceTier: settings.serviceTier, reasoningEffort: settings.reasoningEffort,
      preparedStartupPoolSize: 3, freshSessionPerSample: true, startupSettleMs: 1000,
      order: 'rotating configurations each round', productionBuild: true, embeddedAssets: true,
      mainUrl: main.url, executableSha256: sha(await readFile(executable)),
      sourceSha256: Object.fromEntries(await Promise.all(['src-tauri/src/openai/codex.rs', 'src-tauri/src/openai/timing.rs', 'src-tauri/src/runtime.rs', 'src/overlay/Answer.tsx'].map(async file => [file, sha(await readFile(path.join(root, file)))]))),
      promptSha256: mode === 'policies' ? sha(prompt) : null,
      timing: 'Native timestamps share the meeting clock. FirstVisible is native receipt after two overlay animation frames, an upper bound on paint. Turn send to delta includes unobserved Codex prewarm/transport/server work. DOM bounds are observed separately.',
    };
    if (result.metadata) assert.deepEqual(metadata, result.metadata, 'Resume requires the same build, prompt, source and configuration');
    result.metadata = metadata;
    await persist();
    const configurations = mode === 'policies'
      ? [{ key: 'A', policy: 'immediate', chunk: 160 }, { key: 'B', policy: 'first_token', chunk: 160 }, { key: 'C', policy: 'disabled', chunk: 160 }]
      : [{ key: '80ms', policy: 'first_token', chunk: 80 }, { key: '160ms', policy: 'first_token', chunk: 160 }];
    for (let round = 0; round < count; round++) {
      for (let offset = 0; offset < configurations.length; offset++) {
        const config = configurations[(round + offset) % configurations.length];
        if (result.samples.some(s => s.round === round + 1 && s.configuration === config.key)) continue;
        stage = `${config.key}_${round + 1}_startup`;
        const startupAt = Date.now();
        await invoke('start_meeting', { settings: { ...settings, codexRefillPolicy: config.policy, speechChunkMs: config.chunk } });
        started = true;
        await until(s => s.active && s.status === 'listening');
        const startupDurationMs = Date.now() - startupAt;
        if (mode === 'policies') { await invoke('action', { action: 'pause' }); await until(s => s.paused); }
        await sleep(1000);
        let contextPlayback = null;
        if (mode === 'audio') {
          stage = `${config.key}_${round + 1}_context`;
          contextPlayback = await play('context-statement.wav');
          await sleep(1500);
          const seeded = await invoke('get_snapshot');
          assert(!seeded.question && !seeded.answer && !seeded.error, 'Context fixture must leave listening healthy');
        }
        stage = `${config.key}_${round + 1}_answer`;
        const hostRequestAt = Date.now();
        const observedPromise = visible().then(value => ({ value }), error => ({ error }));
        let questionPlayback = null;
        if (mode === 'audio') questionPlayback = await play('remote-question.wav');
        else await invoke('ask', { question: prompt });
        const completed = await until(s => s.latency?.completedAt != null && s.latency?.pipeline?.firstVisible != null);
        const observed = await observedPromise;
        if (observed.error) throw observed.error;
        let final = completed.snapshot;
        if (config.policy !== 'disabled') {
          stage = `${config.key}_${round + 1}_refill`;
          final = (await until(s => s.latency?.pipeline?.refillCompleted != null || s.latency?.pipeline?.refillError)).snapshot;
        }
        const t = final.latency.pipeline;
        result.inflight = { round: round + 1, configuration: config.key, timeline: t, latency: final.latency };
        await persist();
        for (const field of ['candidateDetected', 'codexStreamEntered', 'semaphoreAcquired', 'warmThreadTaken', 'turnStartSent', 'turnStartAck', 'firstAgentDelta', 'turnCompleted', 'questionConfirmed', 'firstVisible']) assert(Number.isFinite(t[field]), `Missing ${field}`);
        assert(t.codexStreamEntered >= t.candidateDetected && t.semaphoreAcquired >= t.codexStreamEntered && t.warmThreadTaken >= t.semaphoreAcquired && t.turnStartSent >= t.warmThreadTaken && t.turnStartAck >= t.turnStartSent && t.firstAgentDelta >= t.turnStartSent && t.firstVisible >= t.firstAgentDelta);
        assert(!t.refillError && !t.cancelled);
        if (config.policy === 'disabled') assert(t.refillStarted == null && t.refillCompleted == null && t.refillThreadsCreated === 0);
        else {
          assert(Number.isFinite(t.refillCompleted) && !t.refillError);
          if (t.refillThreadsCreated > 0) assert(t.refillStarted != null && t.refillCompleted >= t.refillStarted);
          else assert(t.refillStarted == null, 'A no-op refill performs no thread preparation');
        }
        if (config.policy === 'first_token' && t.refillStarted != null) assert(t.refillStarted >= t.firstAgentDelta, 'Deferred refill must follow the first delta');
        const matched = /\bfebruary\b/i.test(final.answer) && /\b(?:19(?:th)?|nineteen(?:th)?)\b/i.test(final.answer);
        const attempts = (await invoke('get_answer_timings')).map(([id, timeline]) => ({ id, timeline }));
        if (config.policy === 'first_token') {
          for (const { timeline: attempt } of attempts) {
            if (attempt.refillStarted != null) {
              const allowedAt = attempt.firstAgentDelta ?? attempt.turnCompleted;
              assert(allowedAt != null && attempt.refillStarted >= allowedAt, 'Refill requires a delta or terminal notification');
            }
          }
        }
        const sample = {
          round: round + 1, configuration: config.key, refillPolicy: config.policy, speechChunkMs: config.chunk,
          startupDurationMs, contextAnswerMatched: matched, contextPlayback, questionPlayback,
          timeline: t, latency: final.latency, attempts,
          durations: durations(t, final.latency, attempts),
          domObservation: { ...observed.value, requestToVisibleMidpointMs: (observed.value.lowerHostMs + observed.value.upperHostMs) / 2 - hostRequestAt },
          immediateRefillBeforeFirstDelta: config.policy === 'immediate' ? t.refillStarted <= t.firstAgentDelta : null,
        };
        result.samples.push(sample);
        delete result.inflight;
        result.updatedAt = new Date().toISOString();
        await persist();
        console.log(`BENCH_SAMPLE ${JSON.stringify({ round: sample.round, configuration: config.key, matched, ...sample.durations })}`);
        stage = `${config.key}_${round + 1}_stop`;
        await invoke('stop_meeting'); started = false;
        await until(s => !s.active);
        assert(matched, 'Answer must recall the identical controlled fact');
      }
    }
    assert(result.samples.length === count * configurations.length);
    result.status = 'passed'; result.completedAt = new Date().toISOString();
  }
} catch (error) {
  result.status = 'failed'; result.failure = { stage, message: error.message }; result.completedAt = new Date().toISOString();
  process.exitCode = 1;
  console.error(`BENCH_FAILED ${JSON.stringify(result.failure)}`);
} finally {
  try {
    if (started) await invoke('stop_meeting');
    if (originalSettings) await invoke('save_settings', { settings: originalSettings });
    const restored = await invoke('bootstrap');
    if (originalSettings) assert.deepEqual(restored.settings, originalSettings, 'All saved settings must be restored');
    result.restored = { idle: !restored.snapshot.active, model: restored.settings.model, serviceTier: restored.settings.serviceTier, reasoningEffort: restored.settings.reasoningEffort, refillPolicy: restored.settings.codexRefillPolicy, speechChunkMs: restored.settings.speechChunkMs };
    // bootstrap reads the account and can reopen the idle broker; close it again.
    await invoke('stop_meeting');
  } catch { result.cleanupFailed = true; process.exitCode = 1; }
  if (!process.argv.includes('--inspect')) await persist();
  connection.close();
}
