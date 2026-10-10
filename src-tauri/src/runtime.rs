use crate::{
    audio,
    meeting::{
        self,
        state::{CurrentQuestion, Engine, Latency, Snapshot},
        InputEvent, SpeakerSource,
    },
    openai::{
        auth::{Account, Auth},
        client::{AnswerBackend, Client, Model, StreamEvent},
        prompts,
    },
    overlay::window,
    storage::db::Database,
    transcription,
};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpeechBackend { #[default] Nemotron, Whisper }
fn default_chunk() -> u32 { 160 }
fn default_gpu() -> u32 { 1 }
fn default_reasoning() -> Option<String> { Some("low".into()) }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub microphone: String,
    pub output: String,
    pub model_path: String,
    #[serde(default)]
    pub speech_backend: SpeechBackend,
    #[serde(default = "default_chunk")]
    pub speech_chunk_ms: u32,
    #[serde(default)]
    pub nemotron_runtime: String,
    #[serde(default = "default_gpu")]
    pub nemotron_device: u32,
    #[serde(default)]
    pub nemotron_device_name: Option<String>,
    pub model: String,
    #[serde(default = "default_reasoning")]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub answer_backend: AnswerBackend,
    #[serde(default)]
    pub service_tier: Option<String>,
    #[serde(default)]
    pub codex_refill_policy: crate::openai::codex::RefillPolicy,
    #[serde(default)]
    pub project_path: String,
}
impl Default for Settings {
    fn default() -> Self { Self { microphone:String::new(),output:String::new(),model_path:String::new(),model:String::new(),reasoning_effort:Some("low".into()),answer_backend:AnswerBackend::Codex,service_tier:Some("fast".into()),codex_refill_policy:Default::default(),project_path:String::new(),speech_backend:SpeechBackend::Nemotron,speech_chunk_ms:160,nemotron_runtime:String::new(),nemotron_device:1,nemotron_device_name:None } }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    settings: Settings,
    devices: Vec<audio::AudioDevice>,
    speech_devices: Vec<transcription::nemotron::Device>,
    speech_device_error: Option<String>,
    accounts: Vec<Account>,
    selected: Option<Account>,
    models: Vec<Model>,
    snapshot: Snapshot,
    debug: bool,
    shortcut_errors: Vec<String>,
    connection_error: Option<String>,
}
struct Pipeline {
    capture: audio::Capture,
    transcription: SpeechPipeline,
}
enum SpeechPipeline { Whisper(transcription::Transcription), Nemotron(transcription::nemotron::Streaming) }
impl SpeechPipeline { fn stop(&mut self) { match self {Self::Whisper(p)=>p.stop(),Self::Nemotron(p)=>p.stop()} } }
#[derive(Clone)]
enum SpeechModel { Whisper(Arc<whisper_rs::WhisperContext>), Nemotron(Arc<transcription::nemotron::Service>) }
impl Pipeline {
    fn stop(&mut self) {
        self.capture.stop();
        self.transcription.stop();
    }
}
impl Drop for Pipeline {
    fn drop(&mut self) {
        self.stop();
    }
}
struct Session {
    id: String,
    clock: Instant,
    settings: Settings,
    model: SpeechModel,
    pipeline: Option<Pipeline>,
    intent: Option<meeting::intent::Classifier>,
}
enum Control {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    Protection(bool, oneshot::Sender<()>),
    #[cfg(all(feature = "acceptance", debug_assertions))]
    Inject(InputEvent, oneshot::Sender<u64>),
    #[cfg(all(feature = "acceptance", debug_assertions))]
    InspectJobs(oneshot::Sender<serde_json::Value>),
    Start(Settings, oneshot::Sender<Result<(), String>>),
    Stop(oneshot::Sender<Result<(), String>>),
    Pause,
    ManualOpen,
    Manual(String),
    Dismiss,
    Expand,
    Project(Option<String>),
    ClearProject,
    Screenshot,
    ClearScreenshot,
}
enum Work {
    Finished(String),
    Started(String, Result<Session, String>),
    Sent(String, u64),
    Delta(String, String),
    Revision(String, String),
    QuestionDelta(String, String, [u8;32], String),
    NoReply(String, String, [u8;32]),
    QuestionComplete(String,String,[u8;32]),
    Complete(String),
    Error(String, String),
    Summary(String, meeting::context::Memory),
    SummaryError(String, String),
    Project(String, String, Result<crate::attachments::project::Project, String>),
    Screenshot(String, String, Result<crate::attachments::screenshot::Screenshot, String>),
}
pub struct Runtime {
    timings: crate::openai::timing::Registry,
    tx: mpsc::Sender<Control>,
    view: Arc<Mutex<Snapshot>>,
    auth: Arc<Auth>,
    db: Arc<Database>,
    client: Client,
    hidden: Arc<AtomicBool>,
    lifecycle: tokio::sync::Mutex<()>,
    models: tokio::sync::Mutex<Vec<Model>>,
    default_model: String,
    default_nemotron_model: String,
    default_nemotron_runtime: String,
    shortcut_errors: Vec<String>,
}
fn emit(app: &tauri::AppHandle, name: &str, payload: impl Serialize) {
    let _ = app.emit(
        "copilot:event",
        meeting::BusEvent {
            name: name.into(),
            payload: serde_json::to_value(payload).unwrap_or_default(),
        },
    );
}
fn publish(app: &tauri::AppHandle, engine: &mut Engine, view: &Mutex<Snapshot>) {
    engine.view.revision += 1;
    *view.lock().unwrap() = engine.view.clone();
    let _ = app.emit("copilot:state", &engine.view);
}
async fn send(rt: &Runtime, c: Control) -> Result<(), String> {
    rt.tx
        .send(c)
        .await
        .map_err(|_| "Meeting engine is unavailable".into())
}
async fn pipeline(
    model: SpeechModel,
    s: &Settings,
    clock: Instant,
    events: mpsc::Sender<InputEvent>,
    levels: Arc<Mutex<(f32, f32)>>,
) -> Result<Pipeline, String> {
    let (tx, rx) = mpsc::channel(128);
    let transcription = match model {
        SpeechModel::Whisper(model)=>{let ev=events.clone();SpeechPipeline::Whisper(tokio::task::spawn_blocking(move||transcription::start(model,rx,ev,levels)).await.map_err(|e|e.to_string())??)},
        SpeechModel::Nemotron(service)=>SpeechPipeline::Nemotron(transcription::nemotron::start(service,rx,events.clone(),levels).await?),
    };
    let output=s.output.clone();let microphone=s.microphone.clone();
    let capture = tokio::task::spawn_blocking(move||audio::start(output,microphone,clock,tx,events)).await.map_err(|e|e.to_string())??;
    Ok(Pipeline {
        capture,
        transcription,
    })
}
struct Starting { id:String, cancel:CancellationToken, reply:oneshot::Sender<Result<(),String>> }
async fn start_session(mut settings:Settings, events:mpsc::Sender<InputEvent>, levels:Arc<Mutex<(f32,f32)>>, cancel:CancellationToken, client:Client)->Result<Session,String> {
    if settings.answer_backend==AnswerBackend::Codex {
        let codex=client.codex.as_ref().ok_or("Codex runtime unavailable")?;
        let instructions=prompts::answer_instructions(prompts::ANSWER);
        codex.prewarm(&settings.model,settings.service_tier.as_deref(),settings.reasoning_effort.as_deref(),&instructions,&cancel).await?;
        codex.prime(&settings.model,settings.service_tier.as_deref(),settings.reasoning_effort.as_deref(),&instructions,&cancel).await?;
    }
    if settings.speech_backend==SpeechBackend::Nemotron {
        let devices=transcription::nemotron::devices(&settings.nemotron_runtime,&cancel).await?;
        let device=transcription::nemotron::select_device(&devices,settings.nemotron_device,settings.nemotron_device_name.as_deref())?;
        settings.nemotron_device=device.index;settings.nemotron_device_name=Some(device.name.clone());
    }
    let model=match settings.speech_backend {
        SpeechBackend::Nemotron=>SpeechModel::Nemotron(transcription::nemotron::Service::load(&settings.nemotron_runtime,&settings.model_path,settings.speech_chunk_ms,settings.nemotron_device,&cancel).await?),
        SpeechBackend::Whisper=>{let path=settings.model_path.clone();SpeechModel::Whisper(tokio::task::spawn_blocking(move||transcription::whisper::load(&path)).await.map_err(|e|e.to_string())??)},
    };
    if cancel.is_cancelled(){return Err("Speech startup cancelled".into());}
    let clock=Instant::now();
    let pipeline=tokio::select! { _=cancel.cancelled()=>return Err("Speech startup cancelled".into()), result=pipeline(model.clone(),&settings,clock,events,levels)=>result? };
    let intent=(meeting::intent::Mode::configured()==meeting::intent::Mode::Learned).then(meeting::intent::Classifier::start);
    Ok(Session{id:uuid::Uuid::new_v4().to_string(),clock,settings,model,pipeline:Some(pipeline),intent})
}
async fn actor(
    app: tauri::AppHandle,
    mut controls: mpsc::Receiver<Control>,
    view: Arc<Mutex<Snapshot>>,
    auth: Arc<Auth>,
    db: Arc<Database>,
    client: Client,
    hidden: Arc<AtomicBool>,
    timings: crate::openai::timing::Registry,
) {
    let mut engine = Engine::default();
    engine.view.protection = view.lock().unwrap().protection;
    let mut session: Option<Session> = None;
    let mut starting: Option<Starting> = None;
    let mut generation: Option<CancellationToken> = None;
    let mut answers = meeting::scheduler::Scheduler::default();
    let intent_mode=meeting::intent::Mode::configured();
    let mut intent_gate=meeting::intent::Gate::default();
    let intent_threshold=meeting::intent::ready_threshold();
    let quiet_priority=meeting::intent::quiet_priority_enabled();
    let mut summary: Option<CancellationToken> = None;
    let (mut events_tx, mut events) = mpsc::channel(256);
    let (work_tx, mut work) = mpsc::channel(256);
    let levels = Arc::new(Mutex::new((0., 0.)));
    let mut tick = tokio::time::interval(Duration::from_millis(40));
    let mut transcript_at = 0;
    let mut summary_retry_at = 0;
    let mut project_request: Option<String> = None;
    let mut screenshot_request: Option<String> = None;
    let mut speech_metrics = Latency::default();
    loop {
        tokio::select! {
            control=controls.recv()=>{let Some(control)=control else{break};if starting.is_some()&&!matches!(&control,Control::Start(..)|Control::Stop(..)){continue;}match control {
                #[cfg(all(feature="acceptance",debug_assertions))] Control::InspectJobs(reply)=>{
                    let now=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64);
                    let traces=timings.lock().unwrap();
                    let jobs=answers.jobs.iter().map(|job|{
                        let mut latency=job.latency.clone();
                        if let Some(trace)=traces.get(&job.question.id){latency.pipeline=trace.snapshot();}
                        serde_json::json!({"question":job.question,"phase":job.phase,"confirmed":job.confirmed,
                            "running":job.running,"cancelled":job.cancel.is_cancelled(),"answer":job.buffer,
                            "error":job.error,"latency":latency})
                    }).collect::<Vec<_>>();
                    let _=reply.send(serde_json::json!({"nativeNow":now,"view":engine.view,"jobs":jobs}));
                },
                #[cfg(all(feature="acceptance",debug_assertions))] Control::Protection(enabled,reply)=>{engine.view.protection=enabled;publish(&app,&mut engine,&view);let _=reply.send(());},
                #[cfg(all(feature="acceptance",debug_assertions))] Control::Inject(mut event,reply)=>{let now=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64).unwrap_or(0);match &mut event{InputEvent::SpeechStarted(_,t)|InputEvent::SpeechEnded(_,t)|InputEvent::SpeechActivity(_,t,_)=>*t=now,InputEvent::Transcript(s)=>{s.started_at=now;s.ended_at=now;},_=>{}}let _=events_tx.send(event).await;let _=reply.send(now);}, Control::Start(settings,reply)=>{
                    if session.is_some()||starting.is_some(){let _=reply.send(Err("A meeting is already active".into()));continue;}
                    let (tx, rx) = mpsc::channel(256); events_tx = tx; events = rx;
                    let id=uuid::Uuid::new_v4().to_string();let cancel=CancellationToken::new();
                    starting=Some(Starting{id:id.clone(),cancel:cancel.clone(),reply});
                    engine.clear_meeting();engine.view.active=true;engine.view.status="loading".into();publish(&app,&mut engine,&view);
                    let tx=work_tx.clone();let ev=events_tx.clone();let lv=levels.clone();
                    let startup_client=client.clone();
                    tauri::async_runtime::spawn(async move{let result=start_session(settings,ev,lv,cancel,startup_client).await;let _=tx.send(Work::Started(id,result)).await;});
                },
                Control::Stop(reply)=>{project_request=None;screenshot_request=None;
                    timings.lock().unwrap().clear();
                    if let Some(pending)=starting.take(){pending.cancel.cancel();let _=pending.reply.send(Err("Speech startup cancelled".into()));}
                    answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);if let Some(c)=summary.take(){c.cancel()}
                    if let Some(codex)=&client.codex { codex.close(); }
                    let result=if let Some(mut s)=session.take(){if let Some(mut p)=s.pipeline.take(){let _=tokio::task::spawn_blocking(move||p.stop()).await;}db.stop(&s.id,crate::openai::auth::now())}else{Ok(())};
                    let (tx, rx) = mpsc::channel(256); events_tx = tx; events = rx; while work.try_recv().is_ok(){}*levels.lock().unwrap()=(0.,0.);engine.clear_meeting();window::set_manual(&app,false);window::hide(&app);publish(&app,&mut engine,&view);emit(&app,"meeting.stopped",());let _=reply.send(result);
                },
                Control::Pause=>{if let Some(s)=session.as_mut(){
                    intent_gate.invalidate();
                    answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.view.answer.clear();engine.view.question=None;engine.detector.clear();
                    if let Some(mut p)=s.pipeline.take(){let _=tokio::task::spawn_blocking(move||p.stop()).await;engine.view.paused=true;*levels.lock().unwrap()=(0.,0.);let (tx, rx) = mpsc::channel(256); events_tx = tx; events = rx; engine.view.error=None;engine.view.status="listening".into();}
                    else {let model=s.model.clone();let settings=s.settings.clone();let clock=s.clock;let tx=events_tx.clone();let lv=levels.clone();match pipeline(model,&settings,clock,tx,lv).await{Ok(p)=>{s.pipeline=Some(p);engine.view.paused=false;engine.view.status="listening".into();engine.view.error=None;},Err(e)=>{engine.view.error=Some(e);engine.view.status="error".into();}}}
                    publish(&app,&mut engine,&view);
                }},
                Control::ManualOpen=>{if session.is_some(){engine.view.manual=true;hidden.store(false,Ordering::Release);window::show(&app,&hidden);window::set_manual(&app,true);publish(&app,&mut engine,&view);}},
                Control::Manual(question)=>{if let Some(s)=session.as_ref(){let question=question.trim().to_string();if !question.is_empty()&&question.len()<=4000{engine.view.manual=false;window::set_manual(&app,false);answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);let now=s.clock.elapsed().as_millis()as u64;generation=Some(generate(&app,&mut engine,s,&auth,&client,&timings,work_tx.clone(),question,now,now,prompts::ANSWER));publish(&app,&mut engine,&view);}}},
                Control::Dismiss=>{answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.detector.clear();engine.view.question=None;engine.view.answer.clear();engine.view.error=None;engine.view.expanded=false;engine.view.manual=false;window::set_manual(&app,false);engine.view.status=if engine.view.active{"listening"}else{"off"}.into();publish(&app,&mut engine,&view);},
                Control::Expand=>{if let Some(s)=session.as_ref(){if let Some(q)=engine.view.question.clone(){engine.view.expanded=true;answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);let now=s.clock.elapsed().as_millis()as u64;generation=Some(generate(&app,&mut engine,s,&auth,&client,&timings,work_tx.clone(),q.text,now,now,prompts::EXPAND));publish(&app,&mut engine,&view);}}},
                Control::Project(path)=>{if let Some(s)=session.as_ref(){
                    let path=path.unwrap_or_else(||s.settings.project_path.clone());
                    if path.trim().is_empty(){engine.view.error=Some("Choose a project folder in the main window first".into());publish(&app,&mut engine,&view);continue;}
                    let id=uuid::Uuid::new_v4().to_string();project_request=Some(id.clone());engine.view.attachment_busy=true;engine.view.error=None;publish(&app,&mut engine,&view);
                    let session_id=s.id.clone();let tx=work_tx.clone();
                    tauri::async_runtime::spawn(async move{let result=tokio::task::spawn_blocking(move||crate::attachments::project::collect(std::path::Path::new(&path))).await.map_err(|_|"Project collection failed".to_string()).and_then(|r|r);let _=tx.send(Work::Project(session_id,id,result)).await;});
                }},
                Control::ClearProject=>{project_request=None;engine.project=None;engine.view.project=None;engine.view.attachment_busy=screenshot_request.is_some();answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.view.answer.clear();engine.view.question=None;engine.detector.clear();engine.view.status=if session.is_some(){"listening"}else{"off"}.into();publish(&app,&mut engine,&view);},
                Control::Screenshot=>{if let Some(s)=session.as_ref(){if screenshot_request.is_none(){
                    let id=uuid::Uuid::new_v4().to_string();screenshot_request=Some(id.clone());engine.view.attachment_busy=true;engine.view.error=None;publish(&app,&mut engine,&view);let suppression=window::suspend_for_capture(&app);
                    let session_id=s.id.clone();let tx=work_tx.clone();
                    tauri::async_runtime::spawn(async move{let result=tokio::task::spawn_blocking(move||{let _suppression=suppression;std::thread::sleep(Duration::from_millis(80));crate::attachments::screenshot::capture()}).await.map_err(|_|"Screen capture failed".to_string()).and_then(|r|r);let _=tx.send(Work::Screenshot(session_id,id,result)).await;});
                }}},
                Control::ClearScreenshot=>{screenshot_request=None;engine.screenshot_data=None;engine.view.screenshot=None;engine.view.attachment_busy=project_request.is_some();answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.view.answer.clear();engine.view.question=None;engine.detector.clear();engine.view.status=if session.is_some(){"listening"}else{"off"}.into();if session.is_some(){window::show(&app,&hidden);}publish(&app,&mut engine,&view);},
            }},
            event=events.recv(),if session.is_some()=>{let Some(event)=event else{continue};let s=session.as_ref().unwrap();let now=s.clock.elapsed().as_millis()as u64;engine.detector.semantic_intent=s.settings.answer_backend==AnswerBackend::Codex;engine.detector.independent_asr_endpoint=s.settings.speech_backend==SpeechBackend::Nemotron;answers.semantic_intent=engine.detector.semantic_intent;if engine.view.paused{continue;}
                match event {
                    #[cfg(all(feature="acceptance",debug_assertions))]
                    InputEvent::RawTranscriptBoundary(source,final_,text,started,ended)=>{
                        emit(&app,"asr.raw_boundary",serde_json::json!({"source":source,"final":final_,"text":text,
                            "startedAt":started,"endedAt":ended,"observedAt":now}));
                    },
                    InputEvent::SpeechStarted(source,t)=>{
                        intent_gate.invalidate();
                        if source==SpeakerSource::Self_ {answers.resumed();}
                        let resumed=engine.detector.speech_started(source,t);
                        if source==SpeakerSource::Remote {
                            if !resumed{speech_metrics=Latency{remote_speech_started_at:engine.detector.remote_turn_started_at,..Default::default()};}
                            else if let Some(id)=resume_answer_question(&mut answers,&mut engine.context,&engine.detector.last_question,engine.detector.remote_turn_started_at){if let Some(trace)=timings.lock().unwrap().get(&id){trace.reset_answer();}}
                        }
                        emit(&app,"speech.started",serde_json::json!({"source":source,"timestamp":t,"continued":resumed,"turnStartedAt":engine.detector.remote_turn_started_at}));
                        update_acoustic_quiet(&mut answers,&engine.detector);sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);
                    },
                    InputEvent::SpeechEnded(source,t)=>{engine.detector.speech_ended(source,t);update_acoustic_quiet(&mut answers,&engine.detector);emit(&app,"speech.ended",serde_json::json!({"source":source,"timestamp":t}));},
                    InputEvent::SpeechActivity(source,t,quiet)=>{
                        if !quiet {intent_gate.invalidate();}
                        engine.detector.speech_activity(source,t,quiet);
                        update_acoustic_quiet(&mut answers,&engine.detector);
                        emit(&app,"speech.activity",serde_json::json!({"source":source,"timestamp":t,"quiet":quiet,"observedAt":now}));
                    },
                    InputEvent::Transcript(segment)=>{
                        if segment.source==SpeakerSource::Remote && !segment.final_ {speech_metrics.first_remote_partial_at.get_or_insert(now);speech_metrics.remote_partial_updates+=1;}
                        #[cfg(debug_assertions)]{let _=app.emit("copilot:transcript",&segment);}
                        if segment.final_{if segment.source==SpeakerSource::Remote{transcript_at=now;}if !segment.text.trim().is_empty(){engine.context.push(segment.clone());}}
                        let candidate_changed=engine.detector.transcript(&segment);
                        #[cfg(all(feature="acceptance",debug_assertions))]
                        if segment.source==SpeakerSource::Remote&&std::env::var("COPILOT_TRACE_PROVISIONAL").as_deref()==Ok("1") {
                            emit(&app,"asr.candidate_observed",serde_json::json!({"text":engine.detector.classifier_text(),
                                "floor":engine.detector.remote_turn_started_at,"segmentId":segment.id,
                                "final":segment.final_,"observedAt":now}));
                        }
                        if candidate_changed && intent_mode==meeting::intent::Mode::Existing {
                            if answers.candidate.is_none() && engine.detector.continued {
                                if let Some(id)=resume_answer_question(&mut answers,&mut engine.context,&engine.detector.last_question,engine.detector.remote_turn_started_at){if let Some(trace)=timings.lock().unwrap().get(&id){trace.reset_answer();}}
                            }
                            if let Some(question)=engine.detector.candidate(){speech_metrics.first_credible_candidate_at.get_or_insert(now);cancel_answer(&app,&mut generation);if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}let candidate_id=answers.propose(question,now,engine.detector.stopped_at.unwrap_or(segment.ended_at),now);if let Some(job)=answers.find_mut(&candidate_id){job.latency.remote_speech_started_at=speech_metrics.remote_speech_started_at;job.latency.first_remote_partial_at=speech_metrics.first_remote_partial_at;job.latency.first_credible_candidate_at=speech_metrics.first_credible_candidate_at;job.latency.remote_partial_updates=speech_metrics.remote_partial_updates;if refresh_question_context(job,&engine.context){if let Some(trace)=timings.lock().unwrap().get(&candidate_id){trace.reset_answer();}}}update_acoustic_quiet(&mut answers,&engine.detector);emit(&app,"question.candidate",());
                                drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);}
                        } else if intent_mode==meeting::intent::Mode::Existing && segment.source==SpeakerSource::Remote {answers.resumed();sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);}
                    },
                    InputEvent::Failure(error)=>{
                        answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);
                        if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}
                        if let Some(s)=session.as_mut(){if let Some(mut p)=s.pipeline.take(){let _=tokio::task::spawn_blocking(move||p.stop()).await;}}
                        let (tx,rx)=mpsc::channel(256);events_tx=tx;events=rx;
                        *levels.lock().unwrap()=(0.,0.);engine.detector.clear();
                        engine.view.paused=true;engine.view.error=Some(error);engine.view.status="error".into();publish(&app,&mut engine,&view);
                    },_=>{}
                }
            },
            w=work.recv()=>{let Some(w)=w else{continue};
                let answer_id=match &w {Work::Sent(id,_)|Work::Delta(id,_)|Work::Revision(id,_)|Work::QuestionDelta(id,_,_,_)|Work::NoReply(id,_,_)|Work::QuestionComplete(id,_,_)|Work::Complete(id)|Work::Error(id,_)|Work::Finished(id)=>Some(id.clone()),_=>None};
                if let Some(id)=answer_id {if let Some(job)=answers.find_mut(&id) {
                    let now=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64).unwrap_or(0);
                    let valid=!job.cancel.is_cancelled() && !matches!(job.phase,meeting::scheduler::Phase::Cancelled|meeting::scheduler::Phase::Superseded);
                    #[cfg(all(feature="acceptance",debug_assertions))]
                    if valid&&job.latency.first_word_at.is_none()&&std::env::var("COPILOT_TRACE_PROVISIONAL").as_deref()==Ok("1") {
                        if let Work::QuestionDelta(_,question,key,text)=&w {
                            if text.chars().any(char::is_alphanumeric)&&job.accepts_stream(question,key){
                                emit(&app,"answer.frame_received",serde_json::json!({"id":id,"question":question,"contextKey":key,
                                    "revision":job.latency.response_revision,"confirmed":job.confirmed,"observedAt":now,
                                    "scope":"Exact current request/context frame receipt; not answer correctness or authorization to display an unconfirmed answer."}));
                            }
                        }
                    }
                    let Some(w)=gate_question_work(job,w)else{continue};
                    match w {
                        Work::NoReply(_,_,_) if valid=>{job.phase=meeting::scheduler::Phase::Cancelled;job.confirmed=false;job.buffer.clear();job.latency.completed_at=Some(now);emit(&app,"question.ignored",serde_json::json!({"id":id,"timestamp":now}));},
                        Work::Sent(_,t) if valid=>job.latency.request_sent_at=t,
                        Work::Revision(_,text) if valid=>{engine.context.forget_visible_answer(&id);job.buffer=text;job.latency.first_token_at=None;job.latency.first_word_at=None;job.latency.response_revision+=1;if let Some(trace)=timings.lock().unwrap().get(&id){trace.reset_answer();}},
                        Work::Delta(_,delta) if valid=>{job.latency.observe_answer_delta(&delta,now);if job.latency.first_token_at==Some(now){job.latency.first_token_at=Some(now);if let Some(trace)=timings.lock().unwrap().get(&id){trace.retained_delta_at(now);}}if job.buffer.len()+delta.len()>32_000 {job.cancel.cancel();job.error=Some("Answer exceeds display size limit".into());job.latency.completed_at=Some(now);if job.confirmed{job.phase=meeting::scheduler::Phase::Complete;}}else{job.buffer.push_str(&delta);}},
                        Work::Complete(_) if valid=>{job.latency.completed_at=Some(now);if job.confirmed{job.phase=meeting::scheduler::Phase::Complete;engine.context.remember_answer_at(&id,&job.question.text,&job.buffer,job.question.detected_at);}emit(&app,"answer.completed",serde_json::json!({"id":id}));},
                        Work::Error(_,e) if valid=>{job.error=Some(e);job.latency.completed_at=Some(now);if job.confirmed{job.phase=meeting::scheduler::Phase::Complete;}},
                        Work::Finished(_)=>{job.running=false;},_=>{}
                    }
                    sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);continue;
                }}
                match w {
                Work::Finished(_)|Work::QuestionDelta(_,_,_,_)|Work::NoReply(_,_,_)|Work::QuestionComplete(_,_,_)=>{},
                Work::Started(id,result)=>{if starting.as_ref().is_some_and(|pending|pending.id==id){let pending=starting.take().unwrap();
                    match result {
                        Ok(s)=>{match db.start(&s.id,crate::openai::auth::now()){
                            Ok(())=>{session=Some(s);intent_gate=meeting::intent::Gate::default();summary_retry_at=0;transcript_at=0;engine.view.active=true;engine.view.status="listening".into();hidden.store(false,Ordering::Release);let _=window::position(&app);window::show(&app,&hidden);emit(&app,"meeting.started",());let _=pending.reply.send(Ok(()));},
                            Err(error)=>{drop(s);engine.clear_meeting();engine.view.error=Some(error.clone());let _=pending.reply.send(Err(error));},
                        }},
                        Err(error)=>{engine.clear_meeting();engine.view.error=Some(error.clone());let _=pending.reply.send(Err(error));},
                    }publish(&app,&mut engine,&view);
                }},
                Work::Revision(id,text)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){engine.context.forget_visible_answer(&id);engine.view.answer=text;if let Some(l)=engine.view.latency.as_mut(){l.first_token_at=None;l.first_word_at=None;l.response_revision+=1;}if let Some(trace)=timings.lock().unwrap().get(&id){trace.reset_answer();}publish(&app,&mut engine,&view);}},
                Work::Sent(id,time)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){if let Some(l)=engine.view.latency.as_mut(){l.request_sent_at=time;}}},
                Work::Delta(id,delta)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){let now=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64).unwrap_or(0);if let Some(l)=engine.view.latency.as_mut(){l.observe_answer_delta(&delta,now);if l.first_token_at==Some(now){l.first_token_at=Some(now);if let Some(trace)=timings.lock().unwrap().get(&id){trace.retained_delta_at(now);}}}if engine.view.answer.len()+delta.len()>32_000{answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.view.error=Some("Answer exceeds display size limit".into());engine.view.status="error".into();publish(&app,&mut engine,&view);continue;}engine.view.answer.push_str(&delta);engine.view.status="answer".into();emit(&app,"answer.delta",serde_json::json!({"id":id,"delta":delta}));publish(&app,&mut engine,&view);}},
                Work::Complete(id)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){generation=None;if let Some(q)=&engine.view.question{engine.context.remember_answer_at(&id,&q.text,&engine.view.answer,q.detected_at);}if let Some(l)=engine.view.latency.as_mut(){l.completed_at=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64);let metrics=serde_json::json!({"speech_to_transcript":l.transcript_final_at.saturating_sub(l.speech_stopped_at),"question_detection":l.question_confirmed_at.saturating_sub(l.transcript_final_at),"request_to_first_token":l.first_token_at.map(|t|t.saturating_sub(l.request_sent_at)),"total_to_first_answer":l.first_token_at.map(|t|t.saturating_sub(l.speech_stopped_at))});emit(&app,"latency.measured",metrics.clone());let _=writeln!(std::io::stderr(),"latency {metrics}");}emit(&app,"answer.completed",serde_json::json!({"id":id}));publish(&app,&mut engine,&view);}},
                Work::Error(id,error)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){generation=None;engine.view.status="error".into();engine.view.error=Some(error);publish(&app,&mut engine,&view);}},
                Work::Summary(id,memory)=>{if let Some(s)=session.as_ref().filter(|s|s.id==id){summary=None;engine.context.complete_summary(memory);summary_retry_at=s.clock.elapsed().as_millis()as u64+30_000;}},
                Work::SummaryError(id,error)=>{if let Some(s)=session.as_ref().filter(|s|s.id==id){summary=None;engine.context.fail_summary();summary_retry_at=s.clock.elapsed().as_millis()as u64+30_000;emit(&app,"context.error",error);}}
                Work::Project(session_id,id,result)=>{if let Some(s)=session.as_ref().filter(|s|s.id==session_id&&project_request.as_ref()==Some(&id)){
                    project_request=None;engine.view.attachment_busy=screenshot_request.is_some();
                    match result {Ok(project)=>{engine.view.project=Some(project.info());engine.project=Some(project);answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.detector.clear();let now=s.clock.elapsed().as_millis()as u64;generation=Some(generate(&app,&mut engine,s,&auth,&client,&timings,work_tx.clone(),"Give a concise overview of this project and explain its main architecture.".into(),now,now,prompts::ANSWER));},Err(error)=>{engine.view.error=Some(error);}}
                    publish(&app,&mut engine,&view);
                }},
                Work::Screenshot(session_id,id,result)=>{if session.is_some(){window::show(&app,&hidden);}if let Some(s)=session.as_ref().filter(|s|s.id==session_id&&screenshot_request.as_ref()==Some(&id)){
                    screenshot_request=None;engine.view.attachment_busy=project_request.is_some();
                    match result {Ok(screenshot)=>{engine.view.screenshot=Some(screenshot.info);engine.screenshot_data=Some(screenshot.data_url);answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.detector.clear();let now=s.clock.elapsed().as_millis()as u64;generation=Some(generate(&app,&mut engine,s,&auth,&client,&timings,work_tx.clone(),"Explain what is on this screen and help me with the visible task.".into(),now,now,prompts::ANSWER));},Err(error)=>{engine.view.error=Some(error);}}
                    window::show(&app,&hidden);publish(&app,&mut engine,&view);
                }},
            }},
            _=tick.tick()=>{if let Some(s)=session.as_ref(){let now=s.clock.elapsed().as_millis()as u64;
                if !engine.view.paused&&engine.view.status!="error" {
                    if let Some(classifier)=s.intent.as_ref() {
                        while let Some(status)=classifier.status(){emit(&app,"intent.worker",serde_json::json!({"status":status,"timestamp":now}));}
                        if let (Some(floor),Some(question))=(engine.detector.remote_turn_started_at,engine.detector.classifier_text()) {
                            let context=engine.context.classifier_context(floor);
                            if !intent_gate.matches(floor,&question,&context) {
                                intent_gate.observe(floor,question,context,now);
                            }
                            if let Some(input)=intent_gate.request_with_quiet(now,engine.detector.remote_quiet&&!engine.detector.self_speaking,quiet_priority) {
                                #[cfg(all(feature="acceptance",debug_assertions))]
                                if std::env::var("COPILOT_TRACE_PROVISIONAL").as_deref()==Ok("1") {
                                    emit(&app,"intent.input_submitted",serde_json::json!({"input":input,"submittedAt":now,"quietPriorityBypass":intent_gate.last_submission_prioritized(),
                                        "remoteQuiet":engine.detector.remote_quiet,"remoteSpeaking":engine.detector.remote_speaking,
                                        "selfSpeaking":engine.detector.self_speaking}));
                                }
                                classifier.submit(input);
                            }
                            while let Some(prediction)=classifier.prediction() {
                                let payload=serde_json::json!({"id":prediction.id,"abstained":prediction.abstained,"scores":prediction.scores.as_ref().map(|scores|serde_json::json!({"request":scores.request,"ready":scores.ready})),"elapsedMs":prediction.elapsed_ms,"observedAt":now});
                                let accepted=intent_gate.accept(prediction);emit(&app,"intent.predicted",serde_json::json!({"accepted":accepted,"prediction":payload}));
                            }
                            if meeting::intent::settled_update_enabled()&&!engine.detector.remote_speaking {
                                if let Some(stopped)=engine.detector.stopped_at {
                                    if let Some(input)=intent_gate.settled_input(now,stopped,engine.detector.remote_quiet,engine.detector.self_speaking) {
                                        if let Some(id)=answers.update_speculative_question(input.floor,input.text) {
                                            intent_gate.mark_settled_update(input.floor,stopped);
                                            if let Some(job)=answers.find_mut(&id){refresh_question_context(job,&engine.context);}
                                            if let Some(trace)=timings.lock().unwrap().get(&id){trace.reset_answer();}
                                            update_acoustic_quiet(&mut answers,&engine.detector);
                                            emit(&app,"intent.settled_updated",serde_json::json!({"id":id,"floor":input.floor,"stoppedAt":stopped,"timestamp":now}));
                                        }
                                    }
                                }
                            }
                            if let Some(input)=intent_threshold.and_then(|threshold|intent_gate.ready_input(now,engine.detector.remote_quiet,engine.detector.self_speaking,threshold)) {
                                if let Some(id)=answers.update_speculative_question(input.floor,input.text) {
                                    if let Some(job)=answers.find_mut(&id){refresh_question_context(job,&engine.context);}
                                    if let Some(trace)=timings.lock().unwrap().get(&id){trace.reset_answer();}
                                    update_acoustic_quiet(&mut answers,&engine.detector);
                                    emit(&app,"intent.early_updated",serde_json::json!({"id":id,"timestamp":now,"floor":input.floor}));
                                }
                            }
                            if let Some(input)=intent_threshold.and_then(|threshold|intent_gate.early(now,engine.detector.remote_quiet,engine.detector.self_speaking,threshold)) {
                                #[cfg(all(feature="acceptance",debug_assertions))]
                                let early_text=input.text.clone();
                                speech_metrics.first_credible_candidate_at.get_or_insert(now);cancel_answer(&app,&mut generation);
                                if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}
                                let id=answers.propose(input.text,now,engine.detector.stopped_at.unwrap_or(now),transcript_at);
                                if let Some(job)=answers.find_mut(&id) {job.latency.remote_speech_started_at=speech_metrics.remote_speech_started_at;job.latency.first_remote_partial_at=speech_metrics.first_remote_partial_at;job.latency.first_credible_candidate_at=speech_metrics.first_credible_candidate_at;job.latency.remote_partial_updates=speech_metrics.remote_partial_updates;refresh_question_context(job,&engine.context);}
                                emit(&app,"intent.early_sent",serde_json::json!({"id":id,"timestamp":now,"floor":input.floor,"threshold":intent_threshold}));
                                #[cfg(all(feature="acceptance",debug_assertions))]
                                if crate::openai::acceptance_mode(){emit(&app,"intent.early_input",serde_json::json!({"id":id,"timestamp":now,"floor":input.floor,"text":early_text}));}
                            }
                        } else {intent_gate.invalidate();}
                    }
                    if let Some((question,stopped))=engine.detector.confirm(now) {
                        emit(&app,"asr.finalization_ready",serde_json::json!({"floor":engine.detector.remote_turn_started_at,
                            "speechStoppedAt":stopped,"lastRemoteActivity":engine.detector.last_remote_activity(),"timestamp":now}));
                        let background=intent_mode==meeting::intent::Mode::Learned&&meeting::intent::background_enabled()&&engine.detector.remote_turn_started_at.is_some_and(|floor|intent_gate.background(floor,&question,&engine.context.classifier_context(floor),0.95));
                        if background {
                            answers.resumed();emit(&app,"intent.background_ignored",serde_json::json!({"timestamp":now,"floor":engine.detector.remote_turn_started_at}));
                            sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);
                        } else {
                            let excerpts=engine.context.answer_context_for_utterance(&question,speech_metrics.remote_speech_started_at);let id=answers.confirm_with_context(question,now,stopped,transcript_at,Some(excerpts));if let Some(job)=answers.find_mut(&id){job.latency.remote_speech_started_at=speech_metrics.remote_speech_started_at;job.latency.first_remote_partial_at=speech_metrics.first_remote_partial_at;job.latency.first_credible_candidate_at=speech_metrics.first_credible_candidate_at;job.latency.remote_partial_updates=speech_metrics.remote_partial_updates;if job.latency.completed_at.is_some()&&job.error.is_none(){engine.context.remember_answer_at(&id,&job.question.text,&job.buffer,job.question.detected_at);}}if let Some(trace)=timings.lock().unwrap().get(&id){trace.confirmed_at(now);if answers.jobs.iter().any(|job|job.question.id==id&&job.latency.first_token_at.is_none()){trace.reset_answer();}}emit(&app,"question.confirmed",serde_json::json!({"id":id,"timestamp":now}));sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);
                        }
                    }
                    if answers.busy(){if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);}
                    if generation.is_none()&&!answers.busy()&&summary.is_none()&&now>=summary_retry_at{if let Some(batch)=engine.context.take_summary_batch(){let input=format!("PRIOR MEMORY\n{}\nOLDER TRANSCRIPT\n{}",serde_json::to_string(&engine.context.memory).unwrap_or_default(),meeting::context::conversation(&batch));let cancel=CancellationToken::new();summary=Some(cancel.clone());let id=s.id.clone();let model=s.settings.model.clone();let auth=auth.clone();let client=client.clone().with_backend(s.settings.answer_backend,s.settings.service_tier.as_deref());let tx=work_tx.clone();tauri::async_runtime::spawn(async move{let result=async{let token=answer_token(&auth,&client,&cancel).await?;let text=client.text(&token,&model,prompts::SUMMARY,&input,cancel.clone()).await?;serde_json::from_str(&text).map_err(|_|"Could not parse meeting memory".to_string())}.await;if cancel.is_cancelled(){return;}let result=match result{Ok(m)=>Work::Summary(id,m),Err(e)=>Work::SummaryError(id,e)};let _=tx.send(result).await;});}}
                }
                let (remote,self_)=*levels.lock().unwrap();if (engine.view.remote_level-remote).abs()>0.002||(engine.view.self_level-self_).abs()>0.002{engine.view.remote_level=remote;engine.view.self_level=self_;publish(&app,&mut engine,&view);}
            }}
        }
    }
}
fn cancel_answer(app: &tauri::AppHandle, generation: &mut Option<CancellationToken>) {
    if let Some(c) = generation.take() {
        c.cancel();
        emit(app, "answer.cancelled", ());
    }
}
#[allow(clippy::too_many_arguments)]
fn generate(
    app: &tauri::AppHandle,
    engine: &mut Engine,
    s: &Session,
    auth: &Arc<Auth>,
    client: &Client,
    timings: &crate::openai::timing::Registry,
    tx: mpsc::Sender<Work>,
    question: String,
    stopped: u64,
    transcript: u64,
    instructions: &'static str,
) -> CancellationToken {
    let id = uuid::Uuid::new_v4().to_string();
    let now = s.clock.elapsed().as_millis() as u64;
    let mut input = engine.context.prompt(&question);
    if let Some(project) = &engine.project { input.push_str(&project.prompt()); }
    let screenshot = engine.screenshot_data.clone();
    engine.view.question = Some(CurrentQuestion {
        id: id.clone(),
        text: question,
        detected_at: now,
    });
    engine.view.answer.clear();
    engine.view.error = None;
    engine.view.status = "thinking".into();
    engine.view.expanded = instructions == prompts::EXPAND;
    let instructions = prompts::answer_instructions(instructions);
    engine.view.latency = Some(Latency {
        speech_stopped_at: stopped,
        transcript_final_at: transcript,
        question_confirmed_at: now,
        request_sent_at: now,
        ..Default::default()
    });
    emit(app, "answer.started", serde_json::json!({"id":id}));
    let cancel = CancellationToken::new();
    let abort = cancel.clone();
    let auth = auth.clone();
    let client = client
        .clone()
        .with_backend(s.settings.answer_backend, s.settings.service_tier.as_deref())
        .with_reasoning(s.settings.reasoning_effort.as_deref());
    let model = s.settings.model.clone();
    let clock = s.clock;
    let trace=crate::openai::timing::Trace::new(clock,now);trace.prompt_chars(input.chars().count());trace.confirmed_at(now);crate::openai::timing::register(timings,id.clone(),trace.clone());
    let client=client.with_refill(s.settings.codex_refill_policy).with_trace(trace);
    tauri::async_runtime::spawn(async move {
        let result=async{let token=answer_token(&auth,&client,&abort).await?;if abort.is_cancelled(){return Err("cancelled".into());}tx.send(Work::Sent(id.clone(),clock.elapsed().as_millis()as u64)).await.map_err(|_|"Meeting receiver closed")?;client.stream_with_image(&token,&model,&instructions,&input,screenshot.as_deref(),abort.clone(),|event|{let event=match event{StreamEvent::Delta(d)=>Work::Delta(id.clone(),d),StreamEvent::Revision(text)=>Work::Revision(id.clone(),text),StreamEvent::QuestionDelta{question,context_key,text}=>Work::QuestionDelta(id.clone(),question,context_key,text),StreamEvent::NoReply{question,context_key}=>Work::NoReply(id.clone(),question,context_key),StreamEvent::QuestionCompleted{question,context_key}=>Work::QuestionComplete(id.clone(),question,context_key),StreamEvent::Completed=>Work::Complete(id.clone())};let queue=tx.clone();async move{queue.send(event).await.map_err(|_|"Meeting stream receiver closed".to_string())}}).await}.await;
        if !abort.is_cancelled() {
            if let Err(error) = result {
                let _ = tx.send(Work::Error(id, error)).await;
            }
        }
    });
    cancel
}

#[tauri::command]
async fn bootstrap(rt: State<'_, Runtime>) -> Result<Bootstrap, String> {
    let mut settings = load_settings(&rt.db)?;
    if settings.speech_backend == SpeechBackend::Nemotron {
        if settings.model_path.is_empty() || settings.model_path.ends_with(".bin") { settings.model_path=rt.default_nemotron_model.clone(); }
        if settings.nemotron_runtime.is_empty(){settings.nemotron_runtime=rt.default_nemotron_runtime.clone();}
    } else if settings.model_path.is_empty() {
        settings.model_path=rt.default_model.clone();
    }
    let (speech_devices,speech_device_error)=if settings.speech_backend==SpeechBackend::Nemotron {
        match transcription::nemotron::devices(&settings.nemotron_runtime,&CancellationToken::new()).await {
            Ok(devices)=>{
                let error=match transcription::nemotron::select_device(&devices,settings.nemotron_device,settings.nemotron_device_name.as_deref()) {
                    Ok(device)=>{settings.nemotron_device=device.index;settings.nemotron_device_name=Some(device.name.clone());None},Err(error)=>Some(error),
                };(devices,error)
            },Err(error)=>(vec![],Some(error)),
        }
    } else {(vec![],None)};
    let devices = tokio::task::spawn_blocking(audio::devices)
        .await
        .map_err(|e| e.to_string())??;
    let (accounts, selected, connection_error) = if settings.answer_backend == AnswerBackend::Codex {
        match rt.client.codex.as_ref().ok_or("Codex runtime is unavailable")?.account().await {
            Ok(account) => (account.clone().into_iter().collect(), account, None),
            Err(error) => (vec![], None, Some(error)),
        }
    } else { (rt.auth.accounts().await, rt.auth.selected_account().await, None) };
    Ok(Bootstrap {
        settings,
        devices,
        speech_devices,
        speech_device_error,
        accounts,
        selected,
        models: rt.models.lock().await.clone(),
        snapshot: rt.view.lock().unwrap().clone(),
        debug: cfg!(debug_assertions),
        shortcut_errors: rt.shortcut_errors.clone(),
        connection_error,
    })
}
#[tauri::command]
fn get_snapshot(rt: State<'_, Runtime>) -> Snapshot {
    let mut snapshot=rt.view.lock().unwrap().clone();
    if let Some(question)=&snapshot.question {if let Some(trace)=rt.timings.lock().unwrap().get(&question.id){if let Some(latency)=snapshot.latency.as_mut(){latency.pipeline=trace.snapshot();}}}
    snapshot
}
#[tauri::command]
fn get_answer_timings(rt:State<'_,Runtime>)->Vec<(String,crate::openai::timing::Timeline)> {
    rt.timings.lock().unwrap().iter().map(|(id,t)|(id.clone(),t.snapshot())).collect()
}
// Read-only, debug/acceptance-only evidence. Hidden or cancelled buffers never
// authorize display; the production build cannot retrieve scheduler internals.
#[tauri::command]
async fn acceptance_jobs(rt:State<'_,Runtime>)->Result<serde_json::Value,String> {
    #[cfg(all(feature="acceptance",debug_assertions))]
    if crate::openai::acceptance_mode() {
        let (tx,rx)=oneshot::channel();
        send(&rt,Control::InspectJobs(tx)).await?;
        return rx.await.map_err(|_|"Meeting inspection cancelled".into());
    }
    let _=rt;
    Err("Scheduler inspection is available only in acceptance/debug mode".into())
}
#[tauri::command]
fn answer_visible(rt:State<'_,Runtime>,id:String,revision:Option<u64>) {
    let view=rt.view.lock().unwrap();
    if view.active && !view.answer.is_empty() && view.question.as_ref().is_some_and(|q|q.id==id) && revision.is_none_or(|revision|view.latency.as_ref().is_some_and(|latency|latency.response_revision==revision)) {
        if let Some(trace)=rt.timings.lock().unwrap().get(&id){trace.mark(crate::openai::timing::Stage::FirstVisible);}
    }
}
#[tauri::command]
async fn acceptance_event(
    rt: State<'_, Runtime>,
    kind: String,
    source: SpeakerSource,
    text: Option<String>,
    is_final: Option<bool>,
) -> Result<u64, String> {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    if crate::openai::acceptance_mode() {
        let event = match kind.as_str() {
            "started" => InputEvent::SpeechStarted(source, 0),
            "ended" => InputEvent::SpeechEnded(source, 0),
            "quiet" => InputEvent::SpeechActivity(source, 0, true),
            "active" => InputEvent::SpeechActivity(source, 0, false),
            "transcript" => InputEvent::Transcript(meeting::TranscriptSegment {
                id: uuid::Uuid::new_v4().to_string(),
                source,
                text: text.unwrap_or_default(),
                started_at: 0,
                ended_at: 0,
                final_: is_final.unwrap_or(true),
            }),
            _ => return Err("Unknown test event".into()),
        };
        let (tx, rx) = oneshot::channel();
        send(&rt, Control::Inject(event, tx)).await?;
        return rx.await.map_err(|e| e.to_string());
    }
    let _ = (rt, kind, source, text, is_final);
    Err("Acceptance instrumentation is unavailable in this build".into())
}
#[tauri::command]
async fn acceptance_protection(
    app: tauri::AppHandle,
    rt: State<'_, Runtime>,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    if crate::openai::acceptance_mode() {
        let w = app.get_webview_window("overlay").ok_or("Overlay missing")?;
        w.set_title("Copilot capture verification overlay")
            .map_err(|e| e.to_string())?;
        unsafe {
            use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
            let hwnd = HWND(w.hwnd().map_err(|e| e.to_string())?.0);
            let flag = if enabled {
                WDA_EXCLUDEFROMCAPTURE
            } else {
                WDA_NONE
            };
            SetWindowDisplayAffinity(hwnd, flag).map_err(|e| e.to_string())?;
            let mut actual = 0;
            GetWindowDisplayAffinity(hwnd, &mut actual).map_err(|e| e.to_string())?;
            if actual != flag.0 {
                return Err("Capture affinity readback mismatch".into());
            }
        }
        let (tx, rx) = oneshot::channel();
        send(&rt, Control::Protection(enabled, tx)).await?;
        return rx.await.map_err(|e| e.to_string());
    }
    let _ = (app, rt, enabled);
    Err("Acceptance instrumentation is unavailable in this build".into())
}
#[tauri::command]
fn native_diagnostics(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if !cfg!(debug_assertions) {
        return Err("Diagnostics are unavailable in production".into());
    }
    let w = app.get_webview_window("overlay").ok_or("Overlay missing")?;
    #[cfg(windows)]
    unsafe {
        use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
        let hwnd = HWND(w.hwnd().map_err(|e| e.to_string())?.0);
        let foreground = GetForegroundWindow();
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let mut affinity = 0;
        let verified = GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok();
        let mut rect = windows::Win32::Foundation::RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
        return Ok(
            serde_json::json!({"overlayHwnd":hwnd.0 as usize,"foregroundHwnd":foreground.0 as usize,"affinity":affinity,"affinityRead":verified,"noActivate":style & WS_EX_NOACTIVATE.0 as isize !=0,"alwaysOnTop":style & WS_EX_TOPMOST.0 as isize !=0,"visible":IsWindowVisible(hwnd).as_bool(),"rect":{"left":rect.left,"top":rect.top,"right":rect.right,"bottom":rect.bottom},"screen":{"width":GetSystemMetrics(SM_CXSCREEN),"height":GetSystemMetrics(SM_CYSCREEN)}}),
        );
    }
    #[cfg(not(windows))]
    Err("Windows required".into())
}
fn load_settings(db: &Database) -> Result<Settings, String> {
    db.get("audio_settings")?
        .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .transpose()
        .map(|s| { let mut settings:Settings=s.unwrap_or_default();
            if settings.answer_backend==AnswerBackend::Codex && settings.reasoning_effort.as_deref()==Some("xhigh") {settings.reasoning_effort=default_reasoning();}
            settings
        })
}
fn sync_answers(engine: &mut Engine, answers: &meeting::scheduler::Scheduler) {
    engine.view.questions=answers.rows();
    if let Some(j)=answers.visible() {
        if j.error.is_none() && j.latency.completed_at.is_none(){engine.context.remember_visible_answer_at(&j.question.id,&j.question.text,&j.buffer,j.latency.remote_speech_started_at.unwrap_or(j.question.detected_at));}
        engine.view.question=Some(j.question.clone());engine.view.answer=j.buffer.clone();engine.view.latency=Some(j.latency.clone());engine.view.error=j.error.clone();
        engine.view.status=if j.error.is_some(){"error"}else if !j.buffer.is_empty(){"answer"}else{"thinking"}.into();
    } else if answers.busy() {engine.view.question=None;engine.view.answer.clear();engine.view.latency=None;engine.view.status="question".into();}
    else if engine.view.active && engine.view.question.is_none() && !engine.view.manual && engine.view.status=="question" {
        engine.view.status="listening".into();engine.view.latency=None;
    }
}
#[cfg(test)]
mod answer_view_tests {
    use super::*;
    #[test]
    fn continued_question_does_not_feed_its_retracted_visible_draft_back_as_context() {
        let mut engine=Engine::default();
        let mut answers=meeting::scheduler::Scheduler{semantic_intent:true,..Default::default()};
        engine.context.remember_answer("previous","Implement","```rust\nlet exact=17;\n```");
        let question="Explain the invariant";
        let baseline=engine.context.answer_context_for_utterance(question,Some(100));
        let id=answers.confirm_with_context(question.into(),400,300,350,Some(baseline.clone()));
        answers.next(400);
        let job=answers.find_mut(&id).unwrap();job.steer_supported=true;job.latency.remote_speech_started_at=Some(100);
        job.buffer="The unfinished draft assumes a different boundary.".into();
        sync_answers(&mut engine,&answers);
        assert!(engine.context.prompt("Why that boundary?").contains(&engine.view.answer));
        assert!(resume_answer_question(&mut answers,&mut engine.context,question,Some(5000)).is_none());
        assert!(engine.context.prompt("Why that boundary?").contains(&engine.view.answer));
        assert_eq!(resume_answer_question(&mut answers,&mut engine.context,question,Some(100)),Some(id.clone()));
        let grown=format!("{question} for the earlier implementation");
        assert_eq!(answers.propose(grown,500,300,450),id);
        let job=answers.find_mut(&id).unwrap();
        assert!(!refresh_question_context(job,&engine.context),"A retracted same-question draft must not become a changed reference fact");
        assert_eq!(job.updates.borrow().context.as_deref(),Some(baseline.as_str()));
        assert!(baseline.contains("let exact=17;"));
    }
    #[test]
    fn resumed_remote_clause_rejects_queued_terminal_events_until_reconfirmed() {
        let mut answers=meeting::scheduler::Scheduler{semantic_intent:true,..Default::default()};
        let question="Evaluate -1 and x < y";
        let id=answers.confirm_with_context(question.into(),300,100,200,Some("Exact previous code".into()));answers.next(300);
        let job=answers.find_mut(&id).unwrap();job.steer_supported=true;job.latency.remote_speech_started_at=Some(0);
        // A same-worded older request must not steal the new floor's candidate.
        assert!(answers.resume_remote_question(question,Some(6000)).is_none());
        assert_eq!(answers.resume_remote_question(question,Some(0)),Some(id.clone()));
        let key=crate::openai::codex::context_key("Exact previous code");let job=answers.find_mut(&id).unwrap();
        assert!(gate_question_work(job,Work::QuestionComplete(id.clone(),question.into(),key)).is_none());
        assert!(gate_question_work(job,Work::NoReply(id.clone(),question.into(),key)).is_none());
        let grown=format!("{question} and derive the invariant");
        assert_eq!(answers.propose(grown.clone(),760,100,200),id);
        let job=answers.find_mut(&id).unwrap();assert!(!job.confirmed&&!job.cancel.is_cancelled());
        assert!(job.updates.borrow().context.as_ref().is_none()); // Runtime refresh supplies the logical-turn context.
        assert_eq!(answers.confirm_with_context(grown.clone(),1500,1200,1400,Some("Exact previous code".into())),id);
        let job=answers.find_mut(&id).unwrap();
        assert!(gate_question_work(job,Work::QuestionComplete(id.clone(),question.into(),key)).is_none());
        assert!(matches!(gate_question_work(job,Work::QuestionComplete(id,grown,key)),Some(Work::Complete(_))));
    }
    #[test]
    fn queued_old_completion_and_ignore_do_not_close_a_corrected_question() {
        let mut answers=meeting::scheduler::Scheduler{semantic_intent:true,..Default::default()};
        let question="What is the launch date?";
        let id=answers.propose(question.into(),0,0,0);
        let old=crate::openai::codex::context_key("February 19");
        answers.find_mut(&id).unwrap().set_context("February 19".into());answers.next(0);
        answers.find_mut(&id).unwrap().steer_supported=true;
        answers.confirm_with_context(question.into(),10,10,10,Some("March 22".into()));
        let job=answers.find_mut(&id).unwrap();let current=crate::openai::codex::context_key("March 22");
        assert!(gate_question_work(job,Work::QuestionComplete(id.clone(),question.into(),old)).is_none());
        assert!(gate_question_work(job,Work::NoReply(id.clone(),question.into(),old)).is_none());
        assert!(gate_question_work(job,Work::QuestionDelta(id.clone(),question.into(),old,"February 19".into())).is_none());
        assert!(job.confirmed&&!job.cancel.is_cancelled()&&job.latency.completed_at.is_none());
        assert!(matches!(gate_question_work(job,Work::QuestionComplete(id.clone(),question.into(),current)),Some(Work::Complete(_))));
        assert!(matches!(gate_question_work(job,Work::NoReply(id.clone(),question.into(),current)),Some(Work::NoReply(_,_,_))));
        // Once the obsolete process finishes, this still-unanswered corrected
        // job can take a slot again instead of being left permanently complete.
        job.running=false;assert_eq!(answers.next(20),Some(id));
    }
    #[test]
    fn ignored_automatic_turn_returns_to_listening_without_overwriting_manual_input() {
        let mut engine=Engine::default();engine.view.active=true;engine.view.status="question".into();
        let mut answers=meeting::scheduler::Scheduler::default();
        let id=answers.confirm("The issue has been resolved".into(),0,0,0);
        let job=answers.find_mut(&id).unwrap();job.steer_supported=true;job.phase=meeting::scheduler::Phase::Cancelled;job.confirmed=false;job.latency.completed_at=Some(1);
        sync_answers(&mut engine,&answers);
        assert_eq!(engine.view.status,"listening");assert!(engine.view.question.is_none());
        engine.view.manual=true;engine.view.status="question".into();
        sync_answers(&mut engine,&answers);assert_eq!(engine.view.status,"question");
    }
    #[test]
    fn next_question_can_reference_the_exact_visible_streaming_suggestion() {
        let mut engine=Engine::default();engine.view.active=true;
        let mut answers=meeting::scheduler::Scheduler::default();
        let id=answers.confirm("Implement it".into(),0,0,0);answers.next(0);
        let job=answers.find_mut(&id).unwrap();job.steer_supported=true;job.buffer="```rust\nlet changed=7;".into();
        sync_answers(&mut engine,&answers);
        assert!(engine.context.prompt("Why 7?").contains(&engine.view.answer));
        assert!(engine.context.prompt("Why 7?").contains("may be unfinished"));
        assert!(engine.view.latency.as_ref().unwrap().completed_at.is_none());
    }
}
fn gate_question_work(job:&meeting::scheduler::Job,work:Work)->Option<Work> {
    match work {
        Work::QuestionDelta(id,question,key,text)=>job.accepts_stream(&question,&key).then_some(Work::Delta(id,text)),
        Work::QuestionComplete(id,question,key)=>(job.confirmed&&job.accepts_stream(&question,&key)).then_some(Work::Complete(id)),
        Work::NoReply(id,question,key)=>(job.confirmed&&job.accepts_stream(&question,&key)).then_some(Work::NoReply(id,question,key)),
        other=>Some(other),
    }
}
fn refresh_question_context(job:&mut meeting::scheduler::Job,context:&meeting::context::MeetingContext)->bool {
    job.set_context(context.answer_context_for_utterance(&job.question.text,job.latency.remote_speech_started_at))
}
fn resume_answer_question(answers:&mut meeting::scheduler::Scheduler,context:&mut meeting::context::MeetingContext,question:&str,started:Option<u64>)->Option<String> {
    let id=answers.resume_remote_question(question,started)?;
    // The same logical question's displayed draft is retracted on resume. It
    // must not become its own new reference context. Other answers remain exact
    // snapshots for genuine follow-ups, including unfinished displayed code.
    context.forget_visible_answer(&id);
    Some(id)
}
fn update_acoustic_quiet(answers:&mut meeting::scheduler::Scheduler,detector:&meeting::questions::QuestionDetector) {
    // Evaluate on the isolated acceptance app before changing the release policy.
    let enabled=meeting::intent::Mode::configured()==meeting::intent::Mode::Learned
        || (cfg!(all(feature="acceptance",debug_assertions))
        &&std::env::var("COPILOT_ACOUSTIC_REFINE").as_deref()==Ok("1"));
    if let Some(id)=answers.candidate.clone(){if let Some(job)=answers.find_mut(&id){
        if job.latency.remote_speech_started_at==detector.remote_turn_started_at {
            job.set_acoustic_quiet(enabled&&detector.remote_quiet);
        }
    }}
}
#[allow(clippy::too_many_arguments)]
fn drive_answers(app:&tauri::AppHandle,engine:&Engine,s:&Session,auth:&Arc<Auth>,client:&Client,timings:&crate::openai::timing::Registry,tx:mpsc::Sender<Work>,answers:&mut meeting::scheduler::Scheduler,now:u64) {
    while let Some(id)=answers.next(now) {
        let job=answers.find_mut(&id).unwrap();let cancel=job.cancel.clone();
        job.steer_supported=s.settings.answer_backend==AnswerBackend::Codex;
        let selected_context=job.updates.borrow().context.clone().unwrap_or_else(||engine.context.answer_context_for_utterance(&job.question.text,job.latency.remote_speech_started_at));
        job.set_context(selected_context.clone());
        let updates=job.updates.subscribe();
        let input=crate::openai::codex::QuestionPrompt::new(selected_context,job.question.text.clone()).with_reference(engine.project.as_ref().map(|project|project.prompt()).unwrap_or_default());
        let image=engine.screenshot_data.clone();let model=s.settings.model.clone();let auth=auth.clone();let clock=s.clock;let tx=tx.clone();
        let client=client.clone().with_backend(s.settings.answer_backend,s.settings.service_tier.as_deref()).with_reasoning(s.settings.reasoning_effort.as_deref());
        let trace=crate::openai::timing::Trace::new(clock,job.question.detected_at);trace.prompt_chars(input.render().chars().count());if job.confirmed{trace.confirmed_at(job.latency.question_confirmed_at);}
        crate::openai::timing::register(timings,id.clone(),trace.clone());let client=client.with_refill(s.settings.codex_refill_policy).with_trace(trace);
        emit(app,"answer.started",serde_json::json!({"id":id,"speculative":!job.confirmed}));
        #[cfg(all(feature="acceptance",debug_assertions))]
        let diagnostic_app=app.clone();
        tauri::async_runtime::spawn(async move {
            #[cfg(all(feature="acceptance",debug_assertions))]
            let mut prefix=meeting::provisional::Prefix::default();
            let result=async {let token=answer_token(&auth,&client,&cancel).await?;
                tx.send(Work::Sent(id.clone(),clock.elapsed().as_millis()as u64)).await.map_err(|_|"Meeting receiver closed".to_string())?;
                client.stream_question(&token,&model,&prompts::answer_instructions(prompts::ANSWER),&input,image.as_deref(),cancel.clone(),updates,|event|{
                    #[cfg(all(feature="acceptance",debug_assertions))]
                    if std::env::var("COPILOT_TRACE_PROVISIONAL").as_deref()==Ok("1") {
                        match &event {
                            StreamEvent::Revision(_)=>prefix.reset(),
                            StreamEvent::QuestionDelta{question,context_key,text}=>{
                                if let Some(mut observation)=prefix.observe(question,*context_key,text,clock.elapsed().as_millis()as u64){
                                    observation["id"]=serde_json::json!(id);emit(&diagnostic_app,"answer.provisional_prefix",observation);
                                }
                            },_=>{}
                        }
                    }
                    let event=match event{StreamEvent::Delta(d)=>Work::Delta(id.clone(),d),StreamEvent::Revision(text)=>Work::Revision(id.clone(),text),StreamEvent::QuestionDelta{question,context_key,text}=>Work::QuestionDelta(id.clone(),question,context_key,text),StreamEvent::NoReply{question,context_key}=>Work::NoReply(id.clone(),question,context_key),StreamEvent::QuestionCompleted{question,context_key}=>Work::QuestionComplete(id.clone(),question,context_key),StreamEvent::Completed=>Work::Complete(id.clone())};let tx=tx.clone();async move{tx.send(event).await.map_err(|_|"Meeting receiver closed".to_string())}}).await
            }.await;
            if !cancel.is_cancelled(){if let Err(e)=result{let _=tx.send(Work::Error(id.clone(),e)).await;}}
            let _=tx.send(Work::Finished(id)).await;
        });
    }
}
async fn answer_token(auth: &Arc<Auth>, client: &Client, cancel: &CancellationToken) -> Result<String, String> {
    if cancel.is_cancelled() { return Err("cancelled".into()); }
    if !client.requires_token() { return Ok(String::new()); }
    tokio::select! { _=cancel.cancelled()=>Err("cancelled".into()), token=auth.token()=>token }
}
fn validate_answer_settings(settings: &Settings) -> Result<(), String> {
    if settings.service_tier.as_deref().is_some_and(|tier| !["fast", "default"].contains(&tier)) {
        return Err("Choose Standard or Fast answer speed".into());
    }
    Ok(())
}
#[tauri::command]
async fn sign_in(rt: State<'_, Runtime>, client_id: Option<String>) -> Result<Account, String> {
    let _lock = rt.lifecycle.lock().await;
    if rt.view.lock().unwrap().active {
        return Err("Stop the meeting before changing accounts".into());
    }
    let a = if load_settings(&rt.db)?.answer_backend == AnswerBackend::Codex {
        let codex=rt.client.codex.as_ref().ok_or("Codex runtime is unavailable")?;
        codex.sign_in().await?;
        codex.account().await?.ok_or("Codex sign-in did not complete")?
    } else { rt.auth.sign_in(client_id).await? };
    rt.models.lock().await.clear();
    Ok(a)
}
#[tauri::command]
async fn cancel_sign_in(rt: State<'_, Runtime>) -> Result<(), String> {
    rt.auth.cancel_sign_in().await;
    if let Some(codex)=&rt.client.codex { codex.close(); }
    Ok(())
}
#[tauri::command]
async fn select_account(rt: State<'_, Runtime>, client_id: String) -> Result<(), String> {
    let _lock = rt.lifecycle.lock().await;
    if rt.view.lock().unwrap().active {
        return Err("Stop the meeting before changing accounts".into());
    }
    rt.auth.select(&client_id).await?;
    rt.models.lock().await.clear();
    Ok(())
}
#[tauri::command]
async fn sign_out(rt: State<'_, Runtime>, client_id: String) -> Result<Option<String>, String> {
    let _lock = rt.lifecycle.lock().await;
    let (tx, rx) = oneshot::channel();
    send(&rt, Control::Stop(tx)).await?;
    rx.await.map_err(|e| e.to_string())??;
    let warning = rt.auth.sign_out(&client_id).await?;
    rt.models.lock().await.clear();
    Ok(warning)
}
#[tauri::command]
async fn list_models(rt: State<'_, Runtime>) -> Result<Vec<Model>, String> {
    let settings=load_settings(&rt.db)?;
    let client=rt.client.clone().with_backend(settings.answer_backend, settings.service_tier.as_deref());
    let token = if client.requires_token() { rt.auth.token().await? } else { String::new() };
    let models = client.models(&token).await?;
    *rt.models.lock().await = models.clone();
    Ok(models)
}
#[tauri::command]
async fn save_settings(rt: State<'_, Runtime>, settings: Settings) -> Result<(), String> {
    if rt.view.lock().unwrap().active {
        return Err("Stop the meeting before changing devices".into());
    }
    validate_answer_settings(&settings)?;
    rt.models.lock().await.clear();
    rt.db.set(
        "audio_settings",
        &serde_json::to_string(&settings).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
async fn start_meeting(rt: State<'_, Runtime>, settings: Settings) -> Result<(), String> {
    validate_answer_settings(&settings)?;
    if settings.speech_backend==SpeechBackend::Nemotron {transcription::nemotron::right_context(settings.speech_chunk_ms)?;}
    if settings
        .reasoning_effort
        .as_deref()
        .is_some_and(|e| !["none", "low", "medium", "high", "xhigh"].contains(&e))
    {
        return Err("Choose a supported reasoning effort".into());
    }
    let _lock = rt.lifecycle.lock().await;
    if rt.view.lock().unwrap().active {
        return Err("A meeting is already active".into());
    }
    let client=rt.client.clone().with_backend(settings.answer_backend, settings.service_tier.as_deref());
    let token = if client.requires_token() { rt.auth.token().await? } else {
        if rt.client.codex.as_ref().ok_or("Codex runtime is unavailable")?.account().await?.is_none(){return Err("Sign in to Codex before starting a meeting".into());}
        String::new()
    };
    let models = client.models(&token).await?;
    if !models.iter().any(|m| m.slug == settings.model) {
        return Err("Choose a model from the account catalog".into());
    }
    rt.db.set(
        "audio_settings",
        &serde_json::to_string(&settings).map_err(|e| e.to_string())?,
    )?;
    let (tx, rx) = oneshot::channel();
    send(&rt, Control::Start(settings, tx)).await?;
    drop(_lock);
    rx.await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn stop_meeting(rt: State<'_, Runtime>) -> Result<(), String> {
    let _lock = rt.lifecycle.lock().await;
    let (tx, rx) = oneshot::channel();
    send(&rt, Control::Stop(tx)).await?;
    rx.await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn ask(rt: State<'_, Runtime>, question: String) -> Result<(), String> {
    if !rt.view.lock().unwrap().active {
        return Err("Start a meeting first".into());
    }
    if question.trim().is_empty() || question.len() > 4000 {
        return Err("Enter a question under 4000 characters".into());
    }
    send(&rt, Control::Manual(question)).await
}
#[tauri::command]
async fn action(
    app: tauri::AppHandle,
    rt: State<'_, Runtime>,
    action: String,
) -> Result<(), String> {
    match action.as_str() {
        "hide" => {
            window::toggle(&app, &rt.hidden);
            emit(
                &app,
                if rt.hidden.load(Ordering::Acquire) {
                    "overlay.hide"
                } else {
                    "overlay.show"
                },
                (),
            );
            Ok(())
        }
        "pause" => send(&rt, Control::Pause).await,
        "manual" => send(&rt, Control::ManualOpen).await,
        "dismiss" => send(&rt, Control::Dismiss).await,
        "expand" => send(&rt, Control::Expand).await,
        "project" => send(&rt, Control::Project(None)).await,
        "clear_project" => send(&rt, Control::ClearProject).await,
        "screenshot" => send(&rt, Control::Screenshot).await,
        "clear_screenshot" => send(&rt, Control::ClearScreenshot).await,
        _ => Err("Unknown action".into()),
    }
}
#[tauri::command]
fn resize_overlay(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    window::resize(&app, height)
}
#[tauri::command]
async fn choose_project(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let owner = app.get_webview_window("main").ok_or("Main window missing")?.hwnd().map_err(|e| e.to_string())?.0 as usize;
    #[cfg(not(windows))]
    let owner = { let _ = app; 0 };
    tokio::task::spawn_blocking(move || crate::attachments::folder::choose(owner)).await.map_err(|_| "Folder picker failed".to_string())?
}
#[tauri::command]
async fn send_project(rt: State<'_, Runtime>, path: String) -> Result<(), String> {
    if !rt.view.lock().unwrap().active { return Err("Start a meeting first".into()); }
    send(&rt, Control::Project(Some(path))).await
}
#[tauri::command]
fn manage_usage() -> Result<(), String> {
    webbrowser::open("https://chatgpt.com/#settings/Usage")
        .map(|_| ())
        .map_err(|_| "Could not open ChatGPT usage settings".into())
}
#[tauri::command]
fn open_debug(app: tauri::AppHandle) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("Debug transcript is unavailable in production".into());
    }
    if let Some(w) = app.get_webview_window("debug") {
        w.show().map_err(|e| e.to_string())?;
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "debug",
            tauri::WebviewUrl::App("index.html?view=debug".into()),
        )
        .title("Local transcript Â· development only")
        .inner_size(720., 600.)
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn run() {
    #[cfg(windows)]
    let _instance = {
        let scope = if crate::openai::acceptance_mode() {
            std::env::var("COPILOT_DATA_DIR").unwrap_or_else(|_| "acceptance".into())
        } else {
            "local.meeting.copilot/oauth".into()
        };
        match crate::storage::instance::InstanceLock::acquire(&scope) {
            Ok(Some(lock)) => lock,
            Ok(None) => return,
            Err(error) => {
                eprintln!("{error}");
                return;
            }
        }
    };
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            use tauri_plugin_global_shortcut::{Code, ShortcutState};
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let rt = app.state::<Runtime>();
            if shortcut.key == Code::KeyH {
                window::toggle(app, &rt.hidden);
                return;
            }
            let c = match shortcut.key {
                Code::Space => Control::ManualOpen,
                Code::KeyX => Control::Dismiss,
                Code::KeyM => Control::Pause,
                Code::ArrowUp => Control::Expand,
                Code::KeyP => Control::Project(None),
                Code::F8 => Control::Screenshot,
                _ => return,
            };
            let _ = rt.tx.try_send(c);
        })
        .build();
    tauri::Builder::default()
        .plugin(plugin)
        .invoke_handler(tauri::generate_handler![
            answer_visible,
            get_answer_timings,
            get_snapshot,
            acceptance_event,
            acceptance_jobs,
            acceptance_protection,
            native_diagnostics,
            bootstrap,
            sign_in,
            cancel_sign_in,
            select_account,
            sign_out,
            list_models,
            save_settings,
            start_meeting,
            stop_meeting,
            ask,
            choose_project,
            send_project,
            action,
            resize_overlay,
            manage_usage,
            open_debug
            ,crate::gaze::gaze_snapshot,crate::gaze::gaze_devices,crate::gaze::gaze_start,crate::gaze::gaze_control,crate::gaze::gaze_stop
        ])
        .setup(|app| {
            app.manage(crate::gaze::Runtime::new(app.handle())?);
            #[cfg(debug_assertions)] eprintln!("runtime: setup");
        let dir = if cfg!(debug_assertions) {
                std::env::var_os("COPILOT_DATA_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?)
            } else {
                app.path().app_data_dir()?
            };
        std::fs::create_dir_all(&dir)?;
        let bundled=app.path().resolve("models/ggml-tiny.en.bin",tauri::path::BaseDirectory::Resource)?;
        let source=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/ggml-tiny.en.bin");
        let default_model=if cfg!(debug_assertions)&&source.is_file(){source}else{bundled}.to_string_lossy().into_owned();
        let asset=|resource:&str,development:&str|->Result<String,tauri::Error>{let source=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(development);let path=if cfg!(debug_assertions)&&source.is_file(){source}else{app.path().resolve(resource,tauri::path::BaseDirectory::Resource)?};Ok(path.to_string_lossy().into_owned())};
        let default_nemotron_model=asset("models/nemotron-speech-streaming-en-0.6b.q8_0.gguf","../models/nemotron-speech-streaming-en-0.6b.q8_0.gguf")?;
        let default_nemotron_runtime=asset("nemotron/nemo-speech.exe","../.local/nemotron/nemo-speech-0.2.0-windows-x86_64-vulkan/bin/nemo-speech.exe")?;
            let db = Arc::new(
                Database::open(&dir.join("settings.sqlite")).map_err(std::io::Error::other)?,
            );
            let auth = Arc::new(Auth::new(db.clone()).map_err(std::io::Error::other)?);
            #[cfg(debug_assertions)] eprintln!("runtime: local storage ready");
            let mut client = Client::default();
            let codex_binary=asset("codex/codex.exe","../.local/codex/codex.exe")?;
            client.codex=Some(crate::openai::codex::Codex::new(std::path::PathBuf::from(codex_binary),dir.join("codex-work")));
            let hidden = Arc::new(AtomicBool::new(false));
            let protection = window::create(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(debug_assertions)] eprintln!("runtime: overlay ready");
            let view = Arc::new(Mutex::new(Snapshot {
                protection,
                ..Default::default()
            }));
            let (tx, rx) = mpsc::channel(64);
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let mut shortcut_errors=vec![];
            for key in ["Ctrl+Shift+Space","Ctrl+Shift+H","Ctrl+Shift+X","Ctrl+Shift+M","Ctrl+Shift+ArrowUp","Ctrl+Shift+P","Ctrl+Shift+F8"]{
                if app.global_shortcut().register(key).is_err(){shortcut_errors.push(format!("{key} is unavailable; another app may be using it. The on-screen control still works."));}
            }
            let timings:crate::openai::timing::Registry=Default::default();
            app.manage(Runtime {
                timings:timings.clone(),
                tx,
                view: view.clone(),
                auth: auth.clone(),
                db: db.clone(),
                client: client.clone(),
                hidden: hidden.clone(),
                lifecycle: tokio::sync::Mutex::new(()),
            models: tokio::sync::Mutex::new(vec![]),
            default_model,
            default_nemotron_model,
            default_nemotron_runtime,
            shortcut_errors,
            });
            #[cfg(debug_assertions)] eprintln!("runtime: shortcuts ready");
            tauri::async_runtime::spawn(actor(
                app.handle().clone(),
                rx,
                view,
                auth,
                db,
                client,
                hidden,
                timings,
            ));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize Meeting Copilot")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } = event
            {
                if label == "main" {
                    api.prevent_close();
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let rt = handle.state::<Runtime>();
                        rt.auth.begin_shutdown();
                        rt.auth.cancel_sign_in().await;
                        let (tx, rx) = oneshot::channel();
                        let _ = rt.tx.send(Control::Stop(tx)).await;
                        let _ = rx.await;
                        let _ = crate::gaze::gaze_stop(handle.clone()).await;
                        rt.auth.wait_for_token_requests().await;
                        handle.exit(0);
                    });
                }
            }
        });
}
