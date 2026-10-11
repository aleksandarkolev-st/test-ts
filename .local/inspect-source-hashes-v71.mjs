import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import path from 'node:path';
for(const file of process.argv.slice(2)){
 const absolute=path.resolve(file);assert(absolute.startsWith(path.resolve('artifacts')+path.sep));
 let searching='',text='',found=false,quoted=false,escaped=false,depth=0,done=false;
 for await(const chunk of createReadStream(absolute,{encoding:'utf8',highWaterMark:65536})){
  let remaining=chunk;
  if(!found){searching+=chunk;const m=/"sourceHashes"\s*:\s*\{/.exec(searching);if(!m){searching=searching.slice(-256);continue;}remaining=searching.slice(m.index+m[0].lastIndexOf('{'));found=true;searching='';}
  for(const ch of remaining){text+=ch;assert(text.length<128*1024);if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0){done=true;break;}}
  if(done)break;
 }
 assert(done,'Source hash map not found in '+file);const sources=JSON.parse(text);
 console.log(JSON.stringify({file,sourceHashes:sources,scope:'Bounded streaming extraction of recorded source metadata; not a full journal integrity or clean-stop audit.'}));
}
