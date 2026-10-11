import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='artifacts/deep-interview-v70/hard-probes',findings=[];
for(const name of ['histogram-late-reversal','long-question-essential-tail','cuda-to-phantom-reads']){
 const raw=await readFile(`${root}/${name}/interview.json`),j=JSON.parse(raw);
 if(j.status!=='complete'||!j.stoppedCleanly)throw Error('Require clean terminal case');
 const row=j.rows.at(-1),id=row.responseVersion.split(':')[0],start=row.audio.playback.submitBeforeHostMs;
 const all=j.overlayPaintSamples.filter(p=>p.hostMs>=start),firstNew=all.find(p=>p.questionId===id)?.hostMs??null;
 const visible=all.filter(p=>p.recorderVersion===2&&p.visible);
 const text=p=>p.text.slice(p.visibleStart,p.visibleEnd);
 const otherBefore=visible.filter(p=>p.questionId!==id&&(firstNew===null||p.hostMs<firstNew));
 const otherAfter=visible.filter(p=>p.questionId!==id&&firstNew!==null&&p.hostMs>=firstNew);
 const current=visible.filter(p=>p.questionId===id);
 const obsolete=name==='cuda-to-phantom-reads'?/\bCUDA\b|\bGPU\b|__shfl|\bwarp\b|coalesc/iu:
  name==='histogram-late-reversal'?/\batomic(?:Add|Sub|Exch|CAS|Min|Max|Inc|Dec|And|Or|Xor)\s*\(/u:null;
 findings.push({name,journalSha256:createHash('sha256').update(raw).digest('hex'),
  questionId:id,sourceSubmitHostMs:start,firstNewQuestionTagHostMs:firstNew,
  visibleSamplesOfOtherQuestionBeforeNewTag:otherBefore.length,
  visibleSamplesOfOtherQuestionAfterNewTag:otherAfter.length,
  obsoleteTopicOrAtomicCallInCurrentVisibleSamples:obsolete?current.filter(p=>obsolete.test(text(p))).length:null,
  currentQuestionVisibleSamples:current.length,
  actualOtherAnswerStreamingAtLaunch:row.audio.runningAtPlaybackLaunch,
  waveformEvidence:row.audio.waveformEvidence,
  answerSha256:createHash('sha256').update(row.answer).digest('hex')});
}
const report={recordedAt:new Date().toISOString(),findings,
 scope:'Recorded overlay viewport samples only. Other-question visibility before and after the new question tag are counted separately. Topic/atomic regex checks are selective evidence, not general semantic correctness or continuous-pressure certification. Source submission is not acoustic speech onset. Original SSML recordings contain natural voice silence in addition to the requested pause; exact 1500 ms PCM variants are queued separately.'};
await writeFile('artifacts/deep-interview-v70/hard-visible-audit.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(report));
