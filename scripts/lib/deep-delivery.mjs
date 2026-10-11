import assert from 'node:assert/strict';
import {pcmData} from './rapid-wave.mjs';

// Explicit evaluation delivery only. No production question/content routing.
export function explicitContextProbe(delivery,nextRound,fallback){
 if(delivery.immediateAfterRounds===undefined)return fallback;
 const text=delivery.immediateAfterRounds[String(nextRound-1)]??null;
 assert(text===null||(typeof text==='string'&&text.trim()&&text.length<=12000),'Invalid public switch question');
 return text;
}

export function questionPause(question,round,delivery,defaultPause){
 const marker=round===1?delivery.initialPauseBeforeText:null;
 if(marker){
  const split=question.indexOf(marker);
  assert(split>0,'Initial pause marker must occur after the start of the public question');
  const pauseMs=delivery.pauseMs??1500;
  assert(Number.isInteger(pauseMs)&&pauseMs>0&&pauseMs<=10000);
  return {split,pauseMs,kind:'explicit_public_question_pause'};
 }
 const split=defaultPause?question.indexOf(' ',Math.floor(question.length*.55)):0;
 return {split,pauseMs:1500,kind:split>0?'repeated_mid_question_pause':'no_inserted_pause'};
}

export function waveformEvidence(wave,pause,delivery={}){
 const pcm=pcmData(wave),frames=pcm.length/2;
 let first=-1,last=-1,zeroStart=-1,longest=null;
 for(let i=0;i<frames;i++){
  if(pcm.readInt16LE(i*2)!==0){
   if(first<0)first=i;
   if(zeroStart>=0&&last>=0){
    const span={startFrame:zeroStart,endFrame:i,durationMs:(i-zeroStart)/16};
    if(!longest||span.durationMs>longest.durationMs)longest=span;
   }
   last=i;zeroStart=-1;
  }else if(zeroStart<0)zeroStart=i;
 }
 const durationMs=frames/16,target=delivery.targetSpeechDurationMs??null;
 return {sampleRate:16000,sourceFrames:frames,sourceDurationMs:durationMs,firstNonzeroFrame:first,lastNonzeroFrame:last,
  longestInternalExactZeroSpan:longest,requestedPause:pause,
  sourceDurationMinusRequestedPauseMs:durationMs-(pause.split>0?pause.pauseMs:0),
  targetSpeechDurationMs:target,targetDurationWithinTolerance:target===null?null:
   Math.abs(durationMs-(pause.split>0?pause.pauseMs:0)-target)<=(delivery.durationToleranceMs??5000),
  scope:'Digital PCM waveform evidence. Exact zero frames and requested SSML pause are not acoustic-room or semantic-completeness measurements.'};
}
