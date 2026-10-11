import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';

// Bounded extraction avoids loading an interview's full observation history.
export async function extractRecordedRow(file,round){
 assert(Number.isSafeInteger(round)&&round>0);
 const marker=new RegExp('\\{\\s*"round"\\s*:\\s*'+round+'\\s*,\\s*"trial"\\s*:');
 let searching='',text='',depth=0,quoted=false,escaped=false,found=false,done=false;
 for await(const chunk of createReadStream(file,{encoding:'utf8',highWaterMark:65536})){
  let remaining=chunk;
  if(!found){searching+=chunk;const match=marker.exec(searching);if(!match){searching=searching.slice(-256);continue;}remaining=searching.slice(match.index);searching='';found=true;}
  for(const ch of remaining){
   text+=ch;assert(text.length<=8*1024*1024,'Recorded row exceeds extraction cap');
   if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}
   else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0){done=true;break;}
  }
  if(done)break;
 }
 assert(done,'No complete requested row found');
 const row=JSON.parse(text);assert.equal(row.round,round);
 return {row,text};
}
