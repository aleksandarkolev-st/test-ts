// Run only after the Computer Use shortcut succeeds. This helper never attaches
// context; it rejects a changed foreground source before advancing the runner.
import path from 'node:path';
const origin='http://127.0.0.1:9571';
const state=await fetch(origin+'/state').then(r=>r.json());
const ready=state.ready;
if(ready?.phase!=='handoff'||ready.id!==process.argv[2]||ready.patched!==(process.argv[3]==='patched'))throw Error('Unexpected live handoff');
const detected=await fetch(origin+'/detect').then(r=>r.json());
const expected=ready.mode==='screenshot'?'browser':ready.mode==='project-vscode'?'vscode':'folder';
if(detected.kind!==expected)throw Error('Foreground source changed: '+JSON.stringify(detected));
const normalize=value=>path.normalize(value.replace(/^\\\\\?\\/,'')).toLowerCase();
if(expected!=='browser'&&normalize(detected.projectPath??'')!==normalize(ready.folder))throw Error('A different folder is active');
const response=await fetch(origin+'/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:ready.token,detected,shortcut:'Ctrl Shift P',source:'Computer Use'})});
if(!response.ok)throw Error(await response.text());
console.log(await response.text());
