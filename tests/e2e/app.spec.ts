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
        if (cmd === 'bootstrap') return { settings: { ...settings }, speechDevices: [{ index: 1, name: 'Fixture discrete GPU', kind: 'gpu', memoryTotal: 16000000000 }, { index: 0, name: 'Fixture integrated GPU', kind: 'integrated-gpu', memoryTotal: 512000000 }], devices: [{ id: 'mic', name: 'Fixture microphone', source: 'self', default: true }, { id: 'speaker', name: 'Fixture headphones', source: 'remote', default: true }], accounts: signedIn ? [account] : [], selected: signedIn ? account : null, models: [], snapshot: { ...state }, debug: false };
        if (cmd === 'sign_in') { signedIn = true; return account; }
        if (cmd === 'save_settings') { settings = { ...args.settings }; if (settings.answerBackend === 'codex') signedIn = true; return; }
        if (cmd === 'list_models') return settings.answerBackend === 'codex' ? [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna' }] : [{ slug: 'fixture-mini', display_name: 'Fixture model' }];
        if (cmd === 'choose_project') return 'C:\\fixture\\project';
        if (cmd === 'start_meeting') { w.fixtureStartedSettings = { ...args.settings }; state.active = true; state.status = 'listening'; broadcast(); return; }
        if (cmd === 'stop_meeting') { state = { ...state, active: false, status: 'off', answer: '', question: null, manual: false }; broadcast(); return; }
        if (cmd === 'action') {
          w.fixtureLastAction = { ...args };
          if (args.action === 'manual') state.manual = true;
          if (args.action === 'pause') state.paused = !state.paused;
          if (args.action === 'dismiss') { state.question = null; state.answer = ''; state.status = 'listening'; state.manual = false; }
          if (args.action === 'expand') state.expanded = true;
          if (args.action === 'project') state.project = { name: 'project', files: 2, bytes: 120, sourcePath: 'C:\\fixture\\project', collectedAt: Date.now(), filePaths: ['src/main.ts', 'README.md'], skipped: [{ path: 'image.png', reason: 'binary or non-UTF-8 file' }] };
          if (args.action === 'refresh_project') {
            if (w.fixtureRefreshError) throw new Error(w.fixtureRefreshError);
            state.project = { ...state.project, files: 3, filePaths: ['src/main.ts', 'src/parser.ts', 'README.md'], collectedAt: Date.now() };
          }
          if (args.action === 'clear_project') state.project = null;
          if (args.action === 'screenshot') state.screenshot = { width: 1920, height: 1080 };
          if (args.action === 'clear_screenshot') state.screenshot = null;
          broadcast(); return;
        }
        if (cmd === 'ask') { state.question = { id: 'q', text: args.question, detectedAt: 1000 }; state.answer = ''; state.status = 'thinking'; state.manual = false; broadcast(); return; }
        if (cmd === 'resize_overlay') return;
        if (cmd === 'answer_visible') return;
        if (cmd === 'answer_displayed') { (w.fixturePaint ||= []).push(args);return; }
        throw new Error(`Unexpected fixture command ${cmd}`);
      }
    };
    w.fixtureState = (patch: any) => { state = { ...state, ...patch }; broadcast(); };
    w.fixturePaint=[];
    w.fixtureScroll=(payload:string)=>{for(const[eventId,l]of listeners)if(l.event==='copilot:scroll')callbacks.get(l.handler)?.({event:l.event,id:eventId,payload});};
  });
}
test('browser does not pretend to capture audio or sign in', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('Open the desktop app to start a meeting.', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Start meeting' })).toBeDisabled();
});

test('Ctrl Shift arrows scroll vertically in the browser and support held keys', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 400 });
  await page.goto('/');
  const scrollTop = () => page.evaluate(() => document.scrollingElement!.scrollTop);
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect.poll(scrollTop).toBe(80);
  await page.keyboard.press('Control+Shift+ArrowUp');
  await expect.poll(scrollTop).toBe(0);
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.down('ArrowDown'); await page.keyboard.down('ArrowDown');
  await page.keyboard.up('ArrowDown'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await expect.poll(scrollTop).toBe(160);
});
test('Codex discovers its model and passes Fast mode separately from reasoning effort', async ({ page }) => {
  await nativeFixture(page); await page.goto('/');
  await page.getByRole('tab', { name: 'Answers', exact: true }).click();
  await page.getByLabel('Answer backend').selectOption('codex');
  await expect(page.getByText('Signed in to Codex', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Answer model')).toHaveValue('gpt-6-luna');
  await expect(page.getByLabel('Answer speed')).toHaveValue('fast');
  await expect(page.getByLabel('Reasoning effort')).toHaveValue('low');
  await page.getByRole('tab', { name: 'Meeting', exact: true }).click();
  await page.getByLabel('Speech GPU').selectOption('Fixture discrete GPU');
  await page.getByLabel('Local speech model').fill('C:\\fixture\\speech.gguf');
  await page.getByRole('button', { name: 'Start meeting' }).click();
  await expect(page.getByText('Listening', { exact: true })).toBeVisible();
  const settings = await page.evaluate(() => (window as any).fixtureStartedSettings);
  expect(settings).toMatchObject({ answerBackend: 'codex', model: 'gpt-6-luna', serviceTier: 'fast', reasoningEffort: 'low', nemotronDevice: 1, nemotronDeviceName: 'Fixture discrete GPU' });
  await page.getByRole('tab', { name: 'Answers', exact: true }).click();
  await expect(page.getByLabel('Answer backend')).toBeDisabled();
});
test('camera uses named input and GPU, calibrates in order and clears on stop', async ({ page }) => {
  await nativeFixture(page); await page.goto('/');
  await page.getByRole('tab', { name: 'Camera', exact: true }).click();
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
  await nativeFixture(page); await page.goto('/'); await page.getByRole('tab', { name: 'Answers', exact: true }).click(); await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await expect(page.getByText('fixture@example.invalid', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Meeting', exact: true }).click();
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
  await page.getByRole('tab', { name: 'Context', exact: true }).click();
  await page.getByRole('button', { name: 'Choose project folder' }).click();
  await expect(page.getByLabel('Project folder')).toHaveValue('C:\\fixture\\project');
  await page.evaluate(() => (window as any).fixtureState({ active: true, status: 'listening' }));
  await page.getByRole('button', { name: 'Send selected project' }).click();
  await expect(page.getByText('2 files attached', { exact: false })).toBeVisible();
  await page.getByText('1 files skipped').click(); await expect(page.getByText('image.png', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Send screenshot' }).click();
  await expect(page.getByText('Screenshot attached · 1920 × 1080', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Remove screenshot' }).click();
  await expect(page.getByText('Screenshot attached', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove project' }).click();
  await expect(page.getByText('2 files attached', { exact: false })).toHaveCount(0);
});

test('attached projects expose their files and refresh without redetecting another window', async ({ page }) => {
  await nativeFixture(page); await page.goto('/?view=overlay');
  await page.evaluate(() => (window as any).fixtureState({ active: true, status: 'listening',
    project: { name: 'interview-project', sourcePath: 'C:\\interview-project', files: 2, bytes: 2048,
      filePaths: ['src/main.ts', 'README.md'], collectedAt: Date.now(), skipped: [] } }));
  await page.getByText('Included files · 2 KiB').click();
  await expect(page.getByText('src/main.ts', { exact: true })).toBeVisible();
  await expect(page.getByText('Refresh after saving edits.', { exact: false })).toBeVisible();
  const refresh = page.getByRole('button', { name: 'Refresh project' });
  await refresh.click();
  expect(await page.evaluate(() => (window as any).fixtureLastAction)).toEqual({ action: 'refresh_project' });
  await expect(page.getByText('src/parser.ts', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).fixtureState({ attachmentBusy: true }));
  await expect(refresh).toBeDisabled();
  await page.evaluate(() => { (window as any).fixtureState({ attachmentBusy: false }); (window as any).fixtureRefreshError = 'Folder is unavailable; reconnect the drive'; });
  await refresh.click();
  await expect(page.getByRole('alert')).toHaveText('Folder is unavailable; reconnect the drive');
  await expect(page.getByText('interview-project', { exact: true })).toBeVisible();
});

test('a long complete question leaves the useful answer visible and remains scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 700 });
  await nativeFixture(page); await page.goto('/?view=overlay');
  const question = 'State the preconditions, trace each operation, give a counterexample and justify the invariant. '.repeat(24);
  const answer = 'The stream orders the device operations, but the host must wait for copy completion before rewriting the source buffer.';
  await page.evaluate(({ question, answer }) => (window as any).fixtureState({ active: true, status: 'answer', question: { id: 'long-question', text: question, detectedAt: 1000 }, answer }), { question, answer });
  await expect(page.locator('.question p')).toHaveText(question.trim());
  await expect(page.locator('.answer p')).toHaveText(answer);
  const geometry = await page.evaluate(() => {
    const question = document.querySelector('.question p') as HTMLElement;
    const answer = document.querySelector('.answer p') as HTMLElement;
    const content = document.querySelector('.answer-content') as HTMLElement;
    const rect = answer.getBoundingClientRect(), clip = content.getBoundingClientRect();
    question.scrollTop = question.scrollHeight;
    return { scrollable: question.scrollHeight > question.clientHeight, scrolled: question.scrollTop > 0,
      fullyVisible: rect.top >= clip.top && rect.bottom <= clip.bottom && rect.bottom <= innerHeight };
  });
  expect(geometry).toEqual({ scrollable: true, scrolled: true, fullyVisible: true });
});

test('streamed code retains exact source offsets, safe markup and keyboard scrolling',async({page})=>{
  await nativeFixture(page);await page.setViewportSize({width:520,height:700});await page.goto('/?view=overlay');
  const answer='Here is the implementation.\n```javascript\nconst message = "'+('x'.repeat(180))+'";\n'+Array.from({length:35},(_,i)=>`const value${i} = "<script>"; // line ${i}`).join('\n')+'\n```\nThe final explanation.';
  await page.evaluate(answer=>(window as any).fixtureState({active:true,status:'answer',question:{id:'code',text:'Implement the parser',detectedAt:1},answer}),answer);
  await expect(page.getByRole('button',{name:'Copy code'})).toBeVisible();await expect(page.locator('.syntax-keyword').first()).toHaveText('const');
  expect(await page.locator('.answer-body').getAttribute('data-raw-answer')).toBe(answer);
  expect(await page.locator('.code-block script').count()).toBe(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).fixturePaint.length)).toBeGreaterThan(0);
  const paints=await page.evaluate(()=>(window as any).fixturePaint);for(const paint of paints){expect(paint.text).toBe(answer);expect(paint.visibleStart).toBeGreaterThanOrEqual(0);expect(paint.visibleEnd).toBeLessThanOrEqual(answer.length);}
  await page.evaluate(()=>(window as any).fixtureScroll('right'));await expect.poll(()=>page.locator('.code-block pre').evaluate(e=>e.scrollLeft)).toBeGreaterThan(0);
  await page.evaluate(()=>(window as any).fixtureScroll('left'));await expect.poll(()=>page.locator('.code-block pre').evaluate(e=>e.scrollLeft)).toBe(0);
  await page.evaluate(()=>(window as any).fixtureScroll('down'));await expect.poll(()=>page.locator('.answer-content').evaluate(e=>e.scrollTop)).toBe(80);
  await page.evaluate(()=>(window as any).fixtureScroll('up'));await expect.poll(()=>page.locator('.answer-content').evaluate(e=>e.scrollTop)).toBe(0);
  await page.evaluate(()=>(window as any).fixtureScroll('end'));await expect.poll(()=>page.locator('.answer-content').evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(()=>(window as any).fixtureScroll('start'));await expect.poll(()=>page.locator('.answer-content').evaluate(e=>e.scrollTop)).toBe(0);
});

test('answer now accepts the current finalized draft and stays disabled for replaceable partials', async ({ page }) => {
  await nativeFixture(page); await page.goto('/?view=overlay');
  await page.evaluate(() => (window as any).fixtureState({ active: true, status: 'listening', canAnswerNow: false,
    questions: [{ id: 'draft-partial', text: 'Explain the current', state: 'speculative', queued: false }] }));
  const button = page.getByRole('button', { name: 'Answer now', exact: true });
  await expect(button).toBeDisabled();
  await page.evaluate(() => (window as any).fixtureState({ canAnswerNow: true,
    questions: [{ id: 'draft-final', text: 'Explain the current invariant', state: 'speculative', queued: false }] }));
  await expect(button).toBeEnabled(); await button.click();
  expect(await page.evaluate(() => (window as any).fixtureLastAction)).toEqual({ action: 'answer_now', generationId: 'draft-final' });
  await page.evaluate(() => (window as any).fixtureState({ canAnswerNow: false, questions: [] }));
  await expect(button).toBeDisabled();
});


test('setup navigation and crowded overlay preserve readable content and reachable controls', async ({ page }) => {
  await nativeFixture(page); await page.setViewportSize({width:520,height:700}); await page.goto('/');
  await page.getByRole('tab',{name:'Meeting',exact:true}).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab',{name:'Answers',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('heading',{name:'Your answers'})).toBeVisible();
  await page.keyboard.press('End'); await expect(page.getByRole('heading',{name:'Keep eye contact'})).toBeVisible();
  await expect.poll(() => page.locator('.pixel-companion img').evaluate(e => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  if(process.env.UI_CAPTURE){
    for(const name of ['Meeting','Answers','Context','Camera']){
      await page.getByRole('tab',{name,exact:true}).click();
      await page.screenshot({animations:'disabled',path:`.impeccable/review/setup-${name.toLowerCase()}-520.png`});
    }
  }
  await page.goto('/?view=overlay');
  if(process.env.UI_CAPTURE) await page.screenshot({animations:'disabled',path:'.impeccable/review/overlay-empty-520.png'});
  const answer='Use the map to preserve the invariant.\n```javascript\n'+Array.from({length:55},(_,i)=>`const value${i} = ${i}; // preserve exact code`).join('\n')+'\n```\nCheck the boundary before committing the update.';
  await page.evaluate(answer=>(window as any).fixtureState({active:true,status:'answer',manual:true,protection:true,
    question:{id:'crowded',text:'Find the boundary bug and return a complete implementation.',detectedAt:1},answer,
    project:{name:'inventory-service',files:12,bytes:6400,skipped:[{path:'image.png',reason:'binary'}]},screenshot:{width:1920,height:1080}}),answer);
  await expect(page.getByRole('button',{name:'Dismiss answer'})).toBeVisible();
  const geometry=await page.evaluate(()=>{
    const root=document.querySelector('.overlay')!.getBoundingClientRect();
    const footer=document.querySelector('.overlay-footer')!.getBoundingClientRect();
    const content=document.querySelector('.answer-content') as HTMLElement;
    const tools=document.querySelector('.overlay-tools') as HTMLElement;
    return {rootBottom:root.bottom,footerBottom:footer.bottom,readingHeight:content.clientHeight,
      answerScrolls:content.scrollHeight>content.clientHeight,toolsScroll:tools.scrollHeight>tools.clientHeight};
  });
  expect(geometry.rootBottom).toBeLessThanOrEqual(700);expect(geometry.footerBottom).toBeLessThanOrEqual(700);
  expect(geometry.readingHeight).toBeGreaterThan(170);expect(geometry.answerScrolls).toBe(true);expect(geometry.toolsScroll).toBe(true);
  await page.evaluate(()=>(window as any).fixtureScroll('end'));
  await expect(page.getByText('Check the boundary before committing the update.',{exact:true})).toBeVisible();
  if(process.env.UI_CAPTURE) await page.screenshot({animations:'disabled',path:'.impeccable/review/overlay-code-end-520.png'});
  await page.evaluate(()=>(window as any).fixtureScroll('start'));
  if(process.env.UI_CAPTURE) await page.screenshot({animations:'disabled',path:'.impeccable/review/overlay-code-520.png'});
});


test('pixel companion receives coordinates without intercepting controls and respects reduced motion',async({page})=>{
  await nativeFixture(page);await page.goto('/');await page.locator('.pixel-companion').hover({position:{x:20,y:20}});
  await expect.poll(()=>page.locator('.companion-pixels canvas').evaluate((e:HTMLCanvasElement)=>{
    const data=e.getContext('2d')!.getImageData(0,0,e.width,e.height).data;
    return Array.from(data).filter((v,i)=>i%4===3&&v>0).length;
  })).toBeGreaterThan(0);
  await page.mouse.move(500,690);await expect(page.locator('.companion-pixels')).toHaveCount(0);
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('.pixel-companion').hover();
  await expect(page.locator('.companion-pixels')).toHaveCount(0);
});
