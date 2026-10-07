import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const load = async name => JSON.parse(await readFile(`artifacts/live-service/${name}`, 'utf8'));
const [summary, policies, audio, earlier] = await Promise.all([
  load('refill-benchmark-summary.json'), load('refill-policies-20.json'), load('refill-audio-20.json'), load('refill-policies-20-before-terminal-fence.json'),
]);
assert.equal(summary.status, 'passed');
for (const [file, hash] of Object.entries(summary.metadata.sourceSha256)) {
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash, `Benchmark source changed: ${file}`);
}
const middle = values => { const sorted = [...values].sort((a,b)=>a-b); return (sorted[9]+sorted[10])/2; };
const med = (group, key) => group.durations[key]?.median ?? '—';
const policyRows = Object.entries(summary.policies).map(([key, group]) => `| ${key} | ${group.count} | ${med(group, 'sendToFirstDeltaMs')} | ${group.durations.sendToFirstDeltaMs.p95} | ${med(group, 'candidateToNativeVisibilityMs')} | ${group.contextRecall}/20 |`).join('\n');
const audioRows = Object.entries(summary.audio).map(([key, group]) => `| ${key} | ${med(group, 'firstPartialFromSpeechStartMs')} | ${med(group, 'firstCandidateHeadStartMs')} | ${med(group, 'earliestStreamHeadStartMs')} | ${med(group, 'streamHeadStartMs')} | ${med(group, 'speechEndToNativeVisibilityMs')} | ${group.durations.speechEndToNativeVisibilityMs.p95} | ${group.totalAttempts} |`).join('\n');
const stageRows = ['candidateToStreamMs', 'semaphoreWaitMs', 'preparedThreadWaitMs', 'preparedToSendMs', 'sendToAckMs', 'ackToFirstDeltaMs', 'deltaToNativeVisibilityMs', 'refillDurationMs'].map(metric => `| ${metric} | ${['A','B','C'].map(key => med(summary.policies[key], metric)).join(' | ')} |`).join('\n');
const pairedRows = summary.comparisons.map(c => `| ${c.first} − ${c.second} | ${c.metric} | ${c.medianPairedDifferenceMs} | ${c.bootstrap95PercentIntervalMs.join(' to ')} | ${c.secondBetterRounds}/20 |`).join('\n');
const sampleRows = Array.from({length:20}, (_,i) => `| ${i+1} | ${['A','B','C'].map(key => policies.samples.find(s => s.round===i+1 && s.configuration===key).durations.sendToFirstDeltaMs).join(' | ')} |`).join('\n');
const audioSampleRows = Array.from({length:20}, (_,i) => {
  const a=audio.samples.find(s=>s.round===i+1 && s.configuration==='80ms'),b=audio.samples.find(s=>s.round===i+1 && s.configuration==='160ms');
  return `| ${i+1} | ${a.durations.firstPartialFromSpeechStartMs} | ${b.durations.firstPartialFromSpeechStartMs} | ${a.durations.streamHeadStartMs} | ${b.durations.streamHeadStartMs} | ${a.durations.speechEndToNativeVisibilityMs} | ${b.durations.speechEndToNativeVisibilityMs} |`;
}).join('\n');
const improvement = summary.comparisons.slice(0,2).some(c => c.bootstrap95PercentIntervalMs[0]>0);
const conclusions = improvement
  ? 'At least one paired refill comparison has a positive interval in this run. The earlier complete run did not improve the medians, so this does not establish a stable service-wide benefit.'
  : 'Neither paired refill comparison establishes an improvement over immediate refill in this run. Deferring replacement work removes a potential source of overlap, but these measurements do not identify it as the dominant delay.';
const report = `# Refill contention and partial-transcript timing

Measured on 2026-10-07 using the signed-in native Codex route, GPT-6 Luna, Fast mode and xhigh effort. All times below are milliseconds. The updated executable embeds its frontend assets; its SHA-256 is \`${summary.metadata.executableSha256}\`.

## Implementation and timing boundaries

Startup prepares three ephemeral threads. The default policy starts refill after the first agent delta, or after a terminal \`turn/completed\` notification if no delta was delivered. Cancellation keeps the event receiver and transport slot until the terminal event or a bounded five-second wait; an interrupt acknowledgement alone cannot trigger fallback refill. The opt-in live Rust test verifies the three-entry reserve, streaming cancellation, terminal notification and owned process exit.

The native trace records candidate detection, stream entry, semaphore acquisition, prepared-thread consumption, refill start, actual turn send, turn acknowledgement, first agent delta, question confirmation, first visibility and refill completion. It additionally records prepared-thread age and terminal notifications. These are elapsed milliseconds on the meeting clock. A refill task can finish without preparing a thread if another task already filled the reserve; that no-op has a null refill-start timestamp and zero threads created. Thread acknowledgement and refill completion establish pool preparation, not internal Codex WebSocket readiness. Send-to-delta still includes internal prewarm resolution, transport and server/model work.

First visibility is native receipt of a notification after two overlay animation frames, an upper bound on paint time. Independent DOM polling bounds are retained in the raw samples. Partial timestamps are native actor receipt times, not timestamps inside Nemotron.

## Twenty samples per refill policy

A is immediate refill, B is first-token refill, C is disabled refill. Each trial starts a fresh meeting with the same three-thread reserve, fixed synthetic prompt and 1,000 ms settle interval after startup. Capture is paused. Order rotates ABC/BCA/CAB to distribute service-time variation. Disabled refill cannot exhaust its reserve because each session contains one request. No samples are discarded. These are controlled manual requests, not speech-end latency measurements.

| Policy | Samples | Median send → delta | p95 send → delta | Median candidate → native visibility | Fact recall |
|---|---:|---:|---:|---:|---:|
${policyRows}

${conclusions}

| Stage duration | A median | B median | C median |
|---|---:|---:|---:|
${stageRows}

The earlier complete 20-per-policy run, before the cancellation terminal fence, measured median send-to-delta A/B/C of ${['A','B','C'].map(key => middle(earlier.samples.filter(s=>s.configuration===key).map(s=>s.durations.sendToFirstDeltaMs))).join('/')} ms. It is retained as \`refill-policies-20-before-terminal-fence.json\`. Both audio pilots are retained; the corrected-build pilot includes a 7,517 ms send-to-delta outlier. The final run below uses only the corrected executable, and retains all slow trials.

## Twenty real-audio samples per chunk size

Both groups use deferred refill, fresh sessions, the same context statement and question WAV files, active Windows capture and the same GPU. Nemotron maps 80 ms to zero right-context chunks and 160 ms to one. This mapping is covered by the Rust test and passed to the native speech launcher. Each group recalled the seeded February 19 date in 20/20 samples; this controlled fact check is not a general speech-recognition accuracy evaluation.

Positive head start means before detected speech end; negative means after it. The first credible candidate and earliest stream can precede the retained answer's stream by different amounts because later transcript revisions replace jobs.

| Chunk | First partial after speech start | First candidate head start | Earliest stream head start | Retained stream head start | Speech end → native visibility median | p95 | Total attempts |
|---|---:|---:|---:|---:|---:|---:|---:|
${audioRows}

80 ms median first-candidate-to-retained-stream time is ${med(summary.audio['80ms'], 'firstCandidateToRetainedStreamMs')} ms; at 160 ms it is ${med(summary.audio['160ms'], 'firstCandidateToRetainedStreamMs')} ms. The attempt records show ${summary.audio['80ms'].cancelledAttempts}/${summary.audio['160ms'].cancelledAttempts} cancelled attempts respectively. Early partials reach the local question threshold and start generation. Much of that speculative head start is lost when material transcript growth cancels a still-incomplete answer and creates another job. This fixture does not support attributing the lack of retained head start solely to late Nemotron partial emission.

## Paired comparisons and limits

Pairs are matched within each rotated round. Intervals use 10,000 deterministic bootstrap draws of the 20 paired differences, seed 20261007. They describe these trials, not service-wide guarantees. The difference is first minus second; positive favors the second configuration for latency, while negative favors it for head start.

| Pair | Metric | Median paired difference | Bootstrap 95% interval | Second configuration better |
|---|---|---:|---:|---:|
${pairedRows}

Effort was held fixed; this experiment does not compare low with xhigh. [OpenAI Docs](https://developers.openai.com/api/docs/guides/deployment-checklist) says lower effort generally reduces latency. The earlier small-run reversal is not evidence that xhigh is intrinsically faster.

The traces locate most first-token delay after turn acknowledgement. They cannot separate internal Codex waits from service/model latency or prove that Codex itself is the wrong serving layer. [OpenAI Docs for Live delegation](https://developers.openai.com/api/docs/guides/live-delegation) describes persistent Responses WebSockets and advance preparation, with Luna as a backend example. A direct-route comparison on the same inputs would be needed to attribute serving-layer overhead. No architecture switch was made. The hard sub-second target remains unproven.

## Raw measurements

Every recorded trace, attempted generation, fixture hash, source hash, DOM observation and restored-control check is in \`artifacts/live-service/refill-{policies,audio}-20.json\`. \`refill-benchmark-summary.json\` and \`refill-benchmark-samples.csv\` contain the analysis and numeric sample export. The audio run stopped after 18 completed samples because the harness incorrectly required every refill task to create a thread, then after 30 samples because a second guard also rejected no-ops. Both checks were corrected and the remaining samples resumed on the same executable, source, fixtures and configuration. Both stopped checkpoints are retained as \`refill-audio-20-{noop-check-stopped,second-noop-check-stopped}.json\`. The first stopped trial's final numeric snapshot was not preserved by the original harness; the second is retained as an inflight numeric record. These two interrupted trials are excluded from the 40 completed analysis samples for harness validation reasons, not latency. All completed analysis samples and their slow outliers are retained. Saved settings are restored and the meeting and broker are stopped after each run. The existing MSI has not been rebuilt for this change.

### Send to first delta, all policy samples

| Round | A | B | C |
|---|---:|---:|---:|
${sampleRows}

### Partial receipt, retained head start and visibility, all audio samples

| Round | 80 partial | 160 partial | 80 retained head start | 160 retained head start | 80 visibility | 160 visibility |
|---|---:|---:|---:|---:|---:|---:|
${audioSampleRows}

## Reproduce

Build the embedded release with \`npm run build\` and \`cargo build --release --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol\`. Use the signed-in app with its bundled runtimes, configured capture devices, controlled audio fixtures in \`.local/audio\`, and WebView2 CDP port 9557. Set \`COPILOT_BENCH_EXECUTABLE\` to the running executable path.

Run \`scripts/refill-contention-benchmark.mjs\` with \`COPILOT_BENCH_MODE=policies\`, \`COPILOT_BENCH_SAMPLES=20\`, and \`COPILOT_BENCH_FILE=refill-policies-20.json\`; then use mode \`audio\` and filename \`refill-audio-20.json\`. Run \`node scripts/summarize-refill-benchmark.mjs\` afterward. The harness refuses an active meeting or a development URL, validates timing order and refill policy, records progress after every sample, and restores controls on failure.
`;
await writeFile('docs/refill-benchmark.md', report);
console.log('Wrote docs/refill-benchmark.md with current-source verification');
