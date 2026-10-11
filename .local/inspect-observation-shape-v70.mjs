import {readFile} from 'node:fs/promises';
const j=JSON.parse(await readFile('artifacts/deep-interview-v70/algorithms-hour-t/interview.json'));
const id=j.rows.at(-1).responseVersion.split(':')[0];
const samples=j.deepObservations.flatMap(o=>(o.jobs??[]).filter(x=>x.question.id===id).map(x=>({format:o.format,...x})));
for(const job of [samples[0],samples.find(x=>x.latency?.responseRevision===30),samples.at(-1)]){
 console.log(JSON.stringify(Object.fromEntries(Object.entries(job).map(([key,value])=>[key,
  typeof value==='string'?{chars:value.length,preview:value.slice(0,160)}:Array.isArray(value)?{arrayLength:value.length}:value]))));
}
