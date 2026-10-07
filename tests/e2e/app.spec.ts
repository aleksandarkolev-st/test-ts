import { test, expect, type Page } from '@playwright/test';
async function nativeFixture(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.isTauri = true;
    const callbacks = new Map<number, Function>(); const listeners = new Map<number, { event: string; handler: number }>(); let id = 0;
    let state = { revision: 1, active: false, paused: false, status: 'off', question: null as any, answer: '', error: null, protection: false, expanded: false, manual: false, latency: null as any, remoteLevel: 0, selfLevel: 0, project: null as any, screenshot: null as any, attachmentBusy: false };
    const account = { clientId: 'fixture-client', email: 'fixture@example.invalid', name: 'Fixture', planEnabled: true };
    let signedIn = false;
    let settings: any = { microphone: '', output: '', modelPath: '', model: '', speechBackend: 'nemotron', speechChunkMs: 160, nemotronRuntime: 'C:\\fixture\\nemo-speech.exe', nemotronDevice: 1 };
    let camera = { running: false, loading: false, calibrated: false, cameraCalibrated: false, calibrating: null, face: false, correcting: false, message: 'Start the camera to preview and calibrate correction.', error: null, preview: null, device: '', camera: '', fps: 0, frameAgeMs: 0, frameAgeP95Ms: 0, vertical: 0, horizontal: 0 };
    const cameraBroadcast = () => { for (const [eventId, l] of listeners) if (l.event === 'copilot:gaze') callbacks.get(l.handler)?.({ event: l.event, id: eventId, payload: { ...camera } }); };
    const broadcast = () => { state.revision++; for (const [eventId, l] of listeners) if (l.event === 'copilot:state') callbacks.get(l.handler)?.({ event: l.event, id: eventId, payload: { ...state } }); };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_: string, eventId: number) => listeners.delete(eventId) };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (f: Function) => { callbacks.set(++id, f); return id; },
      invoke: async (cmd: string, args: any = {}) => {
        if (cmd === 'plugin:event|listen') { listeners.set(++id, { event: args.event, handler: args.handler }); return id; }
        if (cmd === 'plugin:event|unlisten') return;
        if (cmd === 'get_snapshot') return { ...state };
        if (cmd === 'gaze_snapshot') return { ...camera };
        if (cmd === 'gaze_devices') return { cameras: [{ index: 0, name: 'Fixture webcam', allowed: true }, { index: 1, name: 'OBS Virtual Camera', allowed: false }], gpus: [{ index: 1, name: 'Fixture AMD GPU', dedicated_video_bytes: 16000000000 }] };
        if (cmd === 'gaze_start') { camera = { ...camera, running: true, face: true, camera: 'Fixture webcam', device: 'Fixture AMD GPU', fps: 30, message: 'Look at the camera and calibrate.' }; cameraBroadcast(); return; }
        if (cmd === 'gaze_control') { if (args.action === 'calibrate_camera') camera.cameraCalibrated = true; if (args.action === 'calibrate_notes') { camera.calibrated = true; camera.correcting = true; } cameraBroadcast(); return; }
        if (cmd === 'gaze_stop') { camera = { ...camera, running: false, preview: null, calibrated: false, cameraCalibrated: false, correcting: false }; cameraBroadcast(); return; }
        if (cmd === 'bootstrap') return { settings: { ...settings }, devices: [{ id: 'mic', name: 'Fixture microphone', source: 'self', default: true }, { id: 'speaker', name: 'Fixture headphones', source: 'remote', default: true }], accounts: signedIn ? [account] : [], selected: signedIn ? account : null, models: [], snapshot: { ...state }, debug: false };
        if (cmd === 'sign_in') { signedIn = true; return account; }
        if (cmd === 'save_settings') { settings = { ...args.settings }; if (settings.answerBackend === 'codex') signedIn = true; return; }
        if (cmd === 'list_models') return settings.answerBackend === 'codex' ? [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna' }] : [{ slug: 'fixture-mini', display_name: 'Fixture model' }];
        if (cmd === 'choose_project') return 'C:\\fixture\\project';
        if (cmd === 'start_meeting') { w.fixtureStartedSettings = { ...args.settings }; state.active = true; state.status = 'listening'; broadcast(); return; }
        if (cmd === 'stop_meeting') { state = { ...state, active: false, status: 'off', answer: '', question: null, manual: false }; broadcast(); return; }
        if (cmd === 'action') {
          if (args.action === 'manual') state.manual = true;
          if (args.action === 'pause') state.paused = !state.paused;
          if (args.action === 'dismiss') { state.question = null; state.answer = ''; state.status = 'listening'; state.manual = false; }
          if (args.action === 'expand') state.expanded = true;
          if (args.action === 'project') state.project = { name: 'project', files: 2, bytes: 120, skipped: [{ path: 'image.png', reason: 'binary or non-UTF-8 file' }] };
          if (args.action === 'clear_project') state.project = null;
          if (args.action === 'screenshot') state.screenshot = { width: 1920, height: 1080 };
          if (args.action === 'clear_screenshot') state.screenshot = null;
          broadcast(); return;
        }
        if (cmd === 'ask') { state.question = { id: 'q', text: args.question, detectedAt: 1000 }; state.answer = ''; state.status = 'thinking'; state.manual = false; broadcast(); return; }
        if (cmd === 'resize_overlay') return;
        throw new Error(`Unexpected fixture command ${cmd}`);
      }
    };
    w.fixtureState = (patch: any) => { state = { ...state, ...patch }; broadcast(); };
  });
}
test('browser does not pretend to capture audio or sign in', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('Open the desktop app to start a meeting.', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Start meeting' })).toBeDisabled();
});
test('Codex discovers its model and passes Fast mode separately from reasoning effort', async ({ page }) => {
  await nativeFixture(page); await page.goto('/');
  await page.getByLabel('Answer backend').selectOption('codex');
  await expect(page.getByText('Signed in to Codex', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Answer model')).toHaveValue('gpt-6-luna');
  await expect(page.getByLabel('Answer speed')).toHaveValue('fast');
  await page.getByLabel('Reasoning effort').selectOption('xhigh');
  await page.getByLabel('Local speech model').fill('C:\\fixture\\speech.gguf');
  await page.getByRole('button', { name: 'Start meeting' }).click();
  await expect(page.getByText('Listening', { exact: true })).toBeVisible();
  const settings = await page.evaluate(() => (window as any).fixtureStartedSettings);
  expect(settings).toMatchObject({ answerBackend: 'codex', model: 'gpt-6-luna', serviceTier: 'fast', reasoningEffort: 'xhigh' });
  await expect(page.getByLabel('Answer backend')).toBeDisabled();
});
test('camera uses named input and GPU, calibrates in order and clears on stop', async ({ page }) => {
  await nativeFixture(page); await page.goto('/');
  await expect(page.getByLabel('Input camera')).toHaveValue('0');
  await expect(page.getByLabel('Input camera').getByRole('option', { name: 'OBS Virtual Camera' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start camera preview' }).click();
  await expect(page.getByRole('button', { name: 'Calibrate looking at notes' })).toBeDisabled();
  await page.getByRole('button', { name: 'Calibrate looking at camera' }).click();
  await page.getByRole('button', { name: 'Calibrate looking at notes' }).click();
  await expect(page.getByText('Correcting eye gaze', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await expect(page.getByText('Camera off', { exact: true })).toBeVisible();
  await expect(page.getByAltText('Live local gaze-correction preview')).toHaveCount(0);
});
test('startup, account model discovery, meeting start, pause and stop', async ({ page }) => {
  await nativeFixture(page); await page.goto('/'); await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page.getByText('fixture@example.invalid', { exact: true })).toBeVisible();
  await page.getByLabel('Local speech model').fill('C:\\models\\fixture.bin');
  await page.getByRole('button', { name: 'Start meeting' }).click(); await expect(page.getByText('Listening', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause listening' }).click(); await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop meeting' }).click(); await expect(page.getByRole('button', { name: 'Start meeting' })).toBeVisible();
});
test('overlay shows incremental answer, honest protection, manual ask and dismissal', async ({ page }) => {
  await nativeFixture(page); await page.goto('/?view=overlay'); await expect(page.getByText('Share protection unavailable', { exact: false })).toBeVisible();
  await page.evaluate(() => (window as any).fixtureState({ active: true, status: 'thinking', question: { id: 'q', text: 'What is our launch date?', detectedAt: 1000 } }));
  await expect(page.getByText('What is our launch date?', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).fixtureState({ status: 'answer', answer: 'October ' })); await expect(page.getByText('October', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).fixtureState({ answer: 'October 28 looks realistic.', protection: true })); await expect(page.getByText('October 28 looks realistic.', { exact: true })).toBeVisible(); await expect(page.getByText('Share protection active', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Ask', exact: true }).click(); await page.getByLabel('Ask about this meeting…').fill('What was decided?'); await page.locator('form').getByRole('button', { name: 'Ask', exact: true }).click(); await expect(page.getByText('What was decided?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss answer' }).click(); await expect(page.getByText('What was decided?', { exact: true })).toHaveCount(0);
});
test('project selection and screenshot controls expose attached context and removal', async ({ page }) => {
  await nativeFixture(page); await page.goto('/');
  await page.getByRole('button', { name: 'Choose project folder' }).click();
  await expect(page.getByLabel('Project folder')).toHaveValue('C:\\fixture\\project');
  await page.evaluate(() => (window as any).fixtureState({ active: true, status: 'listening' }));
  await page.getByRole('button', { name: 'Send project · Ctrl Shift P' }).click();
  await expect(page.getByText('2 files attached', { exact: false })).toBeVisible();
  await page.getByText('1 files skipped').click(); await expect(page.getByText('image.png', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Send screenshot · Ctrl Shift F8' }).click();
  await expect(page.getByText('Screenshot attached · 1920 × 1080', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Remove screenshot' }).click();
  await expect(page.getByText('Screenshot attached', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove project' }).click();
  await expect(page.getByText('2 files attached', { exact: false })).toHaveCount(0);
});
