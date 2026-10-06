import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const executable = path.join(root, '.local/nemotron/nemo-speech-0.2.0-windows-x86_64-vulkan/bin/nemo-speech.exe');
const model = path.join(root, 'models/nemotron-speech-streaming-en-0.6b.q8_0.gguf');
const chunkMs = Number(process.env.COPILOT_NEMOTRON_CHUNK_MS || 160);
const rightContext = new Map([[80, 0], [160, 1], [560, 6], [1120, 13]]).get(chunkMs);
assert.notEqual(rightContext, undefined, 'Choose 80, 160, 560 or 1120 ms');
const port = Number(process.env.COPILOT_NEMOTRON_PORT || 18971);
const base = `http://127.0.0.1:${port}`;
const startupTimeout = Number(process.env.COPILOT_NEMOTRON_STARTUP_TIMEOUT_MS || 600000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) }); assert.fail('Smoke-test port is already in use'); } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
const report = { kind: 'local official Nemotron English Q8 streaming, synthetic audio, two independent WebSockets', chunkMs, rightContext, samples: [], passed: false };
let stderr = '';
const service = spawn(executable, ['serve', '--host', '127.0.0.1', '--port', String(port), '--asr-model', model, '--backend', 'vulkan:0', '--no-ui', '--asr.streaming.rnnt_right_context', String(rightContext), '--asr.endpointing.enable=true', '--asr.endpointing.stop_history_eou_ms', '510'], { windowsHide: true, cwd: path.dirname(executable), stdio: ['ignore', 'ignore', 'pipe'] });
service.stderr.on('data', data => { stderr += data; });
let launchError; service.on('error', error => { launchError = error; });

function pcm16(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let audio, format;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4); const start = offset + 8;
    assert(start + length <= bytes.length, 'Truncated WAV');
    const type = bytes.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') format = bytes.subarray(start, start + length);
    if (type === 'data') audio = bytes.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  assert(format && audio); assert.equal(format.readUInt16LE(0), 1); assert.equal(format.readUInt16LE(2), 1); assert.equal(format.readUInt32LE(4), 16000); assert.equal(format.readUInt16LE(14), 16);
  return audio;
}

async function stream(source, fixture, expected) {
  const audio = pcm16(await readFile(path.join(root, '.local/audio', fixture)));
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/transcriptions/realtime`);
  const events = [];
  let failure, opened = false, configured = false;
  const started = performance.now();
  socket.addEventListener('open', () => { opened = true; });
  socket.addEventListener('error', () => { failure = new Error('Local transcription WebSocket failed'); });
  socket.addEventListener('message', message => {
    try {
      const event = JSON.parse(message.data);
      if (event.type === 'session.updated') configured = true;
      if (event.type === 'error') failure = new Error(`Local runtime rejected a streaming event (${event.error?.type || 'error'})`);
      events.push({ event, at: performance.now() - started });
    } catch { failure = new Error('Invalid local transcription event'); }
  });
  async function until(predicate, ms = 15000) {
    const deadline = performance.now() + ms;
    while (!predicate()) { if (failure) throw failure; assert(performance.now() < deadline, `Timed out waiting for ${source} stream event: ${events.map(e => e.event.type).join(', ')}`); await pause(20); }
  }
  try {
    await until(() => opened && events.some(e => e.event.type === 'session.created'));
    socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: 16000, language: 'en-US', automatic_punctuation: true, endpointing_ms: 510 } }));
    await until(() => configured);
    const samplesPerChunk = chunkMs * 16 * 2;
    const sendingStarted = performance.now();
    for (let offset = 0; offset < audio.length; offset += samplesPerChunk) {
      if (failure) throw failure;
      socket.send(audio.subarray(offset, offset + samplesPerChunk)); await pause(chunkMs);
    }
    const speechSentAt = performance.now();
    socket.send(Buffer.alloc(16000 * 2));
    socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await until(() => events.some(e => e.event.type === 'conversation.item.input_audio_transcription.completed' && expected.test(e.event.transcript || e.event.text || '')));
    const finals = events.filter(e => e.event.type === 'conversation.item.input_audio_transcription.completed');
    const text = finals.map(e => e.event.transcript || e.event.text || '').join(' ');
    const partials = events.filter(e => e.event.type === 'conversation.item.input_audio_transcription.delta');
    assert(expected.test(text), `${source} stream failed to transcribe its synthetic phrase`);
    assert(partials.length > 0, 'No incremental transcript events');
    assert(partials[0].at < speechSentAt - started, 'Transcript did not stream before the last audio chunk');
    return { source, durationMs: audio.length / 32, matchesExpectedPhrase: true, partialEvents: partials.length, finalEvents: finals.length, firstPartialMs: Math.round(partials[0].at - (sendingStarted - started)), finalAfterAudioSentMs: Math.round(started + finals.at(-1).at - speechSentAt) };
  } finally { socket.close(); }
}

try {
  const deadline = Date.now() + startupTimeout;
  while (true) {
    if (launchError) throw launchError;
    assert.equal(service.exitCode, null, `Nemotron service exited ${service.exitCode}: ${stderr.slice(-4000)}`);
    try { const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { report.readiness = await response.json(); break; } } catch {}
    assert(Date.now() < deadline, `Nemotron model loading timed out: ${stderr.slice(-4000)}`); await pause(200);
  }
  console.log('Local Nemotron runtime ready; checking two independent streams.');
  report.samples = await Promise.all([
    stream('remote', 'remote-question.wav', /launch.*target/i),
    stream('self', 'context-statement.wav', /February|nineteenth/i),
  ]);
  report.vulkanDeviceDetected = /RX 9070 XT/i.test(stderr);
  assert(report.vulkanDeviceDetected, 'The expected AMD RX 9070 XT was not reported by Vulkan');
  report.passed = true; console.log(JSON.stringify({ chunkMs, passed: true, vulkanDeviceDetected: true, samples: report.samples }, null, 2));
} catch (error) {
  report.failure = String(error); console.error(report.failure); throw error;
} finally {
  service.kill();
  await mkdir(path.join(root, 'artifacts/nemotron'), { recursive: true });
  await writeFile(path.join(root, `artifacts/nemotron/streaming-${chunkMs}.json`), JSON.stringify(report, null, 2));
}
