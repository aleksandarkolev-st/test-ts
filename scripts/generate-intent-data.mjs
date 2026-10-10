// Evaluation/training utility only. No examples or interview scripts are loaded
// by the assistant. Uses the existing signed-in Codex account, Luna Fast.
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const destination=path.resolve(process.argv[2]||'artifacts/intent-classifier/generated-training.json');
assert(destination.toLowerCase().startsWith(root.toLowerCase()+path.sep));
const count=Number(process.argv[3]||160);assert(Number.isInteger(count)&&count>=20&&count<=240);
const role=process.argv[4]||'training';assert(['training','validation','heldout','pause'].includes(role));
const cwd=path.join(root,'.local/intent-data-generator');await mkdir(cwd,{recursive:true});
const executable=path.join(process.env.APPDATA,'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const child=spawn(executable,['app-server','--listen','stdio://','-c','service_tier="fast"','-c','features.fast_mode=true','-c','mcp_servers={}','-c','features.shell_tool=false','-c','features.apps=false','-c','features.multi_agent=false','-c','history.persistence="none"','-c','project_doc_max_bytes=0'],{cwd,windowsHide:true,stdio:['pipe','pipe','ignore']});
let sequence=0,onEvent=()=>{},turnTimer;const pending=new Map();
const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},30000);pending.set(id,{resolve,reject,timer});send({id,method,params});});
readline.createInterface({input:child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}if(message.id!=null&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);}else if(message.id!=null&&message.method){send({id:message.id,error:{code:-32601,message:'Tools disabled'}});}else onEvent(message);});
child.on('exit',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Generator exited'));}pending.clear();});
const balanced=process.env.COPILOT_INTENT_BALANCED==='1'&&role!=='pause';
const longForm=process.env.COPILOT_INTENT_LONG_FORM==='1'&&role!=='pause';
const paired=process.env.COPILOT_INTENT_PAIRED==='1'&&role!=='pause';
assert(!longForm||balanced,'Long-form label-specific length checks require balanced groups');
assert(!paired||(balanced&&count%3===0),'Matched episodes require balanced groups and a count divisible by three');
const classes=[['background',false,false],['unfinished',true,false],['ready',true,true]];
const counts=classes.map((_,i)=>Math.floor(count/3)+(i<count%3?1:0));
const sample={type:'object',additionalProperties:false,properties:{text:{type:'string'},context:{type:'string'}},required:['text','context']};
const lengthRange=name=>name==='unfinished'?[20,70]:[50,110];
const groupSample=name=>{
 if(!longForm)return sample;
 const [min,max]=lengthRange(name);
 return {...sample,properties:{...sample.properties,text:{type:'string',pattern:`^(?:\\S+\\s+){${min-1},${max-1}}\\S+$`}}};
};
const episodeSample=name=>{
 const definition=groupSample(name);
 return {...definition,properties:{text:definition.properties.text},required:['text']};
};
const episode={type:'object',additionalProperties:false,
 properties:{context:{type:'string'},...Object.fromEntries(classes.map(([name])=>[name,episodeSample(name)]))},
 required:['context',...classes.map(([name])=>name)]};
const schema=paired?{type:'object',additionalProperties:false,properties:{episodes:{type:'array',minItems:count/3,maxItems:count/3,items:episode}},required:['episodes']}:balanced?{type:'object',additionalProperties:false,properties:Object.fromEntries(classes.map(([name],i)=>[name,{type:'array',minItems:counts[i],maxItems:counts[i],items:groupSample(name)}])),required:classes.map(([name])=>name)}:{type:'object',additionalProperties:false,properties:{cases:{type:'array',minItems:count,maxItems:count,items:{type:'object',additionalProperties:false,properties:{text:{type:'string'},context:{type:'string'},request:{type:'boolean'},ready:{type:'boolean'}},required:['text','context','request','ready']}}},required:['cases']};
try{
 await rpc('initialize',{clientInfo:{name:'intent_training',version:'0.2.2'},capabilities:{experimentalApi:true}});send({method:'initialized',params:{}});
 const thread=await rpc('thread/start',{model:'gpt-6-luna',modelProvider:'openai',serviceTier:'fast',ephemeral:true,cwd,approvalPolicy:'never',sandbox:'read-only',baseInstructions:'Generate labeled synthetic classification data. Use no tools. Return only the requested JSON.',developerInstructions:'Use no files, commands, network, or tools.',config:{mcp_servers:{},'features.shell_tool':false,'features.apps':false,'features.multi_agent':false,'project_doc_max_bytes':0}});
 let output='';const threadId=thread.thread.id;
 const completed=new Promise((resolve,reject)=>{turnTimer=setTimeout(()=>reject(Error('Generation timeout')),240000);onEvent=message=>{if(message.params?.threadId!==threadId)return;if(message.method==='item/agentMessage/delta')output+=message.params.delta;if(message.method==='turn/completed'){clearTimeout(turnTimer);message.params.turn.status==='completed'?resolve():reject(Error(JSON.stringify({status:message.params.turn.status,error:message.params.turn.error?.message,code:message.params.turn.error?.codexErrorInfo})));}};});
 const prompt=role==='pause'?`Generate ${count} fresh technical interview pause-and-continuation probes. Each context field is a SHORT COMPLETE initial request that a listener could answer now. Each text field is an IMPORTANT extra condition the SAME speaker adds after a pause, changing what a correct answer must satisfy. Both fields are spoken public question content, never answers or diagnoses. Set request and ready true. Include difficult GPU/coding, concurrency, replication, mathematics, and systems design with exact constraints, vague symptoms, and corrections. Vary natural question wording; avoid template families. The initial question and appended condition must be technically consistent and the condition must materially change the answer. No canned replies. These are safety evaluation data only, never production routing.`:`Create ${count} fresh, diverse ${role} examples for a small local conversation classifier. Label request=true only when the CURRENT speaker expects the listener to respond or act; ready=true only when the current words express a complete request. Ready does NOT mean the speaker cannot add a later condition. Background, acknowledgment, quoted questions, observations, and requests to wait are request=false and ready=false. An unfinished imperative or question is request=true but ready=false. A bare setup fragment is false/false. Balance these three groups approximately equally. Include direct and indirect requests, imperatives, punctuation-free ASR, ambiguous symptoms requiring clarification, terse contextual followups, corrections, negation, quotations, long setups, and pauses before trailing constraints. Use many domains: everyday planning, meetings, mathematics, distributed systems, finance discussions, writing, medical conversations, and difficult GPU/code interviews. Include sparse vague GPU symptoms and increasingly deep contextual followups. Use varied wording and lengths, no template families or numbered variants. context contains only a short previous conversational exchange when necessary; text contains CURRENT words only. No answers or canned responses. No duplicate text. Ensure labels are logically consistent; incomplete text MUST remain incomplete, and ready=true MUST also have request=true. These data are ${role} only; never write production routing rules.`;
 const balancePrompt=balanced?`\nUse the three schema groups, with exactly ${counts[0]} background, ${counts[1]} unfinished, and ${counts[2]} ready samples. Background means no assistant reply is expected; a request to wait or let the speaker finish is background for this task. Unfinished means a response is being requested but the current words do not yet express the full request. Ready includes imperatives, indirect requests, one- or two-word contextual probes, and implicit hypothetical interview challenges when previous context establishes that a response is expected. Half of all texts should resemble punctuation-free ASR. Do not mark an implied but complete interview request as background. Mix complete and incomplete syntax naturally. Avoid repeating the same four-word opening across more than three examples; vary construction, length, domain and conversational context. No answers, numbered template families, or routing rules.`:'';
 // These are labeling instructions for offline supervised data. They are not
 // keyword rules in the live classifier. Missing facts do not make a complete
 // request unfinished, and an operational wait differs from deferring a reply.
 const labelClarifications=role==='pause'?'':`\nResolve labels from conversational meaning, not individual words. A complete request with unspecified facts remains ready: the appropriate response may be a clarification. A complete answer to an active clarification may require the listener to continue solving the problem. Only a request to withhold the listener's reply while the speaker continues is background; an instruction to perform a task involving waiting, synchronization, or a delayed action can still require a response. Preserve this distinction in every schema group.`;
 const longInstructions=longForm?`\nUse longer natural speech, unlike isolated short commands. Ready and background texts should normally have 50–110 words; unfinished requests should have 20–70 words and end before an important clause is supplied. Include multi-clause setups followed by a complete request, self-corrections, multiple linked requests, exact constraints, and technically consistent hypothetical challenges. Use varied domains, not only technical interviews. Most text should be punctuation-free ASR style. Include short prior exchanges with speaker roles in context for at least half the examples, including earlier responses where needed to identify an implied request. Prior context is classification data, not a reference answer to the current question or a live canned reply. Do not reveal the current challenge's solution. Do not mark a complete request unfinished just because its answer needs missing facts. Preserve the difference between the speaker deferring a reply and a task containing an operational wait.`:'';
 const pairInstructions=paired?`\nReturn ${count/3} matched episodes instead of independent schema groups. Each episode has background, unfinished, and ready versions of the SAME underlying situation with closely matched topic, facts, notation and vocabulary. This prevents learning that a subject itself determines intent. Vary conversational purpose and completion while preserving the situation. For at least half the unfinished versions, include an initially COMPLETE request followed by a NEW unfinished condition or a second unfinished request; the current whole utterance is ready=false. Its ready partner finishes that same condition or request without changing the earlier facts. A complete request that merely needs missing facts remains ready. Background versions should mix reports, quoted questions, acknowledgments, and explicit reply deferral, rather than always saying to wait. Use many unrelated domains, indirect requests and imperatives as well as grammatical questions. Mix very short contextual probes with long multi-clause speech. Include prior speaker exchanges where needed. No answers to the current challenge, canned replies, production routing rules, or identical texts across labels.`:'';
 const sharedContextInstructions=paired?'\nEach episode has ONE shared context string, identical for all three variants. Use a prior conversational exchange compatible with each variant, or an empty string for the whole episode. Do not correlate context presence or content with the label. Only the current text varies across the three versions.':'';
 const instructions=prompt+balancePrompt+labelClarifications+longInstructions+pairInstructions+sharedContextInstructions;
 await rpc('turn/start',{threadId,model:'gpt-6-luna',serviceTier:'fast',effort:'low',input:[{type:'text',text:instructions}],outputSchema:schema});await completed;
 const generated=JSON.parse(output);
 const result=paired?{cases:generated.episodes.flatMap((item,episode)=>classes.map(([name,request,ready])=>({...item[name],context:item.context,request,ready,episode})))}:balanced?{cases:classes.flatMap(([name,request,ready],i)=>{assert.equal(generated[name].length,counts[i]);return generated[name].map(item=>({...item,request,ready}));})}:generated;
 assert.equal(result.cases.length,count);assert.equal(new Set(result.cases.map(item=>item.text)).size,count);assert(result.cases.every(item=>!item.ready||item.request));
 const wordCounts=result.cases.map(item=>item.text.trim().split(/\s+/u).length);
 const lengthAudit={min:Math.min(...wordCounts),max:Math.max(...wordCounts),mean:wordCounts.reduce((a,b)=>a+b,0)/count};
 if(longForm){
   lengthAudit.outsideRequestedRange=result.cases.flatMap((item,index)=>{
     const [min,max]=item.request&&!item.ready?[20,70]:[50,110];
     return wordCounts[index]<min||wordCounts[index]>max?[{index,words:wordCounts[index],min,max}]:[];
   });
   assert.equal(lengthAudit.outsideRequestedRange.length,0,'Generated long-form texts violate requested word counts');
 }
 await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify({scope:`Synthetic ${role} data generated by signed-in Luna Fast, low reasoning. Model labels require human review; not certification. Never production routing.`,model:'gpt-6-luna',tier:'fast',effort:'low',role,balanced,longForm,paired,lengthAudit,prompt:instructions,...result},null,2));
 console.log(JSON.stringify({output:destination,count,role,longForm}));await rpc('thread/unsubscribe',{threadId});
}finally{clearTimeout(turnTimer);child.kill();}
