//! Untimed diagnostic of the unchanged request that failed in comparison.
use meeting_copilot_core::{openai::{auth::Auth,client, codex::QuestionPrompt,prompts},storage::db::Database};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{io::Write,path::{Component,PathBuf},sync::Arc,time::Duration};
fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn save(file:&std::path::Path,value:&Value)->Result<(),String>{
    let mut output=std::fs::OpenOptions::new().write(true).create_new(true).open(file).map_err(|e|e.to_string())?;
    output.write_all(&serde_json::to_vec_pretty(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}
fn redacted(value:&Value,token:&str)->Value{
    match value{
        Value::String(text)=>Value::String(text.replace(token,"[REDACTED CREDENTIAL]").chars().take(4000).collect()),
        Value::Array(values)=>Value::Array(values.iter().map(|item|redacted(item,token)).collect()),
        Value::Object(values)=>Value::Object(values.iter().filter(|(key,_)|!matches!(key.as_str(),"input"|"authorization"|"access_token"|"refresh_token"|"id_token"))
            .map(|(key,value)|(key.clone(),redacted(value,token))).collect()),
        _=>value.clone(),
    }
}
#[tokio::main]
async fn main()->Result<(),String>{
    if std::env::var("COPILOT_ACCEPTANCE").as_deref()==Ok("1"){return Err("Normal saved authentication required".into());}
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize().map_err(|e|e.to_string())?;
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    let omit_tier=args.get(2).map(String::as_str)==Some("--omit-service-tier");
    if args.len()!=2&&!(args.len()==3&&omit_tier){return Err("MANIFEST OUTPUT_DIRECTORY [--omit-service-tier]".into());}
    let input=PathBuf::from(&args[0]).canonicalize().map_err(|e|e.to_string())?;
    let directory=root.join(&args[1]);
    if !input.starts_with(&root)||!directory.starts_with(&root)||directory.components().any(|c|c==Component::ParentDir){return Err("Keep diagnostic inputs and output inside workspace".into());}
    if directory.exists(){return Err("Preserve the existing diagnostic evidence".into());}
    std::fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    if !directory.canonicalize().map_err(|e|e.to_string())?.starts_with(&root){return Err("Diagnostic output resolves outside workspace".into());}
    let bytes=std::fs::read(&input).map_err(|e|e.to_string())?;
    let manifest:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
    let model=manifest["model"].as_str().ok_or("Missing model")?;
    let effort=manifest["effort"].as_str().ok_or("Missing effort")?;
    let case=manifest["cases"][0].clone();
    let prompt=QuestionPrompt::new(case["selectedContext"].as_str().ok_or("Missing captured context")?,case["recognizedQuestion"].as_str().ok_or("Missing captured question")?);
    let rendered=prompt.render();
    let instructions=prompts::answer_instructions(prompts::ANSWER);
    let mut body=client::request_body_with_image(model,&instructions,&rendered,None);
    body["reasoning"]=json!({"effort":effort});
    if !omit_tier{if let Some(tier)=manifest["serviceTier"].as_str(){body["service_tier"]=json!(tier);}}
    // Normal Client::default uses this literal when acceptance mode is off.
    let source=include_str!("../src/openai/client.rs");
    if !source.contains("\"https://api.openai.com/v1\".into()"){return Err("Recheck the unchanged production endpoint".into());}
    let endpoint="https://api.openai.com/v1/responses";
    save(&directory.join("request-provenance.json"),&json!({"manifestSha256":hash(&bytes),"inputSha256":hash(rendered.as_bytes()),
        "requestBodySha256":hash(&serde_json::to_vec(&body).map_err(|e|e.to_string())?),"sourceCase":case,
        "model":model,"effort":effort,"requestedServiceTier":body.get("service_tier"),"endpoint":endpoint,
        "onlyConfigurationChange":if omit_tier{Some("optional service_tier omitted")}else{None},
        "compiledClientSourceSha256":hash(source.as_bytes()),"diagnosticSourceSha256":hash(include_bytes!("diagnose-chatgpt-response.rs")),
        "diagnosticBinarySha256":hash(&std::fs::read(std::env::current_exe().map_err(|e|e.to_string())?).map_err(|e|e.to_string())?),
        "scope":"Untimed diagnostic of the same captured final-question request. The optional service-tier omission, when requested, is explicitly recorded. Model, effort, prompt and production transport code are unchanged. Credential values are excluded."}))?;
    let auth=Arc::new(Auth::new(Arc::new(Database::open(&directory.join("diagnostic.sqlite"))?))?);
    let result=async{
        let accounts=auth.accounts().await;
        let account=accounts.iter().find(|account|account.plan_enabled).ok_or("No saved direct-inference plan account")?;
        auth.select(&account.client_id).await?;
        let token=auth.token().await?;
        if token.is_empty(){return Err("Empty credential".into());}
        let http=client::Client::default().http;
        let budget=manifest["requestObservationBudgetMs"].as_u64().filter(|ms|*ms>0).ok_or("Missing diagnostic observation budget")?;
        let response=tokio::time::timeout(Duration::from_millis(budget),http.post(endpoint).bearer_auth(&token).json(&body).send()).await
            .map_err(|_|"Diagnostic observation budget exhausted".to_owned())?.map_err(|_|"Diagnostic HTTP connection failed".to_owned())?;
        let status=response.status();
        let content_type=response.headers().get("content-type").and_then(|value|value.to_str().ok()).map(str::to_owned);
        let request_id=response.headers().get("x-request-id").and_then(|value|value.to_str().ok()).map(str::to_owned);
        let mut report=json!({"httpStatus":status.as_u16(),"responseSuccess":status.is_success(),"contentType":content_type,"requestId":request_id,
            "requestUnchanged":!omit_tier,"optionalServiceTierOmitted":omit_tier,"diagnosticOnly":true,"scope":"Actual response status and sanitized error details, not a replacement performance trial. The original comparison failures remain unchanged."});
        if !status.is_success(){
            let raw=tokio::time::timeout(Duration::from_millis(budget),response.bytes()).await.map_err(|_|"Diagnostic error-body observation budget exhausted".to_owned())?
                .map_err(|_|"Diagnostic error-body read failed".to_owned())?;
            report["errorBodyBytes"]=json!(raw.len());report["errorBodySha256"]=json!(hash(&raw));
            if let Ok(value)=serde_json::from_slice::<Value>(&raw){
                report["topLevelKeys"]=json!(value.as_object().map(|object|object.keys().collect::<Vec<_>>()));
                report["sanitizedErrorDetails"]=redacted(&value,&token);
            }else{
                report["sanitizedErrorText"]=redacted(&json!(String::from_utf8_lossy(&raw)),&token);
            }
        }
        save(&directory.join("response-diagnostic.json"),&report)?;
        println!("Recorded untimed ChatGPT diagnostic: HTTP {}",status.as_u16());
        Ok(())
    }.await;
    auth.begin_shutdown();auth.wait_for_token_requests().await;result
}
