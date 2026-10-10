import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.COPILOT_CDP_PORT || 9557);
const model = process.env.COPILOT_LIVE_MODEL || 'gpt-6.1-sol';
const reasoningEffort = process.env.COPILOT_LIVE_EFFORT || 'low';
const outputDir = path.join(root, 'artifacts/live-service');
await mkdir(outputDir, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const main = browser.contexts()[0].pages().find(page =>
    page.url() !== 'about:blank' && !page.url().includes('view=overlay'));
  if (!main) throw new Error('Expected the production setup window');
  const invoke = (name, args = {}) => main.evaluate(({ name, args }) =>
    window.__TAURI_INTERNALS__.invoke(name, args), { name, args });

  const before = await invoke('bootstrap');
  if (before.debug) throw new Error('Expected the production app');
  if (before.snapshot.active) throw new Error('Cannot restore settings while a meeting is active');
  if (!before.settings || !before.selected?.planEnabled) {
    throw new Error('Expected the saved signed-in production account and settings');
  }
  const models = await invoke('list_models');
  if (!models.some(entry => entry.slug === model)) throw new Error('Requested model unavailable in signed-in catalog');
  const settings = { ...before.settings, answerBackend: 'codex', model, reasoningEffort, serviceTier: 'fast' };
  await invoke('save_settings', { settings });

  const after = await invoke('bootstrap');
  if (after.snapshot.active) throw new Error('A meeting became active during settings restore');
  if (after.settings.model !== model || after.settings.reasoningEffort !== reasoningEffort || after.settings.answerBackend !== 'codex' || after.settings.serviceTier !== 'fast') {
    throw new Error('Saved model and reasoning effort did not persist');
  }
  const proof = {
    status: 'passed',
    productionBuild: !after.debug,
    meetingActive: after.snapshot.active,
    savedModelSlug: after.settings.model,
    savedReasoningEffort: after.settings.reasoningEffort,
    savedServiceTier: after.settings.serviceTier,
    savedBackend: after.settings.answerBackend,
    accountCount: after.accounts.length,
    cloudRequestMade: false,
    completedAt: new Date().toISOString(),
  };
  await writeFile(path.join(outputDir, 'settings-restored.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  await browser.close();
}
