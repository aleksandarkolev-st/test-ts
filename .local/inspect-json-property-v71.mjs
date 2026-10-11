import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const [file,property,output]=process.argv.slice(2);assert(/^[a-zA-Z][a-zA-Z0-9]*$/.test(property));
const absolute=path.resolve(file);assert(absolute.startsWith(path.resolve('artifacts/deep-interview-v71')+path.sep));
const marker=new RegExp('"'+property+'"\\s*:\\s*[\\[{]');
let searching='',text='',found=false,quoted=false,escaped=false,depth=0,done=false;
for await(const chunk of createReadStream(absolute,{encoding:'utf8',highWaterMark:65536})){
 let remaining=chunk;
 if(!found){searching+=chunk;const m=marker.exec(searching);if(!m){searching=searching.slice(-256);continue;}remaining=searching.slice(m.index+m[0].length-1);found=true;searching='';}
 for(const ch of remaining){text+=ch;assert(text.length<8*1024*1024,'Bounded property cap exceeded');if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==='{'||ch==='[')depth++;else if((ch==='}'||ch===']')&&--depth===0){done=true;break;}}
 if(done)break;
}
assert(done,'Complete requested property not found');const value=JSON.parse(text);
if(output){assert(path.resolve(output).startsWith(path.resolve('artifacts/deep-interview-v71')+path.sep));await writeFile(output,JSON.stringify({file,property,value,scope:'Bounded streaming property extraction. The source journal must be checked separately for clean completion and full integrity.'},null,2),{flag:'wx'});}
const final=Array.isArray(value)?value.at(-1):value;
console.log(JSON.stringify({file,property,entries:Array.isArray(value)?value.length:null,final}));
