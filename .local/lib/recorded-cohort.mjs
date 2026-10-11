import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

// Discover completed recordings from their queue, without topic or round rules.
export async function recordedCohort(root,{requireTerminal=true}={}){
 const queueFile=path.join(root,'recording-queue.jsonl');
 const events=(await readFile(queueFile,'utf8')).replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse);
 if(requireTerminal)assert.equal(events.at(-1)?.event,'recordings_terminal','Measured recordings must finish first');
 const configuration=events.find(event=>event.event==='started');assert(configuration);
 const base=path.resolve(root),seen=new Set();
 const hours=events.filter(event=>event.event==='finished'&&event.kind==='elapsed_hour').map(event=>{
  assert.equal(typeof event.source,'string');
  const relative=path.relative(base,path.resolve(event.source));
  assert(relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative),'Recording source outside run directory');
  const file=path.resolve(event.source);assert(!seen.has(file),'Duplicate completed recording');seen.add(file);
  const start=events.slice(0,events.indexOf(event)).findLast(prior=>prior.event==='starting'&&prior.kind===event.kind&&prior.domain===event.domain);
  assert(start&&Number.isFinite(start.minutes)&&start.minutes>0);
  return {kind:event.kind,name:path.basename(path.dirname(file)),domain:event.domain,file,requestedDurationMs:start.minutes*60000};
 });
 assert(hours.length,'No completed hour recordings');
 return {queueFile,events,configuration,hours};
}
