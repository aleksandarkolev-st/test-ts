import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Read the signed-in app's current catalog without starting a meeting or
// requesting an answer. Persist model availability only, never account data.
const port = Number(process.env.COPILOT_CDP_PORT || 9557);
const requested = process.env.COPILOT_LIVE_MODEL || 'gpt-6-luna';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page = browser.contexts()[0].pages().find(p =>
    p.url() !== 'about:blank' && !p.url().includes('view='));
  if (!page) throw new Error('Production app setup window is unavailable');
  const invoke = (name) => page.evaluate(name =>
    window.__TAURI_INTERNALS__.invoke(name), name);
  const before = await invoke('bootstrap');
  if (before.debug || before.snapshot.active || !before.selected?.planEnabled) {
    throw new Error('Expected a signed-in idle production app');
  }
  const models = await invoke('list_models');
  const after = await invoke('bootstrap');
  if (after.snapshot.active) throw new Error('Meeting unexpectedly became active');
  const report = {
    source: 'fresh signed-in account GET /v1/models',
    requestedModel: requested,
    requestedModelListed: models.some(m => m.slug === requested),
    models: models.map(({ slug, display_name }) => ({ slug, displayName: display_name })),
    meetingActive: false,
    answerRequestMade: false,
    completedAt: new Date().toISOString(),
  };
  const directory = path.join(process.cwd(), 'artifacts/live-service');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'catalog-latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
