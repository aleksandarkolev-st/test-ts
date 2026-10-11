import assert from 'node:assert/strict';
import {pcmData,pcmWave} from './rapid-wave.mjs';

export function exactPauseWave(prefixWave,tailWave,pauseMs){
 assert(Number.isInteger(pauseMs)&&pauseMs>0&&pauseMs<=10000);
 const prefix=pcmData(prefixWave),tail=pcmData(tailWave);
 let prefixFrames=prefix.length/2,tailStart=0;
 while(prefixFrames>0&&prefix.readInt16LE((prefixFrames-1)*2)===0)prefixFrames--;
 while(tailStart<tail.length/2&&tail.readInt16LE(tailStart*2)===0)tailStart++;
 assert(prefixFrames>0&&tailStart<tail.length/2,'Pause must join two voiced pieces');
 const pauseFrames=pauseMs*16;
 return {wave:pcmWave(Buffer.concat([prefix.subarray(0,prefixFrames*2),Buffer.alloc(pauseFrames*2),tail.subarray(tailStart*2)])),
  evidence:{kind:'exact_pcm_gap',pauseFrames,pauseMs,pauseStartFrame:prefixFrames,pauseEndFrame:prefixFrames+pauseFrames,
   removedPrefixTrailingZeroFrames:prefix.length/2-prefixFrames,removedTailLeadingZeroFrames:tailStart,
   scope:'Exact digital zero gap between separately synthesized public question pieces. Only natural leading/trailing exact zero frames at the join are trimmed; voiced samples are preserved.'}};
}
