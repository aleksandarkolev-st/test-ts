// File-only review export. Every verdict must already be manually bound to bytes.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {jobsAtObservation} from './lib/deep-observations.mjs';
import {measureJournal} from './lib/controller-measurements.mjs';
const [backend,notesFile,output]=process.argv.slice(2);
assert(['codex','chatgpt'].includes(backend)&&notesFile&&output);
const sha=x=>createHash('sha256').update(x).digest('hex');
const queueFile='artifacts/controller-v73/reliability-controls-r1/verification.json';
const qb=await readFile(queueFile),queue=JSON.parse(qb);
const task=queue.tasks.find(t=>t.backend===backend&&t.label==='idle-hour');
assert(task?.status==='complete','The actual hour must finish before this export');
const jb=await readFile(task.journalFile),j=JSON.parse(jb);
assert.equal(sha(jb),task.journalSha256);
assert(j.status==='complete'&&j.stoppedCleanly&&j.actualInterviewDurationMs>=3600000);
assert.equal(j.rows.length,6);
assert(j.rows[3].applicationAgeMs>=3600000);
const mb=await readFile(task.manifest),manifest=JSON.parse(mb);
assert.equal(sha(mb),task.manifestSha256);assert.equal(j.manifestSha256,sha(mb));
const nb=await readFile(notesFile),manual=JSON.parse(nb);
assert.equal(manual.rows.length,6);
const jobs=jobsAtObservation(j.deepObservations,j.deepObservations.length-1);
const rows=j.rows.map(r=>{
 const n=manual.rows.find(n=>n.round===r.round);assert(n?.note&&n.answerSha256);
 const a=jobs.find(a=>a.question.id===r.responseVersion?.split(':')[0])??r;
 assert.equal(sha(a.answer),n.answerSha256,'Review actual original response bytes');
 assert.equal(r.selectedContext,manifest.turns[r.round-1].fixedContext);
 assert.equal(r.question,manifest.turns[r.round-1].question);
 assert(['correct','incorrect','incomplete','missing'].includes(n.correctness));
 if(n.completed)assert(a.phase==='complete'&&!a.error);
 if(n.correctness==='missing')assert.equal(a.answer,'');
 return {...n,name:r.name,question:r.question,answer:a.answer,generationId:a.question?.id??null,
  phase:a.phase,error:a.error??null,applicationAgeMs:r.applicationAgeMs,
  contextSha256:sha(r.selectedContext),...(n.useEntireActualAnswer?{usefulPrefix:a.answer}:{})};
});
assert.equal(new Set(rows.map(r=>r.contextSha256)).size,1);
const directory=`artifacts/controller-v73/reviews/reliability-${backend}-idle-age-final`;
await mkdir(directory);await writeFile(directory+'/journal.json',jb,{flag:'wx'});
await writeFile(directory+'/manual-notes.json',nb,{flag:'wx'});
await writeFile(directory+'/queue-snapshot.json',qb,{flag:'wx'});
const measurements=measureJournal(j,{rows});
const phase=r=>measurements.rows.filter(x=>r==='fresh'?x.round<=3:x.round>3);
const result={schemaVersion:1,evaluationKind:'authenticated_actual_elapsed_hour_fixed_context_control',
 recordedAt:new Date().toISOString(),completedCapture:true,reviewedRows:6,backend,
 model:j.model,effort:j.effort,outputDevice:j.outputDevice,nativeBinarySha256:j.nativeBinarySha256,
 journal:{file:directory+'/journal.json',sha256:sha(jb),originalFile:task.journalFile,
  status:j.status,stoppedCleanly:j.stoppedCleanly,actualInterviewDurationMs:j.actualInterviewDurationMs},
 queueSnapshot:{file:directory+'/queue-snapshot.json',originalFile:queueFile,sha256:sha(qb),status:queue.status},
 checkerSha256:sha(await readFile(new URL(import.meta.url))),
 manifest:{file:task.manifest,sha256:sha(mb)},manualReview:{file:directory+'/manual-notes.json',sha256:sha(nb)},
 rows,measurements,comparison:Object.fromEntries(['fresh','aged'].map(p=>[p,phase(p).map(x=>({round:x.round,
  correctness:x.correctness,error:x.error??null,acceptedToActualWriteMs:x.acceptedToActualWriteMs,
  usefulFeedbackMs:x.usefulFeedbackMs??null}))])),
 scope:'Six individually read original requests, identical exact context and question in the same native session: three fresh and three after at least one actual elapsed hour. Failed originals stay missing/error with no replacement or successful-latency imputation. No intervening technical history enters this input. Idle application and connection aging is distinct from loaded interview history. Provider/OS drift, warmup and millisecond anchor uncertainty remain; three samples per phase cannot certify general reliability or establish a cause. Byte hashes bind manual verdicts, not inferred model attention or unseen provider framing.'};
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,duration:j.actualInterviewDurationMs,counts:measurements.counts,comparison:result.comparison}));
