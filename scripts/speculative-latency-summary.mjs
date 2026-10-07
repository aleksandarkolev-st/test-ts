import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const folder = 'artifacts/live-service';
const runs = [];
for (const effort of ['low', 'xhigh']) {
  const file = `${folder}/codex-gpt6-luna-fast-${effort}-speculative.json`;
  const r = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(r.status, 'passed'); assert.equal(r.productionBuild, true);
  assert.equal(r.modelSlug, 'gpt-6-luna'); assert.equal(r.reasoningEffort, effort);
  assert.equal(r.answerBackend, 'codex'); assert.equal(r.serviceTier, 'fast');
  assert.equal(r.samples.length, 5); assert(r.samples.every(s => s.contextAnswerMatched));
  assert(r.samples.every(s => s.native.questionConfirmedToRequestSentMs < 0), 'Inference must precede confirmation');
  runs.push({ effort, report: file, ...r.timing,
    visibleSamplesMs: r.samples.map(s => s.visible.speechEndToFirstVisibleMs),
    maximumVisibleMs: Math.max(...r.samples.map(s => s.visible.speechEndToFirstVisibleMs)),
    speculativeLeadMs: r.samples.map(s => -s.native.questionConfirmedToRequestSentMs),
    contextRecall: '5/5', completedAt: r.completedAt });
}
const browser = await chromium.connectOverCDP('http://127.0.0.1:9557');
let state;
try {
  const page = browser.contexts()[0].pages().find(p => p.url() !== 'about:blank' && !p.url().includes('view='));
  assert(page);
  const invoke = (name, args = {}) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
  const b = await invoke('bootstrap'); assert.equal(b.debug, false); assert.equal(b.snapshot.active, false);
  await invoke('save_settings', { settings: { ...b.settings, answerBackend: 'codex', model: 'gpt-6-luna', serviceTier: 'fast', reasoningEffort: 'xhigh' } });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('select[aria-label="Reasoning effort"]')?.value === 'xhigh');
  const after = await invoke('bootstrap'); assert.equal(after.snapshot.answer, ''); assert.equal(after.snapshot.question, null);
  state = { active: after.snapshot.active, authenticated: Boolean(after.selected),
    model: after.settings.model, effort: after.settings.reasoningEffort, backend: after.settings.answerBackend, tier: after.settings.serviceTier };
} finally { await browser.close(); }
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const executableSha256 = await sha256('src-tauri/target/release/meeting-copilot.exe');
assert.equal(await sha256('.local/msi-upgrade-0.2.2/PFiles/Meeting Copilot/meeting-copilot-speculative-final.exe'), executableSha256);
const native = JSON.parse(await readFile('artifacts/scheduler/results.json', 'utf8'));
assert.equal(native.pass, true); assert.equal(native.maxActiveAnswers, 2);
const sourceHashes = {};
for (const file of ['src-tauri/src/runtime.rs', 'src-tauri/src/meeting/scheduler.rs', 'src-tauri/src/meeting/questions.rs', 'src-tauri/src/openai/codex.rs']) sourceHashes[file] = await sha256(file);
const summary = { runs, state, sourceHashes,
  executableSha256, schedulerChecks: native.checks.length,
  updatedAt: new Date().toISOString() };
await writeFile(`${folder}/speculative-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
