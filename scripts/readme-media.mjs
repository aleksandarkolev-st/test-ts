// Capture the real React UI with synthetic, offline documentation data.
// Run from the repository root: node scripts/readme-media.mjs
// Requires the project's npm dependencies, Edge (Windows) / Chromium, and ffmpeg.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/images');
const origin = 'http://127.0.0.1:1431';
await mkdir(output, { recursive: true });
await mkdir(path.join(root, '.local'), { recursive: true });
const frames = await mkdtemp(path.join(root, '.local/readme-frames-'));
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '1431', '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let serverLog = '';
server.stdout.on('data', data => { serverLog += data; });
server.stderr.on('data', data => { serverLog += data; });
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null || attempt === 100) throw new Error(`Documentation server failed: ${serverLog}`);
    if (await fetch(origin).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  const context = await browser.newContext({ viewport: { width: 600, height: 1240 }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    const callbacks = new Map(), listeners = new Map(); let id = 0;
    const timestamp = Date.UTC(2026, 9, 15, 14, 30);
    let state = { revision: 1, task: { id: 'demo-task', problem: '', testOutput: null }, active: false, paused: false, status: 'off', question: null, answer: '', error: null, protection: false, expanded: false, manual: false, latency: null, remoteLevel: 0, selfLevel: 0, project: null, screenshot: null, attachmentBusy: false };
    const settings = { microphone: 'mic', output: 'headphones', answerBackend: 'codex', model: 'demo-model', modelPath: 'C:\\MeetingCopilot\\models\\speech.gguf', nemotronRuntime: 'C:\\MeetingCopilot\\nemotron\\nemo-speech.exe', speechBackend: 'nemotron', speechChunkMs: 160, serviceTier: 'fast', reasoningEffort: 'low', projectPath: 'C:\\demo\\balanced-delimiters' };
    const broadcast = patch => { state = { ...state, ...patch, revision: state.revision + 1 }; for (const [key, listener] of listeners) if (listener.event === 'copilot:state') callbacks.get(listener.handler)?.({ event: listener.event, id: key, payload: state }); };
    window.isTauri = true;
    window.docsDemo = broadcast;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, key) => listeners.delete(key) };
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { callbacks.set(++id, callback); return id; },
      invoke: async (command, args = {}) => {
        if (command === 'runtime_ready') return true;
        if (command === 'plugin:event|listen') { listeners.set(++id, { event: args.event, handler: args.handler }); return id; }
        if (command === 'plugin:event|unlisten') return;
        if (command === 'get_snapshot') return state;
        if (command === 'bootstrap') return { settings, devices: [{ id: 'mic', name: 'Demo microphone', source: 'self', default: true }, { id: 'headphones', name: 'Demo headphones', source: 'remote', default: true }], speechDevices: [], accounts: [], selected: { clientId: 'docs', email: 'demo@example.invalid', planEnabled: true }, snapshot: state, debug: false, shortcutErrors: [] };
        if (command === 'list_models') return [{ slug: 'demo-model', display_name: 'Demo account model' }];
        if (command === 'start_meeting') return broadcast({ active: true, status: 'listening' });
        if (command === 'update_task') return broadcast({ task: { ...state.task, ...(args.field === 'problem' ? { problem: args.text } : { testOutput: { text: args.text, updatedAt: timestamp } }) } });
        if (command === 'action' && args.action === 'new_task') return broadcast({ task: { id: `demo-${++id}`, problem: '', testOutput: null }, question: null, answer: '', project: null, screenshot: null, status: 'listening' });
        if (['resize_overlay', 'answer_visible', 'answer_displayed'].includes(command)) return;
        throw new Error(`Unsupported documentation command: ${command}`);
      }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const capture = async (name, locator = page) => {
    await page.evaluate(() => document.fonts.ready);
    await locator.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  };
  await page.goto(origin);
  await expect(page.getByLabel('Microphone')).toHaveValue('mic');
  await page.locator('.pixel-companion img').evaluate(image => image.decode());
  await page.waitForTimeout(500); // Let the image-backed canvas finish its first paint.
  await capture('meeting-setup');
  await page.getByRole('tab', { name: 'Answers', exact: true }).click();
  await expect(page.getByLabel('Answer model')).toHaveValue('demo-model');
  await capture('answer-settings');
  await page.getByRole('tab', { name: 'Context', exact: true }).click();
  await page.evaluate(() => window.docsDemo({ active: true, status: 'listening' }));
  await page.locator('.task-context summary').click();
  await page.getByLabel('Problem statement', { exact: true }).fill('Return the first unmatched bracket index, or -1 when every bracket is balanced.');
  await page.getByRole('button', { name: 'Save problem', exact: true }).click();
  await page.getByLabel('Test output', { exact: true }).fill('PASS: ()[]\nFAIL: ([)] — expected 2, received -1');
  await page.getByRole('button', { name: 'Update test output', exact: true }).click();
  const attachment = { project: { name: 'balanced-delimiters', sourcePath: 'C:\\demo\\balanced-delimiters', files: 3, bytes: 2048, filePaths: ['src/brackets.ts', 'tests/brackets.test.ts', 'README.md'], collectedAt: Date.UTC(2026, 9, 15, 14, 30), skipped: [] }, screenshot: { width: 1920, height: 1080, capturedAt: Date.UTC(2026, 9, 15, 14, 30) } };
  await page.evaluate(patch => window.docsDemo(patch), attachment);
  await expect(page.getByText('3 saved files updated at', { exact: false })).toBeVisible();
  await capture('interview-task', page.locator('.task-context'));

  await page.goto(`${origin}/?view=overlay`);
  await page.setViewportSize({ width: 600, height: 780 });
  const problem = 'Return the first unmatched bracket index, or -1 when every bracket is balanced.';
  await page.evaluate(problem => window.docsDemo({ active: true, status: 'listening', task: { id: 'demo-task', problem, testOutput: null } }), problem);
  const frame = async index => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(frames, `${index}.png`), animations: 'disabled' });
  };
  await expect(page.locator('.task-problem')).toHaveText(problem);
  await page.locator('.pixel-companion img').evaluate(image => image.decode());
  await page.waitForTimeout(500);
  await frame(0);
  await page.evaluate(patch => window.docsDemo(patch), attachment);
  await expect(page.getByText('3 saved files updated at', { exact: false })).toBeVisible();
  await page.locator('.overlay-tools').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await frame(1);
  await page.evaluate(() => window.docsDemo({ status: 'thinking', question: { id: 'demo-question', text: 'Why does ([)] pass my bracket validator?', detectedAt: 1 } }));
  await expect(page.getByRole('status')).toBeVisible();
  await page.locator('.overlay-tools').evaluate(element => { element.scrollTop = 0; });
  await frame(2);
  const answer = 'A count alone misses nesting order. Keep opening brackets on a stack and compare each closing bracket with the top.\n\nFor ([)], the ) at index 2 mismatches [, so return 2.\n\nTime: O(n). Space: O(n) in the worst case.';
  await page.evaluate(answer => window.docsDemo({ status: 'answer', answer: answer.slice(0, 96) }), answer);
  await expect(page.locator('.answer-body')).toContainText('A count alone');
  await frame(3);
  await page.evaluate(answer => window.docsDemo({ answer }), answer);
  await expect(page.locator('.answer-body')).toContainText('worst case');
  await capture('answer-overlay', page.locator('.overlay'));
  await frame(4);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.locator('.task-problem')).toHaveCount(0);
  await expect(page.getByText('Ready when you are.', { exact: true })).toBeVisible();
  await frame(5);
  if (errors.length) throw new Error(errors.join('\n'));
  const timeline = [0, 1, 2, 3, 4, 5].map((index) => `file '${index}.png'\nduration ${index === 4 ? 4 : 2}`).join('\n') + "\nfile '5.png'\n";
  await writeFile(path.join(frames, 'timeline.txt'), timeline);
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'timeline.txt', '-filter_complex', '[0:v]fps=5,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer', '-loop', '0', path.join(output, 'interview-walkthrough.gif')], { cwd: frames, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  for (const name of ['meeting-setup.png', 'answer-settings.png', 'interview-task.png', 'answer-overlay.png', 'interview-walkthrough.gif']) console.log(`${name}: ${Math.round((await stat(path.join(output, name))).size / 1024)} KiB`);
} finally {
  await browser?.close();
  server.kill();
  if (path.dirname(frames) !== path.join(root, '.local')) throw new Error('Refusing to clean frames outside the workspace');
  await rm(frames, { recursive: true, force: true });
}
