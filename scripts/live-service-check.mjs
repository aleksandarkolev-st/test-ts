import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.COPILOT_CDP_PORT || 9557);
const outputDir = path.join(root, 'artifacts/live-service');
const resultsFilename = process.env.COPILOT_LIVE_RESULTS_FILE || 'results.json';
if (path.basename(resultsFilename) !== resultsFilename || !resultsFilename.endsWith('.json')) {
  throw new Error('COPILOT_LIVE_RESULTS_FILE must be a JSON filename without a directory');
}
const resultsPath = path.join(outputDir, resultsFilename);
const sampleCount = Number(process.env.COPILOT_LIVE_SAMPLES || 3);
const timeoutMs = Number(process.env.COPILOT_LIVE_TIMEOUT_MS || 45_000);
const realAudio = process.env.COPILOT_LIVE_REAL_AUDIO === '1';
const contextCheck = process.env.COPILOT_LIVE_CONTEXT_CHECK === '1';
const pauseSetting = process.env.COPILOT_LIVE_PAUSE_CAPTURE;
const pauseCapture = pauseSetting == null ? !realAudio : pauseSetting !== '0';
const requestedModel = process.env.COPILOT_LIVE_MODEL;
const requestedEffort = process.env.COPILOT_LIVE_REASONING_EFFORT?.trim() || null;
const allowedEfforts = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
const visiblePollIntervalMs = 10;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await mkdir(outputDir, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let main;
let meetingStarted = false;
let stage = 'connect';
let sampleRecords = [];
let runMetadata = {};
try {
  const pages = browser.contexts()[0].pages();
  main = pages.find(page => page.url() !== 'about:blank' && !page.url().includes('view=overlay'));
  const overlay = pages.find(page => page.url().includes('view=overlay'));
  if (!main || !overlay) throw new Error('Expected production setup and overlay windows');

  const invoke = (name, args = {}) => main.evaluate(({ name, args }) =>
    window.__TAURI_INTERNALS__.invoke(name, args), { name, args });

  async function snapshotWhen(predicate) {
    const waitStartedAtMs = Date.now();
    const deadline = waitStartedAtMs + timeoutMs;
    let lastFalsePredicateRequestAtMs = null;
    while (Date.now() < deadline) {
      const requestAtMs = Date.now();
      const snapshot = await invoke('get_snapshot');
      const responseAtMs = Date.now();
      if (predicate(snapshot)) {
        const lowerBoundHostMs = lastFalsePredicateRequestAtMs ?? waitStartedAtMs;
        const upperBoundHostMs = responseAtMs;
        return {
          snapshot,
          hostMidpointMs: (lowerBoundHostMs + upperBoundHostMs) / 2,
          anchorLowerBoundHostMs: lowerBoundHostMs,
          anchorUpperBoundHostMs: upperBoundHostMs,
          anchorSpanMs: upperBoundHostMs - lowerBoundHostMs,
          snapshotRoundTripMs: responseAtMs - requestAtMs,
          anchorUncertaintyMs: Math.ceil((upperBoundHostMs - lowerBoundHostMs) / 2),
        };
      }
      lastFalsePredicateRequestAtMs = requestAtMs;
      await sleep(30);
    }
    throw new Error('Timed out waiting for a production snapshot state');
  }

  async function waitAnswerAbsent() {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const requestAtMs = Date.now();
      const visibleCharacters = await overlay.evaluate(() => {
        const paragraph = document.querySelector('.answer p[aria-live="polite"]');
        if (!paragraph || paragraph.textContent.trim().length === 0) return 0;
        const rect = paragraph.getBoundingClientRect();
        const style = getComputedStyle(paragraph);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return 0;
        return paragraph.textContent.trim().length;
      });
      // The DOM was sampled sometime inside the evaluate round trip. Use its
      // request time as a conservative lower bound for later appearance.
      if (visibleCharacters === 0) return requestAtMs;
      await sleep(visiblePollIntervalMs);
    }
    throw new Error('The prior answer did not clear from the overlay');
  }

  async function waitAnswerVisible(lowerBoundAtMs) {
    let lastAbsentAtMs = lowerBoundAtMs;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const requestAtMs = Date.now();
      const visibleCharacters = await overlay.evaluate(() => {
        const paragraph = document.querySelector('.answer p[aria-live="polite"]');
        if (!paragraph || paragraph.textContent.trim().length === 0) return 0;
        const rect = paragraph.getBoundingClientRect();
        const style = getComputedStyle(paragraph);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return 0;
        return paragraph.textContent.trim().length;
      });
      const observedAtMs = Date.now();
      if (visibleCharacters > 0) {
        return {
          characterCount: visibleCharacters,
          observedAtMs,
          estimatedAtMs: (lastAbsentAtMs + observedAtMs) / 2,
          observationWindowMs: observedAtMs - lastAbsentAtMs,
        };
      }
      lastAbsentAtMs = requestAtMs;
      await sleep(visiblePollIntervalMs);
    }
    throw new Error('No answer became visible in the production overlay');
  }

  async function playRealAudio(filename = 'remote-question.wav') {
    const audioPath = path.join(root, '.local/audio', filename);
    const playerPath = path.join(root, 'scripts/play-fixture.ps1');
    await access(audioPath);
    const startedAtMs = Date.now();
    await new Promise((resolve, reject) => {
      const player = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', playerPath, '-InputPath', audioPath,
      ], { windowsHide: true, stdio: 'ignore' });
      player.once('error', reject);
      player.once('exit', code => code === 0 ? resolve() : reject(new Error('Real audio fixture playback failed')));
    });
    return { startedAtMs, durationMs: Date.now() - startedAtMs };
  }

  stage = 'account_catalog';
  const boot = await invoke('bootstrap');
  const models = boot.selected?.planEnabled ? await invoke('list_models') : [];
  const catalog = {
    authenticated: Boolean(boot.selected),
    planEnabled: Boolean(boot.selected?.planEnabled),
    accountCount: boot.accounts.length,
    modelCount: models.length,
    configuredModelSlug: boot.settings.model || null,
    models: models.map(model => ({ slug: model.slug, displayName: model.display_name })),
    activeAtCheck: boot.snapshot.active,
    productionBuild: !boot.debug,
  };
  console.log(`LIVE_CATALOG ${JSON.stringify(catalog)}`);

  if (process.argv.includes('--stop-only')) {
    if (boot.snapshot.active) {
      stage = 'stop_existing_meeting';
      await invoke('stop_meeting');
    }
    const stopped = await snapshotWhen(snapshot => !snapshot.active);
    console.log(`LIVE_STOPPED ${JSON.stringify({ active: stopped.snapshot.active, paused: stopped.snapshot.paused })}`);
  } else if (process.argv.includes('--inspect')) {
    process.exitCode = 0;
  } else {
    stage = 'configuration';
    if (!boot.selected?.planEnabled || models.length === 0) {
      throw new Error('A signed-in account with an available model catalog is required');
    }
    if (!requestedModel) throw new Error('Set COPILOT_LIVE_MODEL to a slug from the live account catalog');
    if (requestedEffort && !allowedEfforts.has(requestedEffort)) {
      throw new Error('COPILOT_LIVE_REASONING_EFFORT must be none, low, medium, high, or xhigh');
    }
    if (!models.some(model => model.slug === requestedModel)) {
      throw new Error('COPILOT_LIVE_MODEL is not listed in the live account catalog');
    }
    if (realAudio && pauseCapture) throw new Error('Real-audio mode requires active capture; set COPILOT_LIVE_PAUSE_CAPTURE=0');
    if (contextCheck && !realAudio) throw new Error('Context recall check requires real audio');
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 5) {
      throw new Error('Sample count must be an integer between 1 and 5');
    }

    const requestedModelInfo = models.find(model => model.slug === requestedModel);
    const actualEffort = requestedEffort ?? boot.settings.reasoningEffort ?? null;
    const microphone = boot.settings.microphone
      || boot.devices.find(device => device.source === 'self' && device.default)?.id
      || boot.devices.find(device => device.source === 'self')?.id;
    const output = boot.settings.output
      || boot.devices.find(device => device.source === 'remote' && device.default)?.id
      || boot.devices.find(device => device.source === 'remote')?.id;
    const settings = {
      ...boot.settings,
      microphone,
      output,
      model: requestedModel,
      reasoningEffort: actualEffort,
    };
    if (!settings.microphone || !settings.output || !settings.modelPath) {
      throw new Error('A microphone, output device, and local speech model must be configured');
    }
    if (realAudio) await access(path.join(root, '.local/audio/remote-question.wav'));
    if (contextCheck) await access(path.join(root, '.local/audio/context-statement.wav'));

    const beforeStart = await snapshotWhen(snapshot => true);
    if (beforeStart.snapshot.active) throw new Error('Stop any existing meeting before the live check');
    stage = 'start_meeting';
    await invoke('start_meeting', { settings });
    meetingStarted = true;
    if (pauseCapture) {
      await invoke('action', { action: 'pause' });
      await snapshotWhen(snapshot => snapshot.active && snapshot.paused);
    } else {
      await snapshotWhen(snapshot => snapshot.active && !snapshot.paused);
    }

    const samples = sampleRecords;
    runMetadata = {
      productionBuild: !boot.debug,
      contextMode: contextCheck ? 'seeded_synthetic_meeting_fact' : 'question_only',
      authenticated: true,
      accountCount: boot.accounts.length,
      modelCatalogCount: models.length,
      availableCatalogModelSlugs: models.map(model => model.slug),
      modelSlug: requestedModelInfo.slug,
      reasoningEffort: actualEffort,
      captureMode: realAudio ? 'real_audio_fixture' : pauseCapture ? 'paused_manual_request' : 'active_manual_request',
    };
    if (contextCheck) {
      stage = 'captured_context_fixture';
      await playRealAudio('context-statement.wav');
      await sleep(1500);
      const seeded = await invoke('get_snapshot');
      if (!seeded.active || seeded.error || seeded.question || seeded.answer) {
        throw new Error('The controlled context statement did not leave a healthy listening state');
      }
    }

    for (let index = 0; index < sampleCount; index++) {
      stage = `sample_${index + 1}_clear`;
      let current = await snapshotWhen(snapshot => true);
      if (current.snapshot.question != null || current.snapshot.answer !== '') {
        await invoke('action', { action: 'dismiss' });
        await snapshotWhen(snapshot => snapshot.question == null && snapshot.answer === '');
      }
      const noAnswerAtMs = await waitAnswerAbsent();
      current = await snapshotWhen(snapshot => true);
      if (current.snapshot.question != null || current.snapshot.answer !== '') {
        throw new Error('The prior answer returned before the next sample');
      }
      const priorQuestionId = current.snapshot.question?.id ?? null;
      const visiblePromise = waitAnswerVisible(noAnswerAtMs).then(
        value => ({ value }),
        error => ({ error }),
      );
      const sampleStartedAtMs = Date.now();
      const acceptedPredicate = snapshot =>
        snapshot.question && snapshot.question.id !== priorQuestionId && snapshot.latency;
      stage = `sample_${index + 1}_waiting_for_confirmation`;
      const acceptedPromise = snapshotWhen(acceptedPredicate).then(
        observation => ({ observation }),
        error => ({ error }),
      );
      let playbackDurationMs = null;
      let playbackStartedAtMs = null;
      if (realAudio) {
        stage = `sample_${index + 1}_playback`;
        const playback = await playRealAudio();
        playbackStartedAtMs = playback.startedAtMs;
        playbackDurationMs = playback.durationMs;
      } else {
        stage = `sample_${index + 1}_manual_request`;
        await invoke('ask', { question: 'This is a response latency check. Reply briefly.' });
      }

      stage = `sample_${index + 1}_question_confirmed`;
      const acceptedResult = await acceptedPromise;
      if (acceptedResult.error) throw acceptedResult.error;
      const acceptedObservation = acceptedResult.observation;
      const accepted = acceptedObservation.snapshot;
      const clockOffsetMs = acceptedObservation.hostMidpointMs - accepted.latency.questionConfirmedAt;
      const visibleResult = await visiblePromise;
      if (visibleResult.error) throw visibleResult.error;
      const visible = visibleResult.value;

      stage = `sample_${index + 1}_response_completed`;
      const completedObservation = await snapshotWhen(snapshot =>
        snapshot.question?.id === accepted.question.id && (snapshot.latency?.completedAt != null || snapshot.error));
      const finished = completedObservation.snapshot;
      if (finished.error) throw new Error('The production request ended with an application error');
      const latency = finished.latency;
      const contextAnswerMatched = contextCheck
        ? /\bfebruary\b/i.test(finished.answer) && /\b(?:19(?:th)?|nineteen(?:th)?)\b/i.test(finished.answer)
        : null;
      if (contextCheck && !contextAnswerMatched) {
        throw new Error('The answer did not recall the controlled fact captured before the question');
      }
      const t0 = latency.speechStoppedAt;
      const t1 = latency.transcriptFinalAt;
      const t2 = latency.questionConfirmedAt;
      const t3 = latency.requestSentAt;
      const t4 = latency.firstTokenAt;
      const t5 = latency.completedAt;
      if (![t0, t1, t2, t3, t4, t5].every(Number.isFinite)) {
        throw new Error('The production snapshot is missing one or more latency timestamps');
      }
      if (t1 < t0 || t2 < t1 || t3 < t2 || t4 < t3 || t5 < t4) {
        throw new Error('The production latency timestamps were not monotonic');
      }
      const speechStoppedHostEstimateMs = clockOffsetMs + t0;
      const requestSentHostEstimateMs = clockOffsetMs + t3;
      const uncertaintyMs = Math.ceil(acceptedObservation.anchorUncertaintyMs + visible.observationWindowMs / 2);
      const firstTokenHostEstimateMs = clockOffsetMs + t4;
      if (visible.estimatedAtMs + uncertaintyMs < firstTokenHostEstimateMs) {
        throw new Error('The visible-answer clock bracket precedes the native first token');
      }
      if (realAudio && speechStoppedHostEstimateMs + uncertaintyMs < playbackStartedAtMs) {
        throw new Error('The detected question ended before the real-audio fixture playback began');
      }
      const sample = {
        index: index + 1,
        contextAnswerMatched,
        playbackDurationMs,
        native: {
          t0SpeechStoppedAtMs: t0,
          t1TranscriptFinalAtMs: t1,
          t2QuestionConfirmedAtMs: t2,
          t3RequestSentAtMs: t3,
          t4FirstTokenAtMs: t4,
          t5CompletedAtMs: t5,
          speechStoppedToTranscriptFinalMs: t1 - t0,
          transcriptFinalToQuestionConfirmedMs: t2 - t1,
          questionConfirmedToRequestSentMs: t3 - t2,
          requestSentToFirstTokenMs: t4 - t3,
          requestSentToCompletedMs: t5 - t3,
          firstTokenToCompletedMs: t5 - t4,
          speechStoppedToFirstTokenMs: t4 - t0,
          speechStoppedToCompletedMs: t5 - t0,
        },
        visible: {
          askCommandToFirstVisibleMs: realAudio ? null : Math.max(0, visible.estimatedAtMs - sampleStartedAtMs),
          requestSentToFirstVisibleMs: Math.max(0, visible.estimatedAtMs - requestSentHostEstimateMs),
          speechEndToFirstVisibleMs: Math.max(0, visible.estimatedAtMs - speechStoppedHostEstimateMs),
          renderedAnswerCharacterCount: visible.characterCount,
          firstVisibleObservationWindowMs: visible.observationWindowMs,
          questionConfirmedAnchorLowerBoundHostMs: acceptedObservation.anchorLowerBoundHostMs,
          questionConfirmedAnchorUpperBoundHostMs: acceptedObservation.anchorUpperBoundHostMs,
          questionConfirmedAnchorSpanMs: acceptedObservation.anchorSpanMs,
          speechEndClockAnchorUncertaintyMs: uncertaintyMs,
        },
      };
      samples.push(sample);
      await writeFile(resultsPath, JSON.stringify({
        status: 'in_progress',
        ...runMetadata,
        sampleCount: samples.length,
        timingAnchorMethod: 'Native t0-t5 are elapsed milliseconds from meeting start. The questionConfirmedAt event is bracketed by the request time of the last false-predicate snapshot and the response time of the first true-predicate snapshot (or the confirmation-wait start if no false snapshot was observed). Their midpoint anchors native t0 and t3; uncertainty includes half the bracket span and half the DOM observation window. First DOM text timing is polled by Node.',
        domPollIntervalMs: visiblePollIntervalMs,
        samples,
        updatedAt: new Date().toISOString(),
      }, null, 2));
      console.log(`LIVE_SAMPLE ${JSON.stringify(sample)}`);

      stage = `sample_${index + 1}_clear_after`;
      await invoke('action', { action: 'dismiss' });
      await snapshotWhen(snapshot => snapshot.question == null && snapshot.answer === '');
      await waitAnswerAbsent();
    }

    stage = 'stop_meeting';
    await invoke('stop_meeting');
    meetingStarted = false;
    await snapshotWhen(snapshot => !snapshot.active);

    const median = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
        : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
    };
    const timing = {
      sampleCount: samples.length,
      medianSpeechEndToFirstVisibleMs: median(samples.map(sample => sample.visible.speechEndToFirstVisibleMs)),
      medianRequestToFirstTokenMs: median(samples.map(sample => sample.native.requestSentToFirstTokenMs)),
      medianRequestToCompletedMs: median(samples.map(sample => sample.native.requestSentToCompletedMs)),
    };
    const result = {
      status: 'passed',
      ...runMetadata,
      timingAnchorMethod: 'Native t0-t5 are elapsed milliseconds from meeting start. The questionConfirmedAt event is bracketed by the request time of the last false-predicate snapshot and the response time of the first true-predicate snapshot (or the confirmation-wait start if no false snapshot was observed). Their midpoint anchors native t0 and t3; uncertainty includes half the bracket span and half the DOM observation window. First DOM text timing is polled by Node.',
      domPollIntervalMs: visiblePollIntervalMs,
      timing,
      samples,
      completedAt: new Date().toISOString(),
    };
    await writeFile(resultsPath, JSON.stringify(result, null, 2));
    console.log(`LIVE_TIMING ${JSON.stringify(timing)}`);
    console.log(`LIVE_RESULT ${resultsPath}`);
  }
} catch (error) {
  const result = {
    ...runMetadata,
    status: 'failed',
    stage,
    errorType: error?.name || 'Error',
    sampleCount: sampleRecords.length,
    samples: sampleRecords,
    completedAt: new Date().toISOString(),
  };
  await writeFile(resultsPath, JSON.stringify(result, null, 2));
  throw error;
} finally {
  if (meetingStarted) {
    try { await main?.evaluate(() => window.__TAURI_INTERNALS__.invoke('stop_meeting')); } catch {}
  }
  await browser.close();
}
