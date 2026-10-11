// Public synthetic fixtures and source-bound factorial controls. These data
// never enter production routing or provide an answer/ASR substitution.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {exactPauseWave} from './lib/exact-pause-wave.mjs';
const root=process.cwd(),out=path.resolve(process.argv[2]??'artifacts/controller-v72/prepared');
assert(out.startsWith(root+path.sep));await mkdir(out,{recursive:true});
const sha=x=>createHash('sha256').update(x).digest('hex'),relative=x=>path.relative(root,x).replaceAll('\\','/');
const base={model:'gpt-6.1-sol',effort:'low',objective:'detailed',serviceTier:null};
const save=(name,plan)=>writeFile(path.join(out,`${name}.json`),JSON.stringify(plan,null,2)+'\n');
const hourBytes=await readFile('tests/fixtures/controller-hour-session.json');
await save('hour-session',{...JSON.parse(hourBytes),sourceFixtureSha256:sha(hourBytes)});
for(const name of ['contextual-session','reasoning-probes']){
 const bytes=await readFile(`tests/fixtures/controller-${name}.json`);await save(name,{...JSON.parse(bytes),sourceFixtureSha256:sha(bytes)});
}
const synth=async(name,text)=>{
 const stem=path.join(out,name);await writeFile(stem+'.txt',text);
 await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-File',path.resolve('scripts/synthesize-interview-question.ps1'),'-TextPath',stem+'.txt','-OutputPath',stem+'.wav'],{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',x=>error+=x);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(error)));});
 const wave=await readFile(stem+'.wav');return {wave,waveFile:relative(stem+'.wav'),waveSha256:sha(wave)};
};
const publicParts={
 'multipart-prefix':'For exactly ten thousand elements and one hundred ninety two threads per block, compute the minimum number of blocks needed to cover every element.',
 'multipart-tail':'Also report the active threads in the final block and the number of launched threads that need a bounds check. Explain the arithmetic.',
 'correction-prefix':'The guard is x less than negative one. What does the function return at negative one?',
 'correction-tail':'Correction, I said less than or equal to negative one. Return seventeen on the true branch and nineteen otherwise. Evaluate negative one using the corrected operator.',
 'backchannel':'Okay, I see.',
 'why':'Why?',
 'what-if':'What if that changes?'
};
const waves={};for(const [name,text] of Object.entries(publicParts))waves[name]=await synth(name,text);
const edge=[];
for(const [name,prefix,tail,pauseMs] of [['multipart-pause-1500','multipart-prefix','multipart-tail',1500],['late-correction-2500','correction-prefix','correction-tail',2500]]){
 const composed=exactPauseWave(waves[prefix].wave,waves[tail].wave,pauseMs),file=path.join(out,name+'.wav');await writeFile(file,composed.wave);
 edge.push({name,question:publicParts[prefix]+' '+publicParts[tail],waveFile:relative(file),waveSha256:sha(composed.wave),pauseEvidence:composed.evidence});
}
edge.push({name:'backchannel',question:publicParts.backchannel,waveFile:waves.backchannel.waveFile,waveSha256:waves.backchannel.waveSha256,expectedReply:false});
edge.push({name:'spoken-why',question:'Why?',waveFile:waves.why.waveFile,waveSha256:waves.why.waveSha256,ordinaryFollowup:true});
edge.push({name:'interrupt-code',question:'Implement a complete C++17 bounded FIFO of capacity 17 with overflow rejection, push, pop, and a test main that fills, overflows, drains, and wraps around. Explain the invariant before writing the code.',settle:false});
edge.push({name:'spoken-why-during-output',question:'Why?',waveFile:waves.why.waveFile,waveSha256:waves.why.waveSha256,ordinaryFollowup:true,afterDisplayed:true});
edge.push({name:'switch-topic',question:'Switch topics. Why does snapshot isolation permit write skew even if both read-check-write sequences run in atomic transactions?',ordinaryFollowup:true});
await save('meeting-behavior',{...base,turns:edge});
// Use recognized speech, rather than generated answers, from a real recorded
// 60-minute source session. Its native timestamps define prefix duration.
const sourceFile='artifacts/deep-interview-v71/general-hour-t/interview.json',sourceBytes=await readFile(sourceFile),source=JSON.parse(sourceBytes);
assert(source.status==='complete'&&source.actualInterviewDurationMs>=3600000);
const transcript=source.rows.flatMap(r=>r.events??[]).filter(e=>e.name==='transcript'&&e.payload.final).map(e=>e.payload);
const immediate='REMOTE: Explain CUDA warps.\nDISPLAYED COPILOT SUGGESTION (not actual speech): A warp contains 32 threads. Threads taking different branches execute paths with only the relevant lanes active.';
for(const minutes of [0,10,30,60]){
 const latest=new Map();for(const s of transcript.filter(s=>s.endedAt<=minutes*60000))latest.set(s.source+':'+s.id,s);
 const prefix=[...latest.values()].sort((a,b)=>a.startedAt-b.startedAt).map(s=>`${s.source.toUpperCase()} [${s.startedAt}..${s.endedAt}]: ${s.text}`).join('\n');
 const context=prefix+'\n'+immediate;assert(context.length<160000,'Debug frozen-context limit; do not silently truncate source');
 const sourceBinding={journal:sourceFile,journalSha256:sha(sourceBytes),prefixNativeEndMs:minutes*60000,finalizedSegments:latest.size,contextSha256:sha(context)};
 await save(`history-${minutes}`,{...base,turns:[{name:`history-${minutes}-typed`,question:'Why?',ordinaryFollowup:true,fixedContext:context,sourceBinding},
  {name:`history-${minutes}-audio`,question:'Why?',ordinaryFollowup:true,fixedContext:context,waveFile:waves.why.waveFile,waveSha256:waves.why.waveSha256,sourceBinding}]});
}
const fixedContext='REMOTE: The team explicitly decided to launch on February 19, 2027. The reason is the signed customer deadline.';
await save('fixed-age-fresh',{...base,turns:[{name:'fixed-age-fresh',question:'What is the launch date and why must the replay preserve it?',fixedContext}]});
for(const objective of ['brief','detailed']){
 const turns=[];for(let i=0;i<10;i++)turns.push({name:`${objective}-why-${i+1}`,question:'Why?',ordinaryFollowup:true,fixedContext:immediate});
 await save(`objective-${objective}`,{...base,objective,turns});
}
console.log(`Prepared source-bound audio/text controls in ${relative(out)}. No measured run or correctness claim is made by preparation.`);
