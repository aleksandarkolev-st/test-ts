import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {streamedWordLatency,latencyDistribution} from '../scripts/lib/streamed-word-latency.mjs';
const base='artifacts/deep-interview-v69',out='artifacts/deep-interview-v70';
await mkdir(out,{recursive:true});
const records=[];
for(const directory of await readdir(base,{withFileTypes:true})){
 if(!directory.isDirectory())continue;
 const file=`${base}/${directory.name}/interview.json`;
 let bytes;try{bytes=await readFile(file);}catch{continue;}
 const j=JSON.parse(bytes),rows=j.rows.map(row=>({round:row.round,question:row.question,recognizedQuestion:row.recognizedQuestion,
  answer:row.answer,phase:row.phase,error:row.error,cancelled:row.cancelled,review:row.review??row.provisionalReview?.review,
  partialGrade:!!(row.provisionalReview&&!row.review),...streamedWordLatency(j,row)}));
 const record={file,sha256:createHash('sha256').update(bytes).digest('hex'),status:j.status,stoppedCleanly:j.stoppedCleanly,
  failure:j.failure,capture:j.speechConfiguration,rows,firstVisibleWordMs:latencyDistribution(rows.map(r=>r.firstVisibleStreamedWord?.latencyMs.high)),
  interruptedEvidence:j.status==='in_progress'?{observedAt:new Date().toISOString(),
   observation:'Win32_Process inspection found no native-signed-interview runner, meeting-copilot app, or adaptive-interview examiner. Original journal preserved unchanged; shutdown and unrecorded ninth round cannot be certified.'}:null};
 records.push(record);
 console.log(JSON.stringify({directory:directory.name,status:j.status,rows:rows.length,firstVisibleWordMs:record.firstVisibleWordMs}));
 await writeFile(`${out}/${directory.name}-readable.json`,JSON.stringify(record,null,2),{flag:'wx'});
}
await writeFile(`${out}/prior-runs-audit.json`,JSON.stringify({recordedAt:new Date().toISOString(),records},null,2),{flag:'wx'});
