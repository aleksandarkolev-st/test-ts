import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual polling helpers without audio, UI, credentials or cloud
// requests. Keep the synthetic clock under test control.
const source = await readFile(new URL('../scripts/live-service-check.mjs', import.meta.url), 'utf8');
function helper(name, nextName, globals) {
  const start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf(`\n  async function ${nextName}(`, start);
  assert(start >= 0 && end > start, `Cannot locate ${name}`);
  return vm.runInNewContext(`(${source.slice(start, end).trim()})`, globals);
}
function clockGlobals(clock) {
  return {
    Date: { now: () => clock.now },
    timeoutMs: 1000,
    visiblePollIntervalMs: 10,
    sleep: async milliseconds => { clock.now += milliseconds; },
  };
}

test('confirmation bracket includes event detection delay and both round trips', async () => {
  const clock = { now: 1000 };
  let calls = 0;
  const poll = helper('snapshotWhen', 'waitAnswerAbsent', {
    ...clockGlobals(clock),
    invoke: async () => {
      clock.now += calls++ === 0 ? 40 : 50;
      return { confirmed: calls > 1 };
    },
  });
  const result = await poll(snapshot => snapshot.confirmed);
  assert.equal(result.anchorLowerBoundHostMs, 1000);
  assert.equal(result.anchorUpperBoundHostMs, 1120);
  const actualConfirmationHostMs = 1070;
  assert(Math.abs(result.hostMidpointMs - actualConfirmationHostMs) <= result.anchorUncertaintyMs);
});

test('first observed confirmation uses the wait start as a conservative bound', async () => {
  const clock = { now: 1000 };
  const poll = helper('snapshotWhen', 'waitAnswerAbsent', {
    ...clockGlobals(clock),
    invoke: async () => { clock.now += 45; return { confirmed: true }; },
  });
  const result = await poll(snapshot => snapshot.confirmed);
  assert.equal(result.anchorLowerBoundHostMs, 1000);
  assert.equal(result.anchorUpperBoundHostMs, 1045);
});

test('DOM absence returns its request time, before the evaluation response', async () => {
  const clock = { now: 1000 };
  const absent = helper('waitAnswerAbsent', 'waitAnswerVisible', {
    ...clockGlobals(clock),
    overlay: { evaluate: async () => { clock.now += 35; return 0; } },
  });
  assert.equal(await absent(), 1000);
});

test('DOM appearance between a false sample and its response remains in the bracket', async () => {
  const clock = { now: 1000 };
  let calls = 0;
  const visible = helper('waitAnswerVisible', 'playRealAudio', {
    ...clockGlobals(clock),
    overlay: { evaluate: async () => { clock.now += 35; return calls++ === 0 ? 0 : 3; } },
  });
  const result = await visible(1000);
  const actualAppearanceHostMs = 1020;
  assert.equal(result.observationWindowMs, 80);
  assert(Math.abs(result.estimatedAtMs - actualAppearanceHostMs) <= result.observationWindowMs / 2);
});
