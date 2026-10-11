import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base='artifacts/deep-interview-v70/hard-probes/cuda-to-phantom-reads';
const raw=await readFile(base+'/interview.json'),j=JSON.parse(raw),row=j.rows[1];
const id=row.responseVersion.split(':')[0],anchors=row.audio.clockAnchors;
const low=Math.max(...anchors.map(a=>a.nativeMs-a.hostAfterMs)),high=Math.min(...anchors.map(a=>a.nativeMs-a.hostBeforeMs));
if(low>high)throw Error('Clock intervals do not intersect');
const confirmed={low:row.latency.questionConfirmedAt-high,high:row.latency.questionConfirmedAt-low};
const samples=j.overlayPaintSamples.toSorted((a,b)=>a.hostMs-b.hostMs),firstNew=samples.find(p=>p.questionId===id)?.hostMs;
if(!firstNew)throw Error('New question never observed');
const durationAfter=cutoff=>samples.reduce((duration,p,index)=>{
 const end=Math.min(samples[index+1]?.hostMs??firstNew,firstNew);
 if(p.questionId===id||!p.visible||p.recorderVersion!==2||end<=cutoff)return duration;
 return duration+Math.max(0,end-Math.max(p.hostMs,cutoff));
},0);
const intervals=samples.flatMap((p,index)=>{
 const end=Math.min(samples[index+1]?.hostMs??firstNew,firstNew);
 return p.questionId!==id&&p.visible&&p.recorderVersion===2&&end>confirmed.high?
  [{questionId:p.questionId,startHostMs:Math.max(p.hostMs,confirmed.high),endHostMs:end,
    visibleText:p.text.slice(p.visibleStart,p.visibleEnd)}]:[];
});
const report={recordedAt:new Date().toISOString(),journalSha256:createHash('sha256').update(raw).digest('hex'),
 newQuestionId:id,nativeConfirmationHostIntervalMs:confirmed,firstNewQuestionTagHostMs:firstNew,
 previousAnswerVisibilityAfterNewConfirmationMs:{low:durationAfter(confirmed.high),high:durationAfter(confirmed.low)},
 stalePreviousAnswerObservedAfterNewQuestionConfirmed:intervals.length>0,intervals,
 newAnswerIncludesCudaTerms:/\bCUDA\b|\bGPU\b|__shfl|\bwarp\b|coalesc/iu.test(row.answer),
 actualStreamingOverlap:row.audio.runningAtPlaybackLaunch,
 scope:'Conservative host/native calibration and recorded viewport states carried until the next observed paint change. This measures retained previous-answer visibility after the new question was confirmed, separately from contamination of the new answer. It does not assert continuous OS-level unobstructed visibility or human-room timing.'};
await writeFile(base+'/confirmation-visibility-audit.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({...report,intervals:report.intervals.map(p=>({...p,visibleText:p.visibleText.slice(0,100)}))}));
