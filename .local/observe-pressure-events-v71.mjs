import assert from 'node:assert/strict';
import {open,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {connectNativePages} from '../scripts/lib/native-cdp.mjs';
const directory=process.argv[2]??'artifacts/deep-interview-v71/continuous-pressure-t';
assert(/^artifacts\/deep-interview-v71\/continuous-pressure-[a-z0-9-]+$/.test(directory));
let journal;
const startDeadline=Date.now()+240000;
while(!journal?.nativeProcessId){
 assert(Date.now()<startDeadline,'Measured pressure session did not start; do not invent capture');
 try{journal=JSON.parse(await readFile(`${directory}/interview.json`));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
 if(journal?.status==='failed')throw Error('Measured pressure session failed before event capture');
 if(!journal?.nativeProcessId)await new Promise(resolve=>setTimeout(resolve,100));
}
assert.equal(journal.status,'in_progress');
const ownerPid=journal.nativeProcessId;
const output=await open(`${directory}/native-events-observer.jsonl`,'wx');
const report={startedAt:new Date().toISOString(),ownerPid,port:9239,readOnly:true,events:0,records:0,
 scope:'Read-only additional recording of the existing nativeInterviewEvents array. Initial read includes earlier events retained since app startup. Final transcripts, ASR raw final boundaries, speech and question/answer lifecycle events are retained; high-volume partial transcripts and provisional answer prefixes are excluded. This is not a second interview or model request.'};
await output.write(JSON.stringify({kind:'header',...report})+'\n');
let connection,offset=0,lastSuccessfulHostMs=null,reason=null;
try{
 connection=await connectNativePages(report.port);
 while(true){
  try{process.kill(ownerPid,0);}catch{reason='native_owner_exited';break;}
  const hostBeforeMs=Date.now();
  const captured=await connection.main.evaluate(offset=>{
   const all=window.nativeInterviewEvents;
   if(!Array.isArray(all))throw Error('Native event array unavailable');
   return {total:all.length,events:all.slice(offset).flatMap((event,i)=>{
    if(event.name==='answer.provisional_prefix'||event.name==='question.candidate'||event.name==='asr.candidate_observed')return [];
    if(event.name==='transcript'&&!event.payload?.final)return [];
    if(event.name==='asr.raw_boundary'&&!event.payload?.final)return [];
    return [{eventIndex:offset+i,...event}];
   })};
  },offset);
  const hostAfterMs=Date.now();
  assert(captured.total>=offset,'Event array was reset; do not silently skip capture');
  if(captured.events.length){
   await output.write(JSON.stringify({kind:'events',hostBeforeMs,hostAfterMs,fromIndex:offset,throughIndex:captured.total,events:captured.events})+'\n');
   report.events+=captured.events.length;report.records++;
  }
  offset=captured.total;lastSuccessfulHostMs=hostAfterMs;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
}catch(error){
 reason=String(error);
 try{process.kill(ownerPid,0);report.ownerLiveAtFailure=true;}catch{report.ownerLiveAtFailure=false;}
}finally{
 connection?.close();await output.close();
 Object.assign(report,{completedAt:new Date().toISOString(),throughNativeEventIndex:offset,lastSuccessfulHostMs,stopReason:reason});
 report.eventsFileSha256=createHash('sha256').update(await readFile(`${directory}/native-events-observer.jsonl`)).digest('hex');
 await writeFile(`${directory}/native-events-observer-report.json`,JSON.stringify(report,null,2),{flag:'wx'});
 console.log(JSON.stringify(report));
}
