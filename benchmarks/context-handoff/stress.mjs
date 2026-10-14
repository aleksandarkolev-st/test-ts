import vm from 'node:vm';
import {readFile,writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
const r=JSON.parse(await readFile('artifacts/context-handoff/results.json','utf8'));
const n=20000,descending=Array.from({length:n},(_,i)=>n-i);
const stress={
 32:[['()'.repeat(15000)],30000],
 42:[[Array.from({length:20000},(_,i)=>i===0||i===19999?1000:0)],19998000],
 84:[[Array.from({length:n},(_,i)=>i+1)],100010000],
 85:[[Array.from({length:200},()=>Array(200).fill('1'))],40000],
 115:[['a'.repeat(30),'a'.repeat(15)],155117520],
 132:[['a'.repeat(2000)],0],
 239:[[descending,10000],descending.slice(0,10001)],
 315:[[descending],descending.map(x=>x-1)],
 329:[[Array.from({length:200},(_,i)=>Array.from({length:200},(_,j)=>i*200+(i%2===0?j:199-j)))],40000],
 493:[[Array.from({length:8000},(_,i)=>8000-i)],15996000],
 3:[['abc'.repeat(10000)],3],
 200:[[Array.from({length:300},()=>Array(300).fill('1'))],1],
 322:[[[1,7,23],10000],440],
 20:[['('.repeat(5000)+')'.repeat(5000)],true]
};
const checks=[];
for(const row of r.rows){if(!stress[row.id])continue;const [args,expected]=stress[row.id];const context=vm.createContext({args});const code=await readFile(`artifacts/context-handoff/solution-${row.id}.js`,'utf8');const begin=performance.now();try{vm.runInContext(code,context,{timeout:1500});const actual=JSON.parse(JSON.stringify(vm.runInContext('solve(...args)',context,{timeout:2000})));checks.push({id:row.id,passed:isDeepStrictEqual(actual,expected),elapsedMs:performance.now()-begin,inputShape:args.map(a=>Array.isArray(a)?[a.length,Array.isArray(a[0])?a[0].length:null]:typeof a==='string'?a.length:a),actualPreview:typeof actual==='object'?null:actual,expectedPreview:typeof expected==='object'?null:expected});}catch(e){checks.push({id:row.id,passed:false,error:String(e),elapsedMs:performance.now()-begin});}}
await writeFile('artifacts/context-handoff/stress.json',JSON.stringify(checks,null,2));console.log(JSON.stringify(checks,null,2));
