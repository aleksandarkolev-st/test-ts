// Post-capture SQL execution in an owned local PostgreSQL instance. Source
// fences are not repaired; only their transaction statements are scheduled.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [journalFile,specFile,outDir]=process.argv.slice(2);
assert(journalFile&&specFile&&outDir,'JOURNAL SPECS OUTPUT');
const root=process.cwd(),out=path.resolve(outDir);assert(out.startsWith(root+path.sep));
const bytes=await readFile(journalFile),j=JSON.parse(bytes),spec=JSON.parse(await readFile(specFile));
const sha=x=>createHash('sha256').update(x).digest('hex');
assert.equal(j.status,'complete');assert.equal(spec.journalSha256,sha(bytes));
await mkdir(out,{recursive:true});const data=path.join(out,'postgres-data');
try{await access(data);assert.fail('Use a new output directory; never reuse an existing database');}catch(e){if(e.code!=='ENOENT')throw e;}
const bin=spec.postgresBin??'C:/Program Files/PostgreSQL/17/bin',port=spec.port??55472;
assert(Number.isInteger(port)&&port>=1024&&port<=65535);
const run=(file,args,input)=>new Promise(resolve=>{
 const p=spawn(path.join(bin,file),args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.stdin.on('error',()=>{});
 if(input!=null)p.stdin.end(input);else p.stdin.end();
 const timer=setTimeout(()=>p.kill(),20000);p.once('error',e=>{clearTimeout(timer);resolve({error:String(e),stdout,stderr});});
 p.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
});
const args=['-X','-A','-t','-q','-h','127.0.0.1','-p',String(port),'-U','controller_eval','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
const sql=text=>run('psql.exe',args,text);
function session(){
 const p=spawn(path.join(bin,'psql.exe'),args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',ended=false,waiting=null,serial=0;
 const settle=value=>{if(waiting){clearTimeout(waiting.timer);waiting.resolve(value);waiting=null;}};
 p.stdout.on('data',d=>{stdout+=d;if(waiting&&stdout.includes(waiting.marker))settle({code:0,stdout:stdout.replace(waiting.marker,''),stderr});});
 p.stderr.on('data',d=>stderr+=d);p.stdin.on('error',()=>{});
 p.once('error',e=>{ended=true;settle({error:String(e),stdout,stderr});});
 p.once('exit',code=>{ended=true;settle({code,stdout,stderr});});
 return {send(text){assert(!waiting);if(ended)return Promise.resolve({code:p.exitCode,stdout,stderr});stdout=stderr='';
  return new Promise(resolve=>{const marker=`controller_marker_${++serial}`;waiting={resolve,marker,timer:setTimeout(()=>{p.kill();settle({error:'statement timeout',stdout,stderr});},10000)};p.stdin.write(text+'\n\\echo '+marker+'\n');});},
  async close(){if(!ended){p.stdin.end('\\q\n');await new Promise(resolve=>{if(ended)resolve();else p.once('exit',resolve);});}}};
}
const startedAt=new Date().toISOString(),results=[];let owned=false;
try{
 const init=await run('initdb.exe',['-D',data,'-A','trust','-U','controller_eval','--no-locale','-E','UTF8']);assert.equal(init.code,0,JSON.stringify(init));
 const start=await run('pg_ctl.exe',['-D',data,'-l',path.join(out,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -F -c max_connections=10`,'-w','start']);
 assert.equal(start.code,0,JSON.stringify(start));owned=true;
 const version=await sql('SELECT version();');assert.equal(version.code,0);
 for(const check of spec.checks){
  const row=j.rows.find(r=>r.round===check.round);assert(row);const blocks=[...row.answer.matchAll(/```sql\s*\n([\s\S]*?)```/gi)].map(m=>m[1]);
  const result={round:row.round,answerSha256:sha(row.answer),scope:'Actual unchanged SQL in PostgreSQL, with BEGIN/body/COMMIT sent separately to force overlap. Isolated synthetic database; no source repairs.',trials:[]};results.push(result);
  const setup=blocks[check.setupBlock],sources=[blocks[check.aliceBlock],blocks[check.bobBlock]];
  if(setup==null||sources.some(s=>s==null)){result.failure='Required complete SQL fences absent';continue;}
  result.sourceSha256=[setup,...sources].map(sha);
  const parts=sources.map(s=>s.trim().match(/^(BEGIN\b[^;]*;)([\s\S]*?)(COMMIT\s*;)\s*$/i));
  if(parts.some(p=>!p)){result.failure='Harness requires separate BEGIN/body/COMMIT transaction fences; unsupported layout is not a model correctness verdict';continue;}
  assert(/^[A-Za-z_]\w*$/.test(check.table)&&/^[A-Za-z_]\w*$/.test(check.onCallColumn));
  for(const mode of ['recorded_serializable','repeatable_read_control'])for(const order of [[0,1],[1,0]]){
   const reset=await sql(`DROP TABLE IF EXISTS ${check.table};\n`+setup);assert.equal(reset.code,0,JSON.stringify(reset));
   const actors=[session(),session()],events=[];let failed=null;
   try{
    for(const index of order){const begin=mode==='recorded_serializable'?parts[index][1]:parts[index][1].replace(/\bSERIALIZABLE\b/i,'REPEATABLE READ');const r=await actors[index].send(begin);events.push({actor:index,stage:'begin',...r});assert.equal(r.code,0);}
    for(const index of order){const r=await actors[index].send(parts[index][2]);events.push({actor:index,stage:'body',...r});if(r.code!==0)failed=index;}
    for(const index of order){if(index===failed)continue;const r=await actors[index].send(parts[index][3]);events.push({actor:index,stage:'commit',...r});if(r.code!==0)failed=index;}
   }finally{await Promise.all(actors.map(a=>a.close()));}
   const after=await sql(`SELECT count(*) FROM ${check.table} WHERE ${check.onCallColumn};`);
   const retry=mode==='recorded_serializable'&&failed!=null?await sql(sources[failed]):null;
   const final=await sql(`SELECT count(*) FROM ${check.table} WHERE ${check.onCallColumn};`);
   const serializationFailure=events.some(e=>e.code!==0&&/40001/.test(e.stderr));
   result.trials.push({mode,order,events,after,retry,final,serializationFailure,
    adaptation:mode==='repeatable_read_control'?'Control changes only BEGIN isolation to REPEATABLE READ; this is not the unchanged recorded answer.':null,
    pass:mode==='recorded_serializable'?
     serializationFailure&&after.code===0&&Number(after.stdout.trim())>=1&&retry?.code===0&&final.code===0&&Number(final.stdout.trim())>=1:
     !serializationFailure&&events.every(e=>e.code===0)&&final.code===0&&Number(final.stdout.trim())===0});
  }
  result.pass=result.trials.every(t=>t.pass);
 }
 await writeFile(path.join(out,'results.json'),JSON.stringify({journalFile,journalSha256:sha(bytes),startedAt,completedAt:new Date().toISOString(),postgresVersion:version.stdout.trim(),results,
  scope:'Finite controlled overlap tests of recorded serializable transactions and full retries; manual reasoning and the universal invariant are assessed separately.'},null,2));
 console.log(JSON.stringify(results.map(r=>({round:r.round,pass:r.pass??false,failure:r.failure??null}))));
}finally{if(owned){const stopped=await run('pg_ctl.exe',['-D',data,'-m','fast','-w','stop']);assert.equal(stopped.code,0,'Owned evaluation database did not stop cleanly');}}
