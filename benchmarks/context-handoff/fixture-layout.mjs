import {chromium} from '@playwright/test';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9562');
const screen=browser.contexts()[0].pages().find(p=>p.url().startsWith('http://127.0.0.1:9561'));
await screen.addStyleTag({content:'body { max-width: 700px; margin: 30px; } h1 { font-size: 30px; } pre { font-size: 20px; overflow-wrap: anywhere; }'});
await browser.close();
