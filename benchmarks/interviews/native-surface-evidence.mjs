import {chromium} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const out='artifacts/ui-smoke/surface-evidence.json';await mkdir('artifacts/ui-smoke',{recursive:true});
let evidence={scope:'Native UI acceptance; not counted among 100+20 interviews',checks:{}};try{evidence=JSON.parse(await readFile(out,'utf8'));}catch{}
const browser=await chromium.connectOverCDP('http://127.0.0.1:9560');
try{
 const pages=browser.contexts()[0].pages(),main=pages.find(p=>p.url().endsWith('/')),overlay=pages.find(p=>p.url().includes('view=overlay'));
 const invoke=name=>main.evaluate(name=>window.__TAURI_INTERNALS__.invoke(name),name);
 let s=await invoke('get_snapshot');
 if(process.argv[2]==='answer'){
  const end=Date.now()+120000;
  while(s.latency?.completedAt==null){if(Date.now()>end)throw Error('Answer did not complete');await new Promise(r=>setTimeout(r,100));s=await invoke('get_snapshot');if(s.error)throw Error(s.error);}
  if(!s.question?.text.startsWith('UI acceptance check'))throw Error('Unexpected answer');
  const source=[...s.answer.matchAll(/```(?:javascript|js)?\s*\n([\s\S]*?)```/g)][0]?.[1];
  if(!source)throw Error('Missing fenced JS code');
  const context=vm.createContext({});vm.runInContext(source,context,{timeout:1000});
  const tests=[{args:{project:null,screenshot:{width:2880}},expected:true},{args:{project:{name:'p'},screenshot:{width:2880}},expected:false},{args:{project:null,screenshot:null},expected:false}];
  for(const t of tests){context.snapshot=t.args;t.actual=vm.runInContext('solve(snapshot)',context,{timeout:1000});t.passed=t.actual===t.expected;}
  evidence.answer={question:s.question.text,text:s.answer,latency:s.latency,functionTests:tests,currentProject:s.project,currentScreenshot:s.screenshot};
 }
 evidence.binarySha256=createHash('sha256').update(await readFile('src-tauri/target/debug/mscv32.exe')).digest('hex');
 const files=['src/App.tsx','src/style.css','src/overlay/Answer.tsx','src/overlay/Overlay.tsx','src/ui/PixelCompanion.tsx'];
 evidence.frontendSha256=createHash('sha256').update((await Promise.all(files.map(f=>readFile(f)))).map(b=>b.toString()).join('\n')).digest('hex');
 const geometry=await overlay.evaluate(()=>{const c=document.querySelector('.answer-content'),pre=document.querySelector('.code-block pre'),root=document.querySelector('.overlay'),footer=document.querySelector('.overlay-footer');return{top:c.scrollTop,height:c.scrollHeight,viewport:c.clientHeight,code:pre?{left:pre.scrollLeft,width:pre.scrollWidth,viewport:pre.clientWidth}:null,rootBottom:root.getBoundingClientRect().bottom,footerBottom:footer.getBoundingClientRect().bottom,windowHeight:innerHeight};});
 evidence.checks[process.argv[2]??'snapshot']={at:new Date().toISOString(),geometry,diagnostics:await invoke('native_diagnostics'),attachments:{project:s.project,screenshot:s.screenshot},status:s.status};
 await writeFile(out,JSON.stringify(evidence,null,2));console.log(JSON.stringify({label:process.argv[2],geometry,tests:evidence.answer?.functionTests?.map(x=>x.passed)}));
}finally{await browser.close();}
