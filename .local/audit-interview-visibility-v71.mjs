import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const directory=process.argv[2];assert(directory,'RECORDING_DIRECTORY');
const root=path.resolve(directory),workspace=process.cwd();assert(root.startsWith(workspace+path.sep));
const bytes=await readFile(path.join(root,'interview.json')),journal=JSON.parse(bytes);
assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);
const digest=value=>createHash('sha256').update(value).digest('hex');
const paints=(journal.overlayPaintSamples??[]).slice().sort((a,b)=>a.hostMs-b.hostMs);
const observations=journal.deepObservations??[],jobs=new Map();
for(const observation of observations)for(const job of observation.jobs??[])jobs.set(job.question.id,job);
const events=[...new Map(journal.rows.flatMap(row=>row.events??[]).map(event=>[JSON.stringify(event),event])).values()]
 .filter(event=>['question.confirmed','question.ignored'].includes(event.name)&&Number.isFinite(event.payload?.timestamp))
 .sort((a,b)=>a.payload.timestamp-b.payload.timestamp);
const stop=[...observations.map(record=>record.hostAfterMs),...paints.map(paint=>paint.hostMs)]
 .reduce((latest,value)=>Number.isFinite(value)?Math.max(latest,value):latest,0);
const verifiedPaintSamples=paints.filter(paint=>paint.recorderVersion===2&&Number.isFinite(paint.hostMs)&&
 Number.isFinite(paint.visibleStart)&&Number.isFinite(paint.visibleEnd));
const windows=journal.rows.map(row=>{
 const id=row.responseVersion?.split(':')[0]??null,confirmed=row.latency?.questionConfirmedAt??row.latency?.pipeline?.questionConfirmed;
 const anchors=row.audio?.clockAnchors??[];
 const offsetLow=Math.max(...anchors.map(anchor=>anchor.nativeMs-anchor.hostAfterMs));
 const offsetHigh=Math.min(...anchors.map(anchor=>anchor.nativeMs-anchor.hostBeforeMs));
 const calibrated=anchors.length>0&&Number.isFinite(offsetLow)&&Number.isFinite(offsetHigh)&&offsetLow<=offsetHigh;
 const common={round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,
  sourceQuestionSha256:digest(row.question??''),responseVersion:row.responseVersion??null,
  finalRecordedPhase:row.phase,error:row.error??null,cancelled:row.cancelled??false};
 if(!id||!Number.isFinite(confirmed)||!calibrated||!verifiedPaintSamples.length)return {...common,measured:false,
  missingReason:!id?'no_native_question_assigned':!Number.isFinite(confirmed)?'no_confirmation_timestamp':!calibrated?'clock_anchors_inconsistent':'viewport_visibility_unverified',intervals:[]};
 const confirmationHostMs={low:confirmed-offsetHigh,high:confirmed-offsetLow};
 const next=events.find(event=>event.payload.timestamp>confirmed&&
  ((event.name==='question.confirmed'&&event.payload.id!==id)||(event.name==='question.ignored'&&event.payload.id===id)));
 const end=Math.min(stop,next?next.payload.timestamp-offsetHigh:stop);
 const intervals=paints.flatMap((paint,index)=>{
  const start=Math.max(confirmationHostMs.high,paint.hostMs),finish=Math.min(end,paints[index+1]?.hostMs??stop);
  if(finish<=start||paint.recorderVersion!==2||!paint.visible||!Number.isFinite(paint.visibleStart)||!Number.isFinite(paint.visibleEnd)||paint.visibleEnd<=paint.visibleStart||!paint.questionId||paint.questionId===id)return [];
  const shown=jobs.get(paint.questionId),wanted=jobs.get(id);
  return [{startHostMs:start,endHostMs:finish,durationMs:finish-start,shownQuestionId:paint.questionId,shownRevision:paint.revision,
   sourceOrder:shown&&wanted?(shown.question.detectedAt<wanted.question.detectedAt?'earlier_native_job':'later_or_equal_native_job'):'unbound_native_job',
   visibleText:paint.text.slice(paint.visibleStart,paint.visibleEnd)}];
 });
 return {...common,measured:true,confirmationHostMs,endHostMs:end,intervals,
  differentQuestionVisibleMs:intervals.reduce((sum,interval)=>sum+interval.durationMs,0)};
});
const measured=windows.filter(window=>window.measured),report={recordedAt:new Date().toISOString(),
 journal:{file:path.join(directory,'interview.json'),sha256:digest(bytes)},
 collectorSha256:digest(await readFile(new URL(import.meta.url))),model:journal.model,effort:journal.effort,outputDevice:journal.outputDevice,
 summary:{recordedRows:windows.length,measuredConfirmationWindows:measured.length,
  missingWindows:windows.length-measured.length,windowsWithDifferentQuestionVisible:measured.filter(window=>window.intervals.length).length,
  differentQuestionVisibleMs:measured.reduce((sum,window)=>sum+window.differentQuestionVisibleMs,0),
  verifiedPaintSamples:verifiedPaintSamples.length,
  maxPerWindowMs:measured.reduce((max,window)=>Math.max(max,window.differentQuestionVisibleMs),0)},windows,
 semanticAssessmentPending:true,goalComplete:false,
 scope:'Actual different-question visibility after each recorded row final confirmation, bounded by a later distinct native confirmation, ignore event, or final observation. Paints are held until the next observed paint; narrow conservative clock bounds reduce boundary ambiguity. Missing native jobs and inconsistent clocks remain explicit. Row windows can overlap when rows share a native job, so totals are not a union of wall-clock exposure. Same-ID clause refinements and semantic appropriateness require separate review; different IDs alone do not prove a stale or incorrect answer. No topic, expected-answer, or threshold rule controls production.'};
await writeFile(path.join(root,'interview-visibility-audit-v71.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file:path.join(root,'interview-visibility-audit-v71.json'),summary:report.summary}));
