import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9560');
const main=browser.contexts()[0].pages().find(p=>!p.url().includes('view=')&&p.url()!=='about:blank');
const value=process.argv[3]==='main'?await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|outer_position',{label:'main'})):await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('native_diagnostics'));
if(process.argv[2])await writeFile(`artifacts/context-handoff/control-${process.argv[2]}.json`,JSON.stringify(value,null,2));
console.log(JSON.stringify(value));await browser.close();
