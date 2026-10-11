import {readFile} from 'node:fs/promises';
const root='artifacts/deep-interview-v70';
for(const [name,file] of [
 ['dsa',root+'/algorithms-hour-t/duration-audit-unassigned-turn-fix.json'],
 ['systems',root+'/systems-hour-t/duration-audit.json'],
 ['general',root+'/general-hour-t/duration-audit.json'],
 ['pressure',root+'/continuous-pressure-t/pressure-audit.json'],
 ['midpoint','docs/evidence/midpoint-pause-recording-v70.json']
]){
 const data=JSON.parse(await readFile(file,'utf8'));
 console.log(JSON.stringify({name,keys:Object.keys(data),summary:data.summary,resourceKeys:Object.keys(data.resources??{}),lastRowKeys:Object.keys(data.rows?.at(-1)??{})}));
}
