import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [directory,roundArgument,output]=process.argv.slice(2),round=Number(roundArgument);
assert(Number.isSafeInteger(round)&&round>0);
const file=path.resolve(directory,'interview.json');assert(file.startsWith(path.resolve('artifacts/deep-interview-v71')+path.sep));
const marker=new RegExp('\\{\\s*"round"\\s*:\\s*'+round+'\\s*,\\s*"trial"\\s*:');
let searching='',text='',depth=0,quoted=false,escaped=false,found=false,done=false;
const stream=createReadStream(file,{encoding:'utf8',highWaterMark:65536});
for await(const chunk of stream){
 let remaining=chunk;
 if(!found){searching+=chunk;const match=marker.exec(searching);if(!match){searching=searching.slice(-256);continue;}remaining=searching.slice(match.index);searching='';found=true;}
 for(const ch of remaining){
  text+=ch;assert(text.length<=8*1024*1024,'Bounded row extraction exceeded cap');
  if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}
  else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0){done=true;break;}
 }
 if(done)break;
}
assert(done,'No complete requested row found; the live journal may be between writes');
const row=JSON.parse(text);assert.equal(row.round,round);
const id=row.responseVersion?.split(':')[0],p=row.latency?.pipeline??{},sha=x=>createHash('sha256').update(x).digest('hex');
const report={recordedAt:new Date().toISOString(),file,liveFileMetadata:await stat(file).then(s=>({bytes:s.size,modifiedAt:s.mtime.toISOString()})),
 rowSnapshotSha256:sha(text),round,question:row.question,sourceQuestionSha256:sha(row.question),recognizedQuestion:row.recognizedQuestion,
 responseVersion:row.responseVersion,answer:row.answer,phase:row.phase,error:row.error,cancelled:row.cancelled,
 pipeline:p,latency:row.latency,audioClockAnchors:row.audio?.clockAnchors,audioPlayback:row.audio?.playback,
 firstStreamedWordMeasurement:row.firstStreamedWordMeasurement,
 frameEvents:(row.events??[]).filter(e=>['answer.provisional_prefix','answer.frame_received','question.confirmed','answer.revision'].includes(e.name)&&(!id||e.payload?.id===id)),
 scope:'Bounded read-only extraction of one row from a live mutable journal. Row snapshot is preserved; final answers, revisions and source binding require the completed journal. Missing fields remain unmeasured.'};
if(output){assert(path.resolve(output).startsWith(path.resolve('docs/evidence')+path.sep));await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});}
console.log(JSON.stringify({...report,frameEvents:undefined,frameEventCount:report.frameEvents.length}));
