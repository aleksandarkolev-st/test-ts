//! Separate subscription-backed assessment of recorded public execution.
//! Model judgments remain provisional; executable/manual verification is separate.
use meeting_copilot_core::openai::{codex::Codex,client::StreamEvent};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{io::Write,path::{Component,PathBuf},sync::{Arc,Mutex},time::Instant};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main()->Result<(),String>{
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize().map_err(|e|e.to_string())?;
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    if args.len()!=2{return Err("JOURNAL OUTPUT_DIRECTORY".into());}
    let source=PathBuf::from(&args[0]).canonicalize().map_err(|e|e.to_string())?;
    if !source.starts_with(&root){return Err("Journal must stay in workspace".into());}
    let directory=root.join(&args[1]);
    if !directory.starts_with(&root)||directory.components().any(|c|c==Component::ParentDir){return Err("Output must stay in workspace".into());}
    let ancestor=directory.ancestors().find(|p|p.exists()).ok_or("Missing output ancestor")?.canonicalize().map_err(|e|e.to_string())?;
    if !ancestor.starts_with(&root){return Err("Output ancestor must stay in workspace".into());}
    std::fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    if !directory.canonicalize().map_err(|e|e.to_string())?.starts_with(&root){return Err("Output must stay in workspace".into());}
    let journal:Value=serde_json::from_slice(&std::fs::read(&source).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if !matches!(journal["status"].as_str(),Some("complete"|"failed"))||journal["stoppedCleanly"]!=true{return Err("Require a clean terminal recording".into());}
    let codex=Codex::new(root.join(".local/codex/codex.exe"),root.join(".local/independent-assessment/work"));
    // Every judgment gets only its explicit bound input. Cached native thread
    // history must not leak earlier review labels or unrelated case answers.
    codex.set_continuity(false);
    let result=assess(&codex,&journal,&directory).await;codex.close();result
}
async fn assess(codex:&Arc<Codex>,journal:&Value,directory:&std::path::Path)->Result<(),String>{
    if codex.account().await?.is_none(){return Err("Signed-in Codex account required".into());}
    let model=std::env::var("COPILOT_INDEPENDENT_MODEL").unwrap_or("gpt-6.1-sol".into());
    let effort=std::env::var("COPILOT_INDEPENDENT_EFFORT").unwrap_or("low".into());
    let reviewer_binary=std::env::current_exe().map_err(|e|e.to_string())?;
    let reviewer_binary_sha256=format!("{:x}",Sha256::digest(std::fs::read(reviewer_binary).map_err(|e|e.to_string())?));
    let reviewer_source_sha256=format!("{:x}",Sha256::digest(include_bytes!("assess-recorded-interview.rs")));
    let schema=json!({"type":"object","properties":{
        "verdict":{"type":"string","enum":["correct","incorrect","incomplete","unverified"]},
        "constraintTracking":{"type":"boolean"},"factualAccuracy":{"type":"string"},"codeCorrectness":{"type":"string"},
        "unsupportedClaims":{"type":"array","items":{"type":"string"}},
        "issues":{"type":"array","items":{"type":"string"}},
        "substantiveChecksNeeded":{"type":"array","items":{"type":"string"}},
        "usefulPhrase":{"type":["string","null"]},"usefulPhraseReason":{"type":"string"},
        "lateConditionRecognized":{"type":"boolean"},"lateConditionAnswered":{"type":"boolean"}},
        "required":["verdict","constraintTracking","factualAccuracy","codeCorrectness","unsupportedClaims","issues","substantiveChecksNeeded","usefulPhrase","usefulPhraseReason","lateConditionRecognized","lateConditionAnswered"],"additionalProperties":false});
    let instructions="Independently assess a RECORDED technical interview answer. You are separate from its examiner. You receive the actual public prior context, exact spoken source question, recognized question, final recorded answer and recorded error/cancellation outcome. A native phase named complete may reflect terminal cleanup after an error; it does not prove successful answer delivery. Judge the actual retained answer and report truncation, missing code or unfinished requirements. Judge the answer against the SOURCE spoken question; ASR mistakes are pipeline failures, not grounds to silently relax constraints. Assess constraint tracking, factual accuracy, executable algorithm correctness and unsupported claims. Do not grade against unstated future requirements. Reject false premises when necessary, allow accurate essential clarification, and trace concrete counterexamples before alleging a wrong algorithm result. Mark unresolved substantive claims unverified, especially hardware behavior or code not executed. Compilation is not correctness. Never claim you ran tests or consulted documentation: you have no tools. List concrete independent checks still needed. Separately choose the EARLIEST correct, useful phrase in the exact answer that substantively addresses this question. It must be an EXACT contiguous substring of the answer, normally a complete factual clause with enough qualification to be correct. Filler, promises to explain, single characters, acknowledgments and vague restatements do not qualify. You may choose a correct early clause even if a later answer claim is wrong; full correctness remains a separate judgment. If no useful correct phrase survives, return null. Do not see examiner grades or numerical timing while assessing. Return only the specified JSON.";
    let rows=journal["rows"].as_array().ok_or("Missing rows")?;
    for (index,row) in rows.iter().enumerate(){
        let file=directory.join(format!("trial-{:03}.json",index+1));
        // Paired backend diagnostics are separate executions of cases from
        // different recordings, not one shared conversation. Their projector
        // binds each original source history and keeps it separate here.
        let source_prior_questions=match row.get("recordedSourcePriorQuestions") {
            Some(Value::Array(prior))=>prior.clone(),
            Some(_)=>return Err("Recorded source prior questions must be an array".into()),
            None=>rows[..index].iter().map(|prior|json!({"round":prior["round"],"question":prior["question"]})).collect::<Vec<_>>(),
        };
        let input=json!({"publicPriorContext":row["selectedContext"],"sourcePriorQuestions":source_prior_questions,"spokenQuestion":row["question"],
            "recognizedQuestion":row["recognizedQuestion"],"answer":row["answer"],"phase":row["phase"],
            "error":row["error"],"cancelled":row["cancelled"]}).to_string();
        let input_hash=format!("{:x}",Sha256::digest(input.as_bytes()));
        if file.exists(){
            let prior:Value=serde_json::from_slice(&std::fs::read(&file).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            if prior["inputSha256"]!=input_hash||prior["model"]!=model||prior["effort"]!=effort||prior["reviewerContinuity"]!=false{return Err(format!("Trial {} cached assessment does not match input/settings/isolated-history policy",index+1));}
            println!("Keeping existing assessment {}",index+1);continue;
        }
        let attempts_directory=directory.join("attempts");std::fs::create_dir_all(&attempts_directory).map_err(|e|e.to_string())?;
        let mut attempt_records=Vec::new();
        let mut text=Arc::new(Mutex::new(String::new()));
        for invocation_attempt in 1..=3 {
            text=Arc::new(Mutex::new(String::new()));let sink=text.clone();let started=Instant::now();
            let outcome=codex.stream_json(&model,Some("fast"),Some(&effort),instructions,&input,&schema,CancellationToken::new(),move|event|{
                match event{StreamEvent::Delta(delta)=>sink.lock().unwrap().push_str(&delta),StreamEvent::Revision(replacement)=>*sink.lock().unwrap()=replacement,_=>{}}
                async{Ok(())}
            }).await;
            let mut ordinal=1;
            let attempt_file=loop{
                let candidate=attempts_directory.join(format!("trial-{:03}-attempt-{:03}.json",index+1,ordinal));
                if !candidate.exists(){break candidate;}ordinal+=1;
            };
            let attempt_bytes=serde_json::to_vec_pretty(&json!({"trial":index+1,"round":row["round"],"attempt":ordinal,
                "invocationAttempt":invocation_attempt,"model":model,"effort":effort,"reviewerContinuity":false,
                "inputSha256":input_hash,"reviewerBinarySha256":reviewer_binary_sha256,"reviewerSourceSha256":reviewer_source_sha256,
                "reviewerOperationElapsedMs":started.elapsed().as_millis(),"transportError":outcome.as_ref().err(),
                "rawReviewerOutput":text.lock().unwrap().clone(),
                "scope":"Untimed independent grader operation, not a candidate answer execution or latency trial. Exact grader output and transport failures remain preserved. Only timeout failures can retry, using identical explicit input and fresh review history; completed judgments are never overwritten."})).map_err(|e|e.to_string())?;
            let mut attempt_output=std::fs::OpenOptions::new().write(true).create_new(true).open(&attempt_file).map_err(|e|e.to_string())?;
            attempt_output.write_all(&attempt_bytes).map_err(|e|e.to_string())?;
            attempt_records.push(json!({"file":attempt_file,"sha256":format!("{:x}",Sha256::digest(&attempt_bytes))}));
            match outcome {
                Ok(())=>break,
                Err(error)=>{
                    if invocation_attempt==3||!error.to_lowercase().contains("timed out"){return Err(error);}
                    println!("Preserved reviewer timeout for trial {}, attempt {}; retrying the same recorded input",index+1,ordinal);
                }
            }
        }
        let review:Value=serde_json::from_str(&text.lock().unwrap()).map_err(|e|e.to_string())?;
        if let Some(phrase)=review["usefulPhrase"].as_str(){
            if phrase.is_empty()||!row["answer"].as_str().unwrap_or("").contains(phrase){return Err(format!("Trial {} reviewer returned a nonliteral phrase",index+1));}
        }
        let bytes=serde_json::to_vec_pretty(&json!({"trial":index+1,"round":row["round"],"model":model,"effort":effort,"inputSha256":input_hash,"inputSchemaVersion":3,"reviewerContinuity":false,"reviewerBinarySha256":reviewer_binary_sha256,"reviewerSourceSha256":reviewer_source_sha256,"reviewerAttempts":attempt_records,
            "scope":"Independent model review and phrase selection, provisional until substantive checks. Reviewer had no tools, examiner grades or timing, and no reused native review-thread history. Only the explicit bound input and source history were supplied.","review":review})).map_err(|e|e.to_string())?;
        let mut output=std::fs::OpenOptions::new().write(true).create_new(true).open(&file).map_err(|e|e.to_string())?;
        output.write_all(&bytes).map_err(|e|e.to_string())?;
        println!("Recorded independent review {}: {}",index+1,review["verdict"]);
    }
    Ok(())
}
