import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {recordedCohort} from './lib/recorded-cohort.mjs';
const root=process.argv[2]??'artifacts/deep-interview-v71',hash=x=>createHash('sha256').update(x).digest('hex');
const recorded=await recordedCohort(root);
const controls=JSON.parse(await readFile(root+'/policy-playback/playback.json'));assert.equal(controls.status,'complete');assert(controls.stoppedCleanly);
const directory=root+'/decoder-benchmark';await mkdir(directory);await mkdir(directory+'/src');
const codexFile='src-tauri/src/openai/codex.rs',source=await readFile(codexFile),text=source.toString();
const start=text.indexOf('#[derive(Deserialize)]\n#[serde(rename_all="lowercase")]'),end=text.indexOf('\npub struct Codex {',start);assert(start>=0&&end>start);
const decoder=text.slice(start,end),cases=[];
for(const {domain,file} of recorded.hours){
 const raw=await readFile(file),journal=JSON.parse(raw);
 assert.equal(journal.status,'complete');assert(journal.stoppedCleanly);assert.equal(journal.sourceHashes[codexFile],hash(source));
 const rows=journal.rows.filter(row=>typeof row.answer==='string'&&row.answer.length).sort((a,b)=>b.answer.length-a.answer.length);assert(rows.length);
 const row=rows[0];cases.push({name:path.basename(path.dirname(file))+'-round-'+row.round,source:{file,sha256:hash(raw),round:row.round,responseVersion:row.responseVersion},answerSha256:hash(row.answer),answer:row.answer,phase:row.phase,cancelled:row.cancelled,error:row.error});
 globalThis.gc?.();
}
const lock=await readFile('src-tauri/Cargo.lock','utf8');
const version=name=>{const match=new RegExp('name = "'+name+'"\\r?\\nversion = "([^"\\r\\n]+)"').exec(lock);assert(match);assert(/^\d+\.\d+\.\d+$/.test(match[1]));return match[1];};
const cargo=`[package]\nname = "recorded-decoder-benchmark-v71"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nserde = { version = "=${version('serde')}", features = ["derive"] }\nserde_json = "=${version('serde_json')}"\n`;
const main=String.raw`
use serde::Deserialize;
use serde_json::{json,Value};
use std::time::Instant;
DECODER_SOURCE
fn main(){
 let input=std::env::args().nth(1).expect("input path");
 let cases:Value=serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
 let mut results=Vec::new();
 for case in cases.as_array().unwrap(){
  let answer=case["answer"].as_str().unwrap();
  let encoded=serde_json::to_string(answer).unwrap();
  for order in ["intent_first","text_first_counterfactual"]{
   let raw=if order=="intent_first"{format!("{{\"intent\":\"answer\",\"text\":{encoded}}}")}
     else{format!("{{\"text\":{encoded},\"intent\":\"answer\"}}")};
   let characters:Vec<char>=raw.chars().collect();
   for chunk_chars in [1usize,8,64]{
    let chunks:Vec<String>=characters.chunks(chunk_chars).map(|chars|chars.iter().collect()).collect();
    for repetition in 1..=3{
     let mut gate=ReplyGate::default();let mut shown=String::new();let mut first=None;let mut first_chunk=None;
     let started=Instant::now();
     for (index,chunk) in chunks.iter().enumerate(){
      if let Some(delta)=gate.feed(chunk).unwrap(){if first.is_none(){first=Some(started.elapsed().as_micros());first_chunk=Some(index+1);}shown.push_str(&delta);}
     }
     gate.finish().unwrap();assert_eq!(shown,answer);
     results.push(json!({"name":case["name"],"order":order,"chunkCharacters":chunk_chars,"chunks":chunks.len(),"repetition":repetition,"rawBytes":raw.len(),"answerBytes":answer.len(),"firstDecodedChunk":first_chunk,"firstDecodedTextWallTimeUs":first,"totalDecodeWallTimeUs":started.elapsed().as_micros(),"exactAnswerPreserved":true}));
    }
   }
  }
 }
 println!("{}",serde_json::to_string(&results).unwrap());
}
`.replace('DECODER_SOURCE',decoder);
await writeFile(directory+'/Cargo.toml',cargo,{flag:'wx'});await writeFile(directory+'/src/main.rs',main,{flag:'wx'});
await writeFile(directory+'/input.json',JSON.stringify(cases),{flag:'wx'});
const report={status:'prepared',recordedAt:new Date().toISOString(),codexSource:{file:codexFile,sha256:hash(source)},extractedDecoderSha256:hash(decoder),benchmarkSourceSha256:hash(main),cargoLockSha256:hash(lock),
 cases:cases.map(({answer,...rest})=>({...rest,answerCharacters:answer.length})),profile:'debug, isolated crate with pinned existing serde/serde_json versions',
 scope:'Exact copied decoder functions from the captured diagnostic source. Largest nonempty retained answer from each completed hour, without correctness filtering. Synthetic chunks of one, eight and sixty-four Unicode scalar values are delivered synchronously without network delays; original raw chunking is unavailable. Text-first ordering is a counterfactual stress case, not an observed provider order. Instant measures wall time including OS scheduling, not CPU-accounted processor time. Three sequential repetitions and shared machine resources do not establish provider latency or a population percentile.',
 measuredNativePlaybackOverlapping:false,goalComplete:false};
await writeFile(directory+'/preparation.json',JSON.stringify(report,null,2),{flag:'wx'});
const run=await new Promise((resolve,reject)=>{
 const child=spawn('cargo',['run','--offline','--manifest-path',path.resolve(directory+'/Cargo.toml'),'--',path.resolve(directory+'/input.json')],{cwd:process.cwd(),env:{...process.env,CARGO_TARGET_DIR:path.resolve(directory+'/target')},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr=(stderr+x).slice(-12000));child.once('error',reject);child.once('exit',code=>resolve({code,stdout,stderr}));
});
await writeFile(directory+'/cargo-output.json',JSON.stringify(run,null,2),{flag:'wx'});
assert.equal(run.code,0,'Decoder benchmark build/run failed; preserve raw output');
const results=JSON.parse(run.stdout.trim());assert.equal(results.length,cases.length*2*3*3);assert(results.every(r=>r.exactAnswerPreserved));
await writeFile(directory+'/results.json',JSON.stringify({...report,status:'complete',completedAt:new Date().toISOString(),results},null,2),{flag:'wx'});
console.log(JSON.stringify({directory,executions:results.length,maxTotalDecodeWallTimeUs:Math.max(...results.map(r=>r.totalDecodeWallTimeUs))}));
