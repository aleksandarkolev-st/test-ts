// Call only after Computer Use has pressed every requested key and read-state
// has recorded the actual native geometry. This helper performs no UI input.
import {readFile} from 'node:fs/promises';
const state=await fetch('http://127.0.0.1:9571/state').then(r=>r.json());
const ready=state.ready;
if(ready?.phase!=='reading'||ready.id!==process.argv[2])throw Error('Unexpected live reading check');
const steps=await Promise.all(ready.directions.map(async direction=>{
 const step=JSON.parse(await readFile('artifacts/interview-suite/reading/'+ready.token+'-'+direction+'.json','utf8'));
 if(step.token!==ready.token||step.id!==ready.id||step.direction!==direction||!step.source.startsWith('Computer Use'))throw Error('Mismatched reading evidence');
 return step;
}));
const response=await fetch('http://127.0.0.1:9571/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:ready.token,source:'Computer Use',steps})});
if(!response.ok)throw Error(await response.text());
console.log(await response.text());
