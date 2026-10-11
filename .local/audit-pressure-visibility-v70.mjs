import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const directory='artifacts/deep-interview-v70/continuous-pressure-t';
const bytes=await readFile(`${directory}/interview.json`),journal=JSON.parse(bytes),pressure=journal.continuousPressure;
assert(['complete','failed'].includes(journal.status));
const eventAudit=JSON.parse(await readFile(`${directory}/pressure-events-audit.json`));
assert.equal(eventAudit.journalSha256,createHash('sha256').update(bytes).digest('hex'));assert(eventAudit.clocksValid);
const jobs=new Map(pressure.nativeJobs.map(job=>[job.question.id,job]));
const hostBounds=native=>({low:native-eventAudit.clockOffsetMs.high,high:native-eventAudit.clockOffsetMs.low});
const changes=[];let current=null;
for(const event of eventAudit.lifecycleEvents){
 const {id,timestamp}=event.payload??{};
 if(event.name==='question.confirmed'&&jobs.has(id)&&id!==current){current=id;changes.push({id,at:hostBounds(timestamp),eventIndex:event.eventIndex});}
 if(event.name==='question.ignored'&&id===current){current=null;changes.push({id:null,at:hostBounds(timestamp),eventIndex:event.eventIndex});}
}
const paints=(journal.overlayPaintSamples??[]).slice().sort((a,b)=>a.hostMs-b.hostMs);
const stop=pressure.clockAnchors.at(-1).hostBeforeMs;
const windows=changes.flatMap((change,index)=>{
 if(!change.id)return [];
 const next=changes[index+1],end=next?.at.low??stop;
 const intervals=paints.flatMap((paint,i)=>{
  const start=Math.max(change.at.high,paint.hostMs),finish=Math.min(end,paints[i+1]?.hostMs??stop);
  if(finish<=start||!paint.visible||paint.visibleEnd<=paint.visibleStart||!paint.questionId||paint.questionId===change.id)return [];
  const shown=jobs.get(paint.questionId),wanted=jobs.get(change.id);
  return [{startHostMs:start,endHostMs:finish,durationMs:finish-start,shownQuestionId:paint.questionId,shownRevision:paint.revision,
   sourceOrder:shown&&wanted?(shown.question.detectedAt<wanted.question.detectedAt?'earlier_native_job':'later_or_equal_native_job'):'unbound_native_job',
   visibleText:paint.text.slice(paint.visibleStart,paint.visibleEnd)}];
 });
 return [{confirmedQuestionId:change.id,recognizedQuestion:jobs.get(change.id).question.text,
  confirmationHostMs:change.at,endHostMs:end,intervals,
  differentQuestionVisibleMs:intervals.reduce((total,item)=>total+item.durationMs,0)}];
});
const report={recordedAt:new Date().toISOString(),journalSha256:eventAudit.journalSha256,eventsSha256:eventAudit.eventsSha256,
 model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 summary:{differentConfirmedNativeQuestionWindows:windows.length,windowsWithDifferentQuestionVisible:windows.filter(w=>w.intervals.length).length,
  differentQuestionVisibleMs:windows.reduce((sum,w)=>sum+w.differentQuestionVisibleMs,0),maxPerWindowMs:Math.max(0,...windows.map(w=>w.differentQuestionVisibleMs))},
 windows,semanticAssessmentPending:true,
 scope:'Observable different-question visibility after the latest distinct native job confirmation, ending at its replacement, ignore event, or playback-end clock anchor. Same-ID clause refinements are excluded. Duration treats each paint as held until the next observed paint; strict confirmation upper and next-confirmation lower bounds reduce clock-boundary ambiguity. Earlier/later job order is native detection order. These intervals require semantic review before classifying inappropriate stale answers; this does not assume each source utterance creates one native job.'};
await writeFile(`${directory}/pressure-visibility-audit.json`,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({...report,windows:undefined}));
