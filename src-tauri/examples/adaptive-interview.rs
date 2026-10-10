//! Opt-in signed-in Codex benchmark. Stores local prompts/answers, never auth.
use meeting_copilot_core::openai::{codex::{Codex, RefillPolicy}, client::StreamEvent, prompts, timing::Trace};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, Mutex}, time::Instant};
use tokio_util::sync::CancellationToken;

fn spoken_sentence_ready(text:&str,final_:bool)->bool {
    let prose=text.split("```").next().unwrap_or("");
    if prose.chars().count()<25{return false;}
    let mut inline_code=false;
    let chars=prose.chars().collect::<Vec<_>>();
    for (i,c) in chars.iter().enumerate() {
        if *c=='`'{inline_code=!inline_code;continue;}
        if !inline_code && ['.','!','?'].contains(c) && i>=20
            && chars.get(i+1).map_or(final_,|next|next.is_whitespace()) {
            let prefix=chars[..=i].iter().collect::<String>();
            if !["e.g.","i.e.","etc."].iter().any(|ending|prefix.ends_with(ending)){return true;}
        }
    }
    false
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let binary=root.join(".local/codex/codex.exe");
    let codex=Codex::new(binary,root.join(".local/cuda-interview/work"));
    codex.set_continuity(std::env::var("COPILOT_INTERVIEW_CONTINUITY").as_deref()!=Ok("false"));
    let result=run(&codex,&root).await;
    codex.close();
    result
}
async fn run(codex:&Arc<Codex>,root:&std::path::Path)->Result<(),String> {
    if codex.account().await?.is_none(){return Err("Sign in to Codex before running the interview".into());}
    if std::env::args().any(|a|a=="--rate-limits") {
        let limits=codex.rate_limits().await?;
        let buckets=limits["rateLimitsByLimitId"].as_object().map(|map|map.values().collect::<Vec<_>>()).unwrap_or_else(||vec![&limits["rateLimits"]]);
        for bucket in buckets{println!("{}",json!({"limitId":bucket["limitId"],"primary":bucket["primary"],"secondary":bucket["secondary"],"reached":bucket["rateLimitReachedType"]}));}
        return Ok(());
    }
    let models=codex.models().await?;
    println!("Available signed-in models: {}",models.iter().map(|m|m.slug.as_str()).collect::<Vec<_>>().join(", "));
    if std::env::args().any(|a|a=="--catalog"){
        let catalog=codex.model_catalog().await?;
        for model in catalog["data"].as_array().ok_or("No model catalog")? {
            println!("{}",json!({"model":model["model"],"supportedReasoningEfforts":model["supportedReasoningEfforts"],"defaultReasoningEffort":model["defaultReasoningEffort"],"serviceTiers":model["serviceTiers"],"defaultServiceTier":model["defaultServiceTier"]}));
        }
        return Ok(());
    }
    if std::env::args().any(|a|a=="--check-examiner"){return check_examiner(codex,root).await;}
    let arguments=std::env::args().collect::<Vec<_>>();
    if let Some(index)=arguments.iter().position(|a|a=="--generate-scenario") {
        return generate_scenario(codex,std::path::Path::new(arguments.get(index+1).ok_or("Scenario request path is missing")?)).await;
    }
    if let Some(index)=arguments.iter().position(|a|a=="--generate-burst") {
        return generate_burst(codex,std::path::Path::new(arguments.get(index+1).ok_or("Burst request path is missing")?)).await;
    }
    if let Some(index)=arguments.iter().position(|a|a=="--grade-request") {
        return grade_request(codex,std::path::Path::new(arguments.get(index+1).ok_or("Grade request path is missing")?)).await;
    }
    // Fixtures are supplied only to the examiner. The answering model sees
    // actual questions and previous answers, never a rubric or expected answer.
    let scenario=match (std::env::var("COPILOT_INTERVIEW_SUITE"),std::env::var("COPILOT_INTERVIEW_CASE")){
        (Ok(path),Ok(name))=>{
            let suite:Value=serde_json::from_str(&std::fs::read_to_string(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            serde_json::to_string(suite["cases"].as_array().ok_or("Suite needs cases")?.iter().find(|case|case["name"].as_str()==Some(&name)).ok_or("Suite case not found")?).map_err(|e|e.to_string())?
        }
        _=>match std::env::var("COPILOT_INTERVIEW_SCENARIO"){
        Ok(path)=>std::fs::read_to_string(path).map_err(|e|e.to_string())?,
        Err(_)=>include_str!("../../tests/fixtures/cuda-interview.json").to_string(),
        },
    };
    let scenario:Value=serde_json::from_str(&scenario).map_err(|e|e.to_string())?;
    let scenario_name=scenario["name"].as_str().filter(|s|!s.is_empty()&&s.chars().all(|c|c.is_ascii_alphanumeric()||c=='-')).ok_or("Scenario needs a simple name")?;
    let model=std::env::var("COPILOT_INTERVIEW_MODEL").unwrap_or("gpt-6.1-sol".into());
    let effort=std::env::var("COPILOT_INTERVIEW_EFFORT").unwrap_or("low".into());
    let examiner_model=std::env::var("COPILOT_INTERVIEW_EXAMINER_MODEL").unwrap_or("gpt-6.1-sol".into());
    let examiner_effort=std::env::var("COPILOT_INTERVIEW_EXAMINER_EFFORT").unwrap_or("low".into());
    let rounds=std::env::var("COPILOT_INTERVIEW_ROUNDS").ok().and_then(|s|s.parse::<usize>().ok()).unwrap_or(12);
    let instructions=prompts::answer_instructions(prompts::ANSWER);
    let examiner=examiner_instructions(scenario["rubric"].as_str().unwrap_or("Assess technical correctness and increasingly deep reasoning."));
    let schema=examiner_schema();
    let public_context=scenario["candidateContext"].as_str().unwrap_or("INTERVIEWER INTRODUCTION: This is a technical interview. I will present hypothetical systems problems, ask you to analyze them, and keep drilling into your reasoning. Some challenges will be intentionally vague; ask for missing information rather than inventing it.");
    let output=std::env::var("COPILOT_INTERVIEW_OUTPUT").map(PathBuf::from).unwrap_or_else(|_|root.join(".local/cuda-interview"));
    let mode=if std::env::var("COPILOT_INTERVIEW_CONTINUITY").as_deref()==Ok("false"){"fresh"}else{"continuous"};
    let output_file=output.join(format!("{scenario_name}-{model}-{effort}-{mode}.json"));
    std::fs::create_dir_all(&output).map_err(|e|e.to_string())?;
    let configuration=json!({"scenario":scenario,"publicContext":public_context,"instructions":instructions,"answerSchema":meeting_copilot_core::openai::codex::automatic_reply_schema(),"examinerInstructions":examiner,"examinerSchema":schema,"model":model,"effort":effort,"examinerModel":examiner_model,"examinerEffort":examiner_effort,"continuity":mode,"rounds":rounds});
    let mut rows=Vec::<Value>::new();
    let mut startup_runs=Vec::<Value>::new();
    if std::env::var("COPILOT_INTERVIEW_RESUME").as_deref()==Ok("true") && output_file.exists() {
        let saved:Value=serde_json::from_slice(&std::fs::read(&output_file).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        if saved["configuration"]!=configuration{return Err("Checkpoint configuration differs; use a new output directory".into());}
        rows=resume_rows(&saved)?;
        startup_runs=saved["startupRuns"].as_array().cloned().unwrap_or_default();
        println!("Resuming {} saved answers, {} already reviewed",rows.len(),rows.iter().filter(|row|row["review"].is_object()).count());
    }
    let startup_clock=Instant::now();
    codex.prewarm(&model,Some("fast"),Some(&effort),&instructions,&CancellationToken::new()).await?;
    codex.prime(&model,Some("fast"),Some(&effort),&instructions,&CancellationToken::new()).await?;
    let startup_ms=startup_clock.elapsed().as_millis()as u64;
    println!("Startup including real inference warmup: {startup_ms} ms");
    startup_runs.push(json!({"ms":startup_ms,"savedAnswers":rows.len()}));
    let mut history=String::new();
    let mut question=scenario["seed"].as_str().ok_or("Scenario needs a seed question")?.to_owned();
    for round in 0..rounds {
        if round>=rows.len() {
        let input=meeting_copilot_core::openai::codex::QuestionPrompt::new(format!("PUBLIC INTERVIEW CONTEXT\n{public_context}\n\nACTUAL INTERVIEW SO FAR\n{history}"),question.clone());
        let clock=Instant::now();
        let trace=Trace::new(clock,0);
        let text=Arc::new(Mutex::new(String::new()));
        let first=Arc::new(Mutex::new(None));
        let word=Arc::new(Mutex::new(meeting_copilot_core::meeting::state::Latency::default()));
        let clause=Arc::new(Mutex::new(None));
        let chunks=Arc::new(Mutex::new(Vec::<Value>::new()));let chunk_sink=chunks.clone();
        let ignored=Arc::new(Mutex::new(false));let ignored_sink=ignored.clone();
        let (_updates,receiver)=tokio::sync::watch::channel(meeting_copilot_core::openai::codex::QuestionUpdate{acoustic_quiet:false,question:question.clone(),confirmed:true,context:None});
        let answer_text=text.clone();let first_time=first.clone();let clause_time=clause.clone();
        let word_time=word.clone();
        let result=codex.stream_question(&model,Some("fast"),Some(&effort),&instructions,&input,None,CancellationToken::new(),RefillPolicy::FirstToken,Some(trace.clone()),receiver,move|event|{
            if let StreamEvent::NoReply{..}=&event{*ignored_sink.lock().unwrap()=true;}
            if let StreamEvent::Revision(replacement)=&event {
                *answer_text.lock().unwrap()=replacement.clone();*first_time.lock().unwrap()=None;*clause_time.lock().unwrap()=None;
                *word_time.lock().unwrap()=Default::default();
                chunk_sink.lock().unwrap().push(json!({"ms":clock.elapsed().as_millis()as u64,"revision":replacement}));
            }
            if let StreamEvent::QuestionDelta{text:delta,..}=event {
                let now=clock.elapsed().as_millis()as u64;
                first_time.lock().unwrap().get_or_insert(now);
                word_time.lock().unwrap().observe_answer_delta(&delta,now);
                chunk_sink.lock().unwrap().push(json!({"ms":now,"delta":delta}));
                let mut text=answer_text.lock().unwrap();text.push_str(&delta);
                // Optional sentence diagnostic; first-word arrival is primary.
                if spoken_sentence_ready(&text,false){clause_time.lock().unwrap().get_or_insert(now);}
            }
            async{Ok(())}
        }).await;
        let answer=text.lock().unwrap().clone();
        if spoken_sentence_ready(&answer,true){clause.lock().unwrap().get_or_insert(clock.elapsed().as_millis()as u64);}
        let first_ms=*first.lock().unwrap();let clause_ms=*clause.lock().unwrap();
        let word_ms=word.lock().unwrap().first_word_at;
        let row=json!({"round":round+1,"question":question,"answer":answer,"ignored":*ignored.lock().unwrap(),"firstWordMs":word_ms,"firstDeltaMs":first_ms,"firstSentenceMs":clause_ms,"completedMs":clock.elapsed().as_millis()as u64,"chunks":chunks.lock().unwrap().clone(),"timing":trace.snapshot(),"error":result.as_ref().err()});
        println!("Round {}: first answer word {:?} ms, first delta {:?} ms, first sentence {:?} ms, {} chars",round+1,word_ms,first_ms,clause_ms,answer.len());
        rows.push(row);
        persist(&output_file,&configuration,&startup_runs,&rows)?;
        result?;
        }
        if rows[round]["question"].as_str()!=Some(question.as_str()){return Err("Checkpoint follow-up sequence is inconsistent".into());}
        let answer=rows[round]["answer"].as_str().ok_or("Saved answer is invalid")?;
        history.push_str(&format!("\nINTERVIEWER: {question}\nSUGGESTED ANSWER (not necessarily correct): {answer}\n"));
        let parsed=if rows[round]["review"].is_object() {rows[round]["review"].clone()} else {
        let judged=Arc::new(Mutex::new(String::new()));let sink=judged.clone();
        codex.stream_json(&examiner_model,Some("fast"),Some(&examiner_effort),&examiner,&format!("EXAMINER-ONLY EVIDENCE (never shown directly to candidate)\n{}\n\nRound {} of {rounds}.\n{history}",scenario["examinerOnly"].as_str().unwrap_or("No predetermined follow-up; generate from the candidate's actual answer."),round+1),&schema,CancellationToken::new(),move|event|{match event{StreamEvent::Delta(delta)=>sink.lock().unwrap().push_str(&delta),StreamEvent::Revision(replacement)=>*sink.lock().unwrap()=replacement,_=>{}}async{Ok(())}}).await?;
        let raw=judged.lock().unwrap().clone();
        let parsed:Value=serde_json::from_str(raw.trim().trim_start_matches("```json").trim_end_matches("```").trim()).map_err(|_|format!("Examiner returned invalid JSON: {raw}"))?;
            rows[round]["review"]=parsed.clone();
            persist(&output_file,&configuration,&startup_runs,&rows)?;
            parsed
        };
        if round+1==rounds{break;}
        question=parsed["question"].as_str().filter(|s|!s.is_empty()).ok_or("Examiner omitted follow-up")?.to_owned();
    }
    persist(&output_file,&configuration,&startup_runs,&rows)?;
    Ok(())
}

fn examiner_instructions(rubric:&str)->String {
    format!("You are an exceptionally rigorous technical interviewer. Perform two separate tasks: grade the latest answer against the CURRENT question, then choose ONE fresh concise next question that tests deeper reasoning or a new hard problem, according to the interview plan. Return JSON only with keys verdict (correct/incorrect/incomplete), issue (specific reason), requiredParts (array of current-question requirements), omissions (array of unanswered current-question requirements), incorrectClaims (array of specific false claims with explanations), question (next question), difficulty (1 to 5), missingInformationHandled (boolean), unsupportedAssumption (boolean), constraintTracking (boolean). Grade only requirements the current question explicitly asks for or logically requires for its answer to be correct. A future deeper probe is not a missing requirement of the current answer. Do not mark an answer incomplete merely because the rubric contains additional topics, because a detail could be explored further, or because the next question will introduce it. Correct answers may leave substantial material for harder follow-ups. Use incomplete only for an identifiable omitted current requirement, and incorrect only for a concrete false claim or erroneous code. An issue must identify that requirement or claim, rather than justify asking another question. Evaluate the algorithm actually supplied, not whether it resembles a preferred implementation. Before alleging an incorrect result, trace its state changes and give a fully specified counterexample with the actual and expected result in incorrectClaims; for a contract violation, identify the exact operation and violated contract. Check that the alleged counterexample really fails. Verify the premise of each follow-up rather than introducing an unsupported assertion as a fact. A precise clarifying question is correct when essential facts are missing. Do not demand an invented diagnosis or unrevealed evidence, and do not demand runtime measurements to analyze fully specified hypothetical code. Reveal hidden evidence incrementally in follow-ups as the candidate requests it. The next question must still be very hard: challenge actual claims with counterexamples, exact code, quantitative derivations, changed constraints, terse references and contradictory new evidence. For technical implementation claims, drill into precise operations, boundaries and proofs rather than remaining at generic operational advice. Keep drilling deeper without repeating the same probe indefinitely. Verify arithmetic carefully. Never use tools. Rubric for choosing future probes, not additional unstated requirements: {rubric}")
}

fn examiner_schema()->Value {
    let strings=json!({"type":"array","items":{"type":"string"}});
    let properties=json!({"verdict":{"type":"string","enum":["correct","incorrect","incomplete"]},"issue":{"type":"string"},"requiredParts":strings,"omissions":strings,"incorrectClaims":strings,"question":{"type":"string"},"difficulty":{"type":"integer","minimum":1,"maximum":5},"missingInformationHandled":{"type":"boolean"},"unsupportedAssumption":{"type":"boolean"},"constraintTracking":{"type":"boolean"}});
    let mut properties=properties;
    for name in ["currentTopic","nextTopic"] {
        properties.as_object_mut().unwrap().insert(name.into(),json!({"type":"string"}));
    }
    let required=properties.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

// Evaluation setup only: no generated scenario or private evidence is bundled
// with the app. The answerer receives only the public question and conversation.
async fn generate_scenario(codex:&Arc<Codex>,path:&std::path::Path)->Result<(),String> {
    let request:Value=serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let brief=request["brief"].as_str().filter(|s|!s.trim().is_empty()).ok_or("Scenario generation needs an interview brief")?;
    let model=std::env::var("COPILOT_INTERVIEW_EXAMINER_MODEL").unwrap_or("gpt-6.1-sol".into());
    let effort=std::env::var("COPILOT_INTERVIEW_EXAMINER_EFFORT").unwrap_or("low".into());
    let instructions="Create a fresh, very hard technical interview scenario from the supplied brief. Return JSON with seed (one concise public opening question), examinerOnly (private hypothetical evidence to reveal incrementally), and rubric (areas for increasingly deep probes). Begin with an underspecified symptom that requires clarification. Prepare a technically consistent hypothetical case with quantitative evidence and exact code challenges for subsequent probes. Do not give the public question an answer or a diagnosis. Avoid assuming unknown device facts. Future questions will be generated from the candidate's actual answers; do not script a fixed sequence. Never use tools.";
    let schema=json!({"type":"object","properties":{"seed":{"type":"string"},"examinerOnly":{"type":"string"},"rubric":{"type":"string"}},"required":["seed","examinerOnly","rubric"],"additionalProperties":false});
    let input=format!("RUN VARIATION IDENTIFIER\n{}\n\nINTERVIEW BRIEF\n{brief}\n\nCreate fresh facts, constraints and challenges for this run. For a broad brief, prepare multiple unrelated problem families across its requested areas, not only one opening case. They are private evidence for adaptive selection, never a fixed question sequence.",request["runId"].as_str().unwrap_or("unspecified"));
    let text=Arc::new(Mutex::new(String::new()));let sink=text.clone();
    codex.stream_json(&model,Some("fast"),Some(&effort),instructions,&input,&schema,CancellationToken::new(),move|event|{match event{StreamEvent::Delta(delta)=>sink.lock().unwrap().push_str(&delta),StreamEvent::Revision(replacement)=>*sink.lock().unwrap()=replacement,_=>{}}async{Ok(())}}).await?;
    let scenario:Value=serde_json::from_str(&text.lock().unwrap()).map_err(|e|format!("Generated scenario JSON is invalid: {e}"))?;
    for field in ["seed","examinerOnly","rubric"] {if !scenario[field].as_str().is_some_and(|s|!s.trim().is_empty()){return Err(format!("Generated scenario has no {field}"));}}
    std::fs::write(path.with_extension("scenario.json"),serde_json::to_vec_pretty(&json!({"scenario":scenario,"model":model,"effort":effort,"instructions":instructions,"schema":schema})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    Ok(())
}

// Offline probe preparation only. Public prompts are generated afresh; no
// topic vocabulary, response bank or benchmark script is loaded by the app.
async fn generate_burst(codex:&Arc<Codex>,path:&std::path::Path)->Result<(),String> {
    let request:Value=serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let count=request["count"].as_u64().filter(|n|(2..=12).contains(n)).ok_or("Burst requires 2-12 questions")?;
    let brief=request["brief"].as_str().filter(|s|!s.trim().is_empty()).ok_or("Burst requires a brief")?;
    let model=std::env::var("COPILOT_INTERVIEW_EXAMINER_MODEL").unwrap_or("gpt-6.1-sol".into());
    let effort=std::env::var("COPILOT_INTERVIEW_EXAMINER_EFFORT").unwrap_or("low".into());
    let instructions="Generate fresh exceptionally difficult rapid-fire interview questions from the brief and public history. Return only the requested JSON. Each question must be spoken naturally and concise (normally 12-40 words), but demand precise reasoning, quantitative derivation, a proof or code. Mix new problems with deeper probes, corrections, changed constraints and terse contextual references. Later questions in this burst may depend on earlier PUBLIC question facts, but must not assume the candidate gave an answer not present in history. Make vague challenges answerable by clarification. Vary domains and constructions instead of repeating a template. Do not supply answers, diagnoses, private facts or a fixed question bank. Future bursts will adapt to the actual answers. Never use tools.";
    let schema=json!({"type":"object","properties":{"questions":{"type":"array","minItems":count,"maxItems":count,"items":{"type":"string"}}},"required":["questions"],"additionalProperties":false});
    let input=serde_json::to_string(&json!({"runId":request["runId"],"brief":brief,"publicHistory":request["history"],"count":count})).map_err(|e|e.to_string())?;
    let text=Arc::new(Mutex::new(String::new()));let sink=text.clone();
    codex.stream_json(&model,Some("fast"),Some(&effort),instructions,&input,&schema,CancellationToken::new(),move|event|{match event{StreamEvent::Delta(delta)=>sink.lock().unwrap().push_str(&delta),StreamEvent::Revision(replacement)=>*sink.lock().unwrap()=replacement,_=>{}}async{Ok(())}}).await?;
    let burst:Value=serde_json::from_str(&text.lock().unwrap()).map_err(|e|format!("Generated burst JSON is invalid: {e}"))?;
    let questions=burst["questions"].as_array().ok_or("Burst has no questions")?;
    if questions.len()!=count as usize||questions.iter().any(|q|!q.as_str().is_some_and(|s|!s.trim().is_empty()&&s.len()<=4000)){return Err("Invalid generated burst question count or text".into());}
    std::fs::write(path.with_extension("burst.json"),serde_json::to_vec_pretty(&json!({"questions":questions,"runId":request["runId"],"model":model,"effort":effort,"instructions":instructions,"schema":schema})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    Ok(())
}

// Used by the native app harness. The actual app supplies its generated answer;
// only this separate examiner receives the private scenario evidence.
async fn grade_request(codex:&Arc<Codex>,path:&std::path::Path)->Result<(),String> {
    let request:Value=serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let scenario=&request["scenario"];
    let history=request["history"].as_str().ok_or("Native grade request needs actual interview history")?;
    let round=request["round"].as_u64().ok_or("Native grade request needs its round")?;
    let model=std::env::var("COPILOT_INTERVIEW_EXAMINER_MODEL").unwrap_or("gpt-6.1-sol".into());
    let effort=std::env::var("COPILOT_INTERVIEW_EXAMINER_EFFORT").unwrap_or("low".into());
    let instructions=format!("{} Include currentTopic and nextTopic as concise descriptive strings for the actual current and next questions, not the entire rubric. Derive these freely from the questions; no fixed topic labels. The current topic is not evidence that other topics in the brief were covered.",examiner_instructions(scenario["rubric"].as_str().ok_or("Native grade request needs a rubric")?));
    let schema=examiner_schema();
    let input=format!("EXAMINER-ONLY EVIDENCE (never shown directly to candidate)\n{}\n\n{}\nRound {round}.\n{history}",scenario["examinerOnly"].as_str().ok_or("Native grade request needs private evidence")?,interview_plan_context(&request));
    let text=Arc::new(Mutex::new(String::new()));let sink=text.clone();
    codex.stream_json(&model,Some("fast"),Some(&effort),&instructions,&input,&schema,CancellationToken::new(),move|event|{match event{StreamEvent::Delta(delta)=>sink.lock().unwrap().push_str(&delta),StreamEvent::Revision(replacement)=>*sink.lock().unwrap()=replacement,_=>{}}async{Ok(())}}).await?;
    let review:Value=serde_json::from_str(&text.lock().unwrap()).map_err(|e|format!("Native examiner JSON is invalid: {e}"))?;
    std::fs::write(path.with_extension("review.json"),serde_json::to_vec_pretty(&json!({"review":review,"model":model,"effort":effort,"instructions":instructions,"schema":schema})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    Ok(())
}

fn interview_plan_context(request:&Value)->String {
    let Some(plan)=request.get("interviewPlan").filter(|value|value.is_object()) else{return String::new();};
    format!("EXAMINER-ONLY INTERVIEW PLAN\n{}\nUse the elapsed duration and full public history to balance deep follow-ups with breadth across the brief. Generate a fresh next question from the actual answer. When a claim has been established, avoid repeatedly changing values in the same solved property; choose an unresolved implementation, proof or new problem family. If the same error recurs despite follow-ups, record the failure and move to a different problem family to assess breadth. Choose fresh problem instances rather than repeating near-identical exercises. Introduce new problems with sufficient public facts or a purposeful clarification request. For spoken delivery, formulate questions in natural verbal language and explicitly name operators, versions, units and boundaries when needed; retain the same technical difficulty and exact implementation or proof requirements. Do not follow a fixed sequence or count a topic as covered merely because the brief names it. This plan chooses future questions only, never extra grading requirements for the current answer.",plan)
}

async fn check_examiner(codex:&Arc<Codex>,root:&std::path::Path)->Result<(),String> {
    let model=std::env::var("COPILOT_INTERVIEW_EXAMINER_MODEL").unwrap_or("gpt-6.1-sol".into());
    let effort=std::env::var("COPILOT_INTERVIEW_EXAMINER_EFFORT").unwrap_or("low".into());
    let instructions=format!("{} In this transport control, include the literal characters \\( and \\) around an expression in your next question, with valid JSON escaping.",examiner_instructions("Probe progressively deeper into asynchronous execution, multiple streams, durable checkpoint ordering, external effects and device portability. These are future probes, not unstated requirements of a current answer."));
    let schema=examiner_schema();
    let mut rows=Vec::new();
    for (question,answer,expected) in [
        ("What is 2+2?","4.","correct"),
        ("What signal establishes completed GPU work: successful host enqueue, or successful GPU completion?","Successful host enqueue only establishes submission. Wait for successful GPU completion before considering the work complete.","correct"),
        ("A component suddenly becomes x. What should we do?","What does x mean here—what observable behavior changed?","correct"),
        ("Sort [9,1,4] in ascending order.","[9,4,1]","incorrect"),
        ("Thirteen active warp lanes 0 through 12 each have one initialized value. All execute synchronized shuffles with mask 0x1fff. Does the following return their exact sum in lane 0? Explain: for d in {8,4,2,1}, every lane gets y from lane+d using width32, then adds y only if lane+d<13; each stage reads the values from before that stage.","Yes, for exact addition. The consumed source exists whenever lane+d<13. At successive stages lane0 includes original indices {0,8}, {0,4,8,12}, {0,2,4,6,8,10,12}, then all indices0 through12 exactly once. All13 lanes execute every shuffle with the same mask; out-of-range shuffle results are not consumed.","correct"),
        ("Thirteen active lanes each hold 1. For offsets8,4,2,1, every lane shuffles from lane+d and adds that result when lane<8. Is lane0 guaranteed to sum exactly13 initialized inputs?","Yes. Every consumed source is active, so the sum is always13.","incorrect"),
    ] {
        let text=Arc::new(Mutex::new(String::new()));let sink=text.clone();
        codex.stream_json(&model,Some("fast"),Some(&effort),&instructions,&format!("CURRENT QUESTION\n{question}\nCANDIDATE ANSWER\n{answer}"),&schema,CancellationToken::new(),move|event|{match event{StreamEvent::Delta(delta)=>sink.lock().unwrap().push_str(&delta),StreamEvent::Revision(replacement)=>*sink.lock().unwrap()=replacement,_=>{}}async{Ok(())}}).await?;
        let raw=text.lock().unwrap().clone();
        let review:Value=serde_json::from_str(raw.trim().trim_start_matches("```json").trim_end_matches("```").trim()).map_err(|_|"Examiner check returned invalid JSON".to_string())?;
        let passed=review["verdict"].as_str()==Some(expected) && review["question"].as_str().is_some_and(|question|question.contains("\\(")&&question.contains("\\)"));
        println!("Examiner scope check: expected {expected}, received {}, passed={passed}",review["verdict"]);
        rows.push(json!({"question":question,"answer":answer,"expected":expected,"passed":passed,"review":review}));
    }
    let passed=rows.iter().all(|row|row["passed"]==true);
    let directory=root.join("artifacts/adaptive-interview");std::fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    std::fs::write(directory.join("examiner-scope-check-luna-v4.json"),serde_json::to_vec_pretty(&json!({"model":model,"effort":effort,"instructions":instructions,"schema":schema,"passed":passed,"rows":rows})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if passed{Ok(())}else{Err("Examiner scope check failed; do not treat its suite verdicts as reliable accuracy evidence".into())}
}

fn persist(path:&std::path::Path,configuration:&Value,startup_runs:&[Value],rows:&[Value])->Result<(),String> {
    let value=json!({"version":3,"configuration":configuration,"startupRuns":startup_runs,"transport":"signed-in Codex","measurement":"text-only; no ASR, audio, or rendered visibility","primaryLatencyMetric":"firstWordMs: receipt of first alphanumeric answer character, without waiting for word or sentence completion","rows":rows});
    let temporary=path.with_extension("json.tmp");
    std::fs::write(&temporary,serde_json::to_vec_pretty(&value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    std::fs::rename(temporary,path).map_err(|e|e.to_string())
}
fn resume_rows(saved:&Value)->Result<Vec<Value>,String> {
    let mut rows=saved["rows"].as_array().ok_or("Checkpoint needs rows")?.clone();
    if let Some(index)=rows.iter().position(|row|!row["error"].is_null()) {rows.truncate(index);}
    for (i,row) in rows.iter().enumerate() {
        if row["round"].as_u64()!=Some(i as u64+1)||!row["question"].is_string()||!row["answer"].is_string(){return Err("Checkpoint rows are invalid or out of order".into());}
        if i+1<rows.len()&&!row["review"].is_object(){return Err("Checkpoint has an unreviewed answer before a later turn".into());}
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoint_preserves_an_answer_waiting_for_review_and_retries_only_failure() {
        let saved=json!({"rows":[
            {"round":1,"question":"Q1","answer":"A1","error":null,"review":{"question":"Q2","verdict":"correct"}},
            {"round":2,"question":"Q2","answer":"A2","error":null},
            {"round":3,"question":"Q3","answer":"","error":"usage limit"}
        ]});
        let resumed=resume_rows(&saved).unwrap();assert_eq!(resumed.len(),2);
        assert_eq!(resumed[1]["answer"],"A2");assert!(resumed[1]["review"].is_null());
        let corrupt=json!({"rows":[{"round":2,"question":"Q2","answer":"A2"}]});
        assert!(resume_rows(&corrupt).is_err());
    }
    #[test]
    fn measures_prose_instead_of_code_names_or_decimals() {
        for text in ["Use the original `blockDim.x`", "The floating point error is 0.01", "```cuda\nfloat x = 1.0;\n```", "Start with the barrier, e.g.","The floating point error is 0."]{assert!(!spoken_sentence_ready(text,false),"{text}");}
        assert!(spoken_sentence_ready("All threads must reach the block barrier.",true));
        assert!(spoken_sentence_ready("The exact result of this sum is 5. Next",false));
    }
}
