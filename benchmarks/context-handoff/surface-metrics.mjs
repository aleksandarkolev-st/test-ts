import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9560');
const main=browser.contexts()[0].pages().find(p=>!p.url().includes('view=')&&p.url()!=='about:blank');
const value=await main.evaluate(()=>({top:document.scrollingElement.scrollTop,height:document.scrollingElement.scrollHeight,viewport:innerHeight}));
if(process.argv[2])await writeFile(`artifacts/context-controls/scroll-${process.argv[2]}.json`,JSON.stringify(value,null,2));
console.log(JSON.stringify(value));await browser.close();
