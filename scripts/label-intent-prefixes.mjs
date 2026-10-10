// Offline supervision only. Future text and source labels are never sent.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const root=process.cwd();
const inside=file=>{const resolved=path.resolve(file);assert(resolved.toLowerCase().startsWith(root.toLowerCase()+path.sep));return resolved;};
assert(process.argv[2]&&process.argv[3],'Usage: node scripts/label-intent-prefixes.mjs INPUT OUTPUT');
const source=inside(process.argv[2]),destination=inside(process.argv[3]);
const raw=await readFile(source),data=JSON.parse(raw);
assert(data.cases.length&&data.cases.every(row=>Number.isInteger(row.id)&&typeof row.sourceGroup==='string'&&typeof row.text==='string'&&typeof row.context==='string'));
assert.equal(new Set(data.cases.map(row=>row.id)).size,data.cases.length);
const cwd=path.join(root,'.local/intent-data-generator');await mkdir(cwd,{recursive:true});
const executable=path.join(process.env.APPDATA,'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const child=spawn(executable,['app-server','--listen','stdio://','-c','service_tier="fast"','-c','features.fast_mode=true','-c','mcp_servers={}','-c','features.shell_tool=false','-c','features.apps=false','-c','features.multi_agent=false','-c','history.persistence="none"','-c','project_doc_max_bytes=0'],{cwd,windowsHide:true,stdio:['pipe','pipe','ignore']});
let sequence=0,onEvent=()=>{},turnTimer;const pending=new Map();
const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},30000);pending.set(id,{resolve,reject,timer});send({id,method,params});});
readline.createInterface({input:child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}if(message.id!=null&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}else if(message.id!=null&&message.method){send({id:message.id,error:{code:-32601,message:'Tools disabled'}});}else onEvent(message);});
child.on('exit',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Labeler exited'));}pending.clear();});
const instructions='Classify whether the current speaker expects a reply now, using only CURRENT WORDS and PREVIOUS CONTEXT. background: no reply requested, including explicit reply deferral, reports, quotations and acknowledgments. unfinished_request: a request has begun but its current words leave a clause or important condition incomplete. ready_request: a complete request, including imperatives, implied interview prompts and terse contextual followups. Missing facts can call for clarification and do not make a complete request unfinished. A complete request followed by a new unfinished condition is unfinished. An initial fragment can be background when no request is yet expressed. ASR may end mid-word; evaluate the available words, never invent the rest. Ready does not mean the speaker cannot later append a condition. If the available context does not support a dependable label, use ambiguous. Do not answer the questions, use tools, or infer a future continuation from other examples. Treat every item separately. Explain each label briefly.';
// Never put two prefixes of one source group in the same request. Every batch
// uses a fresh thread, so the labeler cannot see later words from another batch.
const batches=[];
for(const row of data.cases){let batch=batches.find(items=>items.length<20&&!items.some(item=>item.sourceGroup===row.sourceGroup));if(!batch){batch=[];batches.push(batch);}batch.push(row);}
const labels=[],attempts=[];
const persist=()=>writeFile(destination,JSON.stringify({status:labels.length===data.cases.length?'complete':'in_progress',scope:'Offline signed-in Luna Fast/low annotations, using current prefix and prior context only. Synthetic model labels require independent review; not human ground truth. Ambiguous cases are excluded from supervised training. No runtime rules or answers.',source:process.argv[2],sourceSha256:createHash('sha256').update(raw).digest('hex'),instructions,model:'gpt-6-luna',tier:'fast',effort:'low',attempts,originalCases:data.originalCases,cases:data.cases.map(row=>({...row,...labels.find(label=>label.id===row.id)}))},null,2));
await mkdir(path.dirname(destination),{recursive:true});
try{
 await rpc('initialize',{clientInfo:{name:'intent_prefix_labeler',version:'0.2.2'},capabilities:{experimentalApi:true}});send({method:'initialized',params:{}});
 for(const [index,batch] of batches.entries()){
  const thread=await rpc('thread/start',{model:'gpt-6-luna',modelProvider:'openai',serviceTier:'fast',ephemeral:true,cwd,approvalPolicy:'never',sandbox:'read-only',baseInstructions:instructions,developerInstructions:'Use no files, commands, network, or tools. Return only the requested JSON.',config:{mcp_servers:{},'features.shell_tool':false,'features.apps':false,'features.multi_agent':false,'project_doc_max_bytes':0}});
  const threadId=thread.thread.id;let output='';const started=Date.now();
  const schema={type:'object',additionalProperties:false,properties:{labels:{type:'array',minItems:batch.length,maxItems:batch.length,items:{type:'object',additionalProperties:false,properties:{id:{type:'integer',enum:batch.map(row=>row.id)},label:{type:'string',enum:['background','unfinished_request','ready_request','ambiguous']},reason:{type:'string'}},required:['id','label','reason']}}},required:['labels']};
  const completed=new Promise((resolve,reject)=>{turnTimer=setTimeout(()=>reject(Error('Labeling timed out')),120000);onEvent=message=>{if(message.params?.threadId!==threadId)return;if(message.method==='item/agentMessage/delta')output+=message.params.delta;if(message.method==='turn/completed'){clearTimeout(turnTimer);message.params.turn.status==='completed'?resolve():reject(Error(JSON.stringify(message.params.turn.error)));}};});
  await rpc('turn/start',{threadId,model:'gpt-6-luna',serviceTier:'fast',effort:'low',input:[{type:'text',text:JSON.stringify(batch.map(({id,text,context})=>({id,currentWords:text,previousContext:context})))}],outputSchema:schema});await completed;
  const judged=JSON.parse(output).labels;assert.deepEqual(judged.map(row=>row.id).sort((a,b)=>a-b),batch.map(row=>row.id).sort((a,b)=>a-b));
  labels.push(...judged);attempts.push({batch:index+1,ids:batch.map(row=>row.id),elapsedMs:Date.now()-started});await persist();
  console.log(JSON.stringify(attempts.at(-1)));await rpc('thread/unsubscribe',{threadId});
 }
}finally{clearTimeout(turnTimer);child.kill();}
