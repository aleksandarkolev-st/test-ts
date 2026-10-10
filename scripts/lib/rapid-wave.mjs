import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function pcmData(wave) {
 assert(wave.length>=44&&wave.toString('ascii',0,4)==='RIFF'&&wave.toString('ascii',8,12)==='WAVE','Expected RIFF WAV');
 let format=null,pcm=null;
 for(let offset=12;offset+8<=wave.length;){
  const name=wave.toString('ascii',offset,offset+4),size=wave.readUInt32LE(offset+4),start=offset+8;
  assert(start+size<=wave.length,'Truncated WAV chunk');
  if(name==='fmt '){assert(size>=16);format={tag:wave.readUInt16LE(start),channels:wave.readUInt16LE(start+2),rate:wave.readUInt32LE(start+4),bytesPerSecond:wave.readUInt32LE(start+8),align:wave.readUInt16LE(start+12),bits:wave.readUInt16LE(start+14)};}
  if(name==='data'){assert(pcm===null,'Multiple PCM chunks are unsupported');pcm=wave.subarray(start,start+size);}
  offset=start+size+(size%2);
 }
 assert(format?.tag===1&&format.channels===1&&format.rate===16000&&format.bits===16&&format.align===2&&format.bytesPerSecond===32000,'Expected mono 16 kHz 16-bit PCM');
 assert(pcm?.length&&pcm.length%2===0,'Invalid PCM frame count');return pcm;
}
export function pcmWave(pcm) {
 const head=Buffer.alloc(44);head.write('RIFF');head.writeUInt32LE(pcm.length+36,4);head.write('WAVEfmt ',8);head.writeUInt32LE(16,16);head.writeUInt16LE(1,20);head.writeUInt16LE(1,22);head.writeUInt32LE(16000,24);head.writeUInt32LE(32000,28);head.writeUInt16LE(2,32);head.writeUInt16LE(16,34);head.write('data',36);head.writeUInt32LE(pcm.length,40);return Buffer.concat([head,pcm]);
}
export function composeBurst(waves,gapMs) {
 assert(Number.isFinite(gapMs)&&gapMs>=0);
 const gapSamples=Math.round(gapMs*16),parts=[],timeline=[];let position=0;
 for(const [i,wave] of waves.entries()){
  const pcm=pcmData(wave),samples=pcm.length/2;
  timeline.push({position:i+1,startSample:position,endSample:position+samples,startMs:position/16,endMs:(position+samples)/16});
  parts.push(pcm);position+=samples;
  if(i<waves.length-1){parts.push(Buffer.alloc(gapSamples*2));position+=gapSamples;}
 }
 return {wave:pcmWave(Buffer.concat(parts)),timeline,durationMs:position/16,gapSamples};
}
export async function prepareBurstAudio({root,output,index,questions,gapMs,runChild}) {
 const waves=[];
 for(const [i,question] of questions.entries()){
  const base=path.join(output,`burst-${index}-question-${i+1}`);
  await writeFile(`${base}.txt`,question,'utf8');
  await runChild('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/synthesize-interview-question.ps1'),'-TextPath',`${base}.txt`,'-OutputPath',`${base}.wav`],process.env);
  waves.push(await readFile(`${base}.wav`));
 }
 const composed=composeBurst(waves,gapMs),waveFile=path.join(output,`burst-${index}.wav`);
 await writeFile(waveFile,composed.wave);
 return {waveFile,sha256:createHash('sha256').update(composed.wave).digest('hex'),sourceTimeline:composed.timeline,durationMs:composed.durationMs,gapSamples:composed.gapSamples};
}
