//! Recording-only comparison of the existing final-question backend paths.
//! This does not exercise ASR, live steering, capture or the visible overlay.
use meeting_copilot_core::{openai::{auth::Auth, client::{AnswerBackend, Client, StreamEvent}, codex::{Codex, QuestionPrompt, QuestionUpdate, RefillPolicy}, prompts, timing::Trace}, storage::db::Database};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::OpenOptions, io::Write, path::{Component, PathBuf}, sync::{Arc, Mutex}, time::{Duration,Instant}};
use tokio_util::sync::CancellationToken;

fn save(file: &std::path::Path, value: &Value) -> Result<(), String> {
    let mut out=OpenOptions::new().write(true).create_new(true).open(file).map_err(|e|e.to_string())?;
    out.write_all(&serde_json::to_vec_pretty(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}

#[tokio::main]
async fn main()->Result<(),String>{
    if std::env::var("COPILOT_ACCEPTANCE").as_deref()==Ok("1") {
        return Err("Use normal saved ChatGPT authentication, without acceptance credential fixtures".into());
    }
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize().map_err(|e|e.to_string())?;
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    if args.len()!=2{return Err("CASE_MANIFEST OUTPUT_DIRECTORY".into());}
    let source=PathBuf::from(&args[0]).canonicalize().map_err(|e|e.to_string())?;
    let dir=root.join(&args[1]);
    if !source.starts_with(&root)||!dir.starts_with(&root)||dir.components().any(|c|c==Component::ParentDir){return Err("Keep inputs and evidence inside the workspace".into());}
    if dir.exists(){return Err("Refusing to overwrite backend comparison evidence".into());}
    std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    if !dir.canonicalize().map_err(|e|e.to_string())?.starts_with(&root){return Err("Output resolves outside workspace".into());}
    let bytes=std::fs::read(&source).map_err(|e|e.to_string())?;
    let manifest:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
    let model=manifest["model"].as_str().ok_or("Missing explicit model")?;
    let effort=manifest["effort"].as_str().ok_or("Missing explicit effort")?;
    let tier=manifest["serviceTier"].as_str();
    let repetitions=manifest["repetitions"].as_u64().ok_or("Missing repetition count")?;
    if !(1..=3).contains(&repetitions){return Err("Choose 1 through 3 recorded repetitions".into());}
    let observation_budget=manifest["requestObservationBudgetMs"].as_u64().filter(|ms|*ms>0).ok_or("Missing positive experiment observation budget")?;
    let cleanup_budget=manifest["cleanupObservationBudgetMs"].as_u64().filter(|ms|*ms>0).ok_or("Missing positive experiment cleanup budget")?;
    let cases=manifest["cases"].as_array().ok_or("Missing public replay cases")?;
    let binary=std::env::current_exe().map_err(|e|e.to_string())?;
    let sha=|bytes:&[u8]|format!("{:x}",Sha256::digest(bytes));
    save(&dir.join("execution-provenance.json"),&json!({
        "comparisonBinarySha256":sha(&std::fs::read(binary).map_err(|e|e.to_string())?),
        "comparisonSourceSha256":sha(include_bytes!("compare-answer-backends.rs")),
        "manifestSha256":sha(&bytes),
        "compiledSourceHashes":{
            "src-tauri/src/openai/client.rs":sha(include_bytes!("../src/openai/client.rs")),
            "src-tauri/src/openai/codex.rs":sha(include_bytes!("../src/openai/codex.rs")),
            "src-tauri/src/openai/auth.rs":sha(include_bytes!("../src/openai/auth.rs")),
            "src-tauri/src/openai/prompts.rs":sha(include_bytes!("../src/openai/prompts.rs"))
        },
        "model":model,"effort":effort,"requestedServiceTier":tier,
        "requestObservationBudgetMs":observation_budget,"cleanupObservationBudgetMs":cleanup_budget,
        "normalSavedAuthentication":true,"codexContinuity":false,
        "scope":"Actual executable and compile-time source bindings, recorded before model access or inference. No credential values are recorded."
    }))?;
    let auth=Arc::new(Auth::new(Arc::new(Database::open(&dir.join("comparison.sqlite"))?))?);
    let accounts=auth.accounts().await;
    let chat=Client::default().with_backend(AnswerBackend::Chatgpt,tier).with_reasoning(Some(effort));
    let preflight=async {
        let account=accounts.iter().find(|a|a.plan_enabled).ok_or("No saved ChatGPT-plan account with direct-inference scope")?;
        auth.select(&account.client_id).await?;
        let token=auth.token().await?;
        // Token refresh is allowed to finish and persist normally; only the
        // subsequent read-only catalog request has an observation window.
        let catalog=tokio::time::timeout(Duration::from_millis(observation_budget),chat.models(&token)).await
            .map_err(|_|"Experiment catalog observation budget exhausted".to_owned())??;
        Ok::<_,String>(catalog)
    }.await;
    let preflight_record=match &preflight {
        Ok(catalog)=>json!({"status":if catalog.iter().any(|m|m.slug==model){"available"}else{"requested_model_unavailable"},"requestedModel":model,"requestedEffort":effort,"requestedServiceTier":tier,"savedAccounts":accounts.len(),"availableModelIds":catalog.iter().map(|m|&m.slug).collect::<Vec<_>>() }),
        Err(error)=>json!({"status":"unavailable","requestedModel":model,"savedAccounts":accounts.len(),"error":error,"catalogObservationBudgetMs":observation_budget}),
    };
    save(&dir.join("chatgpt-preflight.json"),&preflight_record)?;
    let catalog=match preflight{Ok(catalog)=>catalog,Err(_)=>{auth.begin_shutdown();auth.wait_for_token_requests().await;println!("ChatGPT access unavailable; preflight evidence recorded");return Ok(());}};
    if !catalog.iter().any(|m|m.slug==model){auth.begin_shutdown();auth.wait_for_token_requests().await;println!("Requested model absent from ChatGPT catalog; no substitution");return Ok(());}
    let codex=Codex::new(root.join(".local/codex/codex.exe"),root.join(".local/backend-comparison/work"));
    // Each final-prompt diagnostic receives only its captured explicit context.
    codex.set_continuity(false);
    let instructions=prompts::answer_instructions(prompts::ANSWER);
    let cancel=CancellationToken::new();
    let mut native=Client::default().with_backend(AnswerBackend::Codex,tier).with_reasoning(Some(effort));
    native.codex=Some(codex.clone());
    let result=async {
        if !codex.models().await?.iter().any(|m|m.slug==model){return Err("Requested model unavailable through Codex".into());}
        codex.prewarm(model,tier,Some(effort),&instructions,&cancel).await?;
        for repetition in 0..repetitions {
            for (index,case) in cases.iter().enumerate(){
                let context=case["selectedContext"].as_str().ok_or("Missing actual public context")?;
                let question=case["recognizedQuestion"].as_str().ok_or("Missing final recognized question")?;
                let prompt=QuestionPrompt::new(context,question);
                let input_hash=format!("{:x}",Sha256::digest(prompt.render().as_bytes()));
                let order=if (index as u64+repetition)%2==0{[AnswerBackend::Codex,AnswerBackend::Chatgpt]}else{[AnswerBackend::Chatgpt,AnswerBackend::Codex]};
                for backend in order {
                    let name=if backend==AnswerBackend::Codex{"codex"}else{"chatgpt"};
                    // Preparation stays outside request timing, as in startup.
                    // Disabled background refill must not exhaust the pool.
                    if backend==AnswerBackend::Codex{codex.prewarm(model,tier,Some(effort),&instructions,&cancel).await?;}
                    let token=if backend==AnswerBackend::Chatgpt{auth.token().await?}else{String::new()};
                    let client=if backend==AnswerBackend::Codex{native.clone()}else{chat.clone()};
                    let clock=Instant::now();let trace=Trace::new(clock,0);
                    let client=client.with_trace(trace.clone()).with_refill(RefillPolicy::Disabled);
                    let observed=Arc::new(Mutex::new((String::new(),None::<u128>,None::<u128>,Vec::<Value>::new())));
                    let sink=observed.clone();
                    let (_updates_tx,updates)=tokio::sync::watch::channel(QuestionUpdate{question:question.into(),confirmed:true,context:Some(context.into()),acoustic_quiet:true});
                    let trial_cancel=cancel.child_token();
                    let request=client.stream_question(&token,model,&instructions,&prompt,None,trial_cancel.clone(),updates,move|event|{
                        let mut state=sink.lock().unwrap();
                        match event {
                            StreamEvent::Revision(text)=>{state.3.push(json!({"atMs":clock.elapsed().as_millis(),"revision":text}));state.0=text;state.1=None;state.2=None;},
                            StreamEvent::Delta(text)|StreamEvent::QuestionDelta{text,..}=>{
                                if !text.is_empty(){state.1.get_or_insert(clock.elapsed().as_millis());}
                                state.3.push(json!({"atMs":clock.elapsed().as_millis(),"delta":text}));
                                state.0.push_str(&text);
                                let mut word_started=false;
                                let complete=state.0.chars().any(|ch|{
                                    if !word_started{word_started=ch.is_alphanumeric();false}
                                    else{!ch.is_alphanumeric()&&!matches!(ch,'_'|'\''|'’'|'-')}
                                });
                                if complete{state.2.get_or_insert(clock.elapsed().as_millis());}
                            },_=>{}
                        }
                        std::future::ready(Ok(()))
                    });
                    tokio::pin!(request);
                    let mut observation_exhausted=false;let mut cleanup_exhausted=false;let mut observation_end=None;
                    let mut observation_snapshot=None;
                    let answer=tokio::select! {
                        result=&mut request=>result,
                        _=tokio::time::sleep(Duration::from_millis(observation_budget))=>{
                            observation_exhausted=true;observation_end=Some(clock.elapsed().as_millis());
                            {let state=observed.lock().unwrap();observation_snapshot=Some((state.0.clone(),state.3.len()));}
                            trial_cancel.cancel();
                            match tokio::time::timeout(Duration::from_millis(cleanup_budget),&mut request).await {
                                Ok(_)=>Err("Experiment request observation budget exhausted".to_owned()),
                                Err(_)=>{
                                    cleanup_exhausted=true;
                                    // A dropped native request must not leave an
                                    // old thread in the next diagnostic case.
                                    if backend==AnswerBackend::Codex{codex.close();}
                                    Err("Experiment request observation and cleanup budgets exhausted".to_owned())
                                }
                            }
                        }
                    };
                    let observation_end=observation_end.unwrap_or_else(||clock.elapsed().as_millis());
                    let error_origin=if observation_exhausted{Some("experiment_observation_limit")}else if answer.is_err(){Some("backend")}else{None};
                    let state=observed.lock().unwrap();
                    let observed_answer=observation_snapshot.as_ref().map(|snapshot|&snapshot.0).unwrap_or(&state.0);
                    let observed_event_count=observation_snapshot.as_ref().map(|snapshot|snapshot.1).unwrap_or(state.3.len());
                    let record=json!({"backend":name,"repetition":repetition+1,"case":index+1,"model":model,"effort":effort,"serviceTier":tier,"codexContinuity":false,"source":case,"inputSha256":input_hash,"answer":observed_answer,"answerAfterCleanup":state.0,"firstDecodedDeltaMs":state.1,"firstCompleteWordFromRequestMs":state.2,"streamEvents":state.3,"streamEventsBeforeObservationEnd":observed_event_count,"elapsedMs":clock.elapsed().as_millis(),"requestObservationEndMs":observation_end,"requestObservationBudgetMs":observation_budget,"cleanupObservationBudgetMs":cleanup_budget,"observationBudgetExhausted":observation_exhausted,"cleanupBudgetExhausted":cleanup_exhausted,"errorOrigin":error_origin,"error":answer.err(),"pipeline":trace.snapshot(),"scope":"Same final recognized question and actual selected public context, through each existing backend path, with fresh Codex thread history. Thread preparation and token retrieval occur before the request clock. No ASR, overlay, live steering or human speech. Experiment observation censoring and cleanup are explicitly separate from backend errors and normal completion. Grading uses the answer captured at observation end; raw cleanup output and callbacks remain separately recorded. Codex native automatic intent/protocol handling and ChatGPT HTTP handling differ; accuracy requires deferred independent assessment."});
                    save(&dir.join(format!("repeat-{}-case-{:02}-{name}.json",repetition+1,index+1)),&record)?;
                    println!("Recorded {name}, repetition {}, case {}",repetition+1,index+1);
                }
            }
        }
        save(&dir.join("complete.json"),&json!({"status":"complete","manifestSha256":format!("{:x}",Sha256::digest(&bytes)),"cases":cases.len(),"repetitions":repetitions,"independentAccuracyPending":true,"endToEndAudioComparison":false}))
    }.await;
    codex.close();auth.begin_shutdown();auth.wait_for_token_requests().await;result
}
