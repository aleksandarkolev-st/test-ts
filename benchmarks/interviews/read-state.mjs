// Read-only native geometry after a Computer Use key. No synthetic scroll injection.
import {chromium} from '@playwright/test';
import {writeFile,mkdir} from 'node:fs/promises';
const stage=await fetch('http://127.0.0.1:9571/state').then(r=>r.json());
if(stage.ready?.phase!=='reading')throw Error('No live reading check advertised');
const direction=process.argv[2];if(!stage.ready.directions.includes(direction))throw Error('Unrequested reading operation');
const browser=await chromium.connectOverCDP('http://127.0.0.1:9570');
try{
 const pages=browser.contexts()[0].pages(),overlay=pages.find(p=>p.url().includes('view=overlay'));
 const geometry=await overlay.evaluate(()=>{const c=document.querySelector('.answer-content'),pre=document.querySelector('.code-block pre');return{top:c.scrollTop,height:c.scrollHeight,viewport:c.clientHeight,code:pre?{left:pre.scrollLeft,width:pre.scrollWidth,viewport:pre.clientWidth}:null,footerBottom:document.querySelector('.overlay-footer').getBoundingClientRect().bottom,windowHeight:innerHeight};});
 const value={token:stage.ready.token,id:stage.ready.id,direction,source:'Computer Use global keyboard shortcut; independent native CDP geometry read',geometry,at:new Date().toISOString()};
 await mkdir('artifacts/interview-suite/reading',{recursive:true});
 await writeFile('artifacts/interview-suite/reading/'+stage.ready.token+'-'+direction+'.json',JSON.stringify(value,null,2));
 console.log(JSON.stringify(value));
}finally{await browser.close();}
