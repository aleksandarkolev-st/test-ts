use crate::{
    attachments::screen_monitor::{
        field_is_eligible, FieldObservation, InsertionGuard, MonitorConfig, QuestionDeduper,
        DEFAULT_TTL,
    },
    audio,
    meeting::{
        self,
        state::{Engine, Latency, Snapshot},
        InputEvent, SpeakerSource,
    },
    monitor::{
        protocol::TypingSpeed,
        service::{MonitorStatus, MonitorUpdate},
        typing::{self, TypingOutcome},
        vision::clean_solution,
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
fn default_monitor_interval() -> u32 { 5 }
fn default_monitor_typing() -> bool { true }
fn default_monitor_speed() -> String { "normal".into() }
#[derive(Clone,Copy,Default,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum AnswerObjective {#[default] Brief,Detailed}
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
    #[serde(default)] pub answer_objective: AnswerObjective,
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
    #[serde(default)]
    pub screen_monitor_enabled: bool,
    #[serde(default = "default_monitor_interval")]
    pub screen_monitor_interval_seconds: u32,
    #[serde(default = "default_monitor_typing")]
    pub screen_monitor_typing: bool,
    #[serde(default = "default_monitor_speed")]
    pub screen_monitor_speed: String,
}
impl Default for Settings {
    fn default() -> Self { Self { microphone:String::new(),output:String::new(),model_path:String::new(),model:String::new(),answer_objective:AnswerObjective::Brief,reasoning_effort:Some("low".into()),answer_backend:AnswerBackend::Codex,service_tier:Some("fast".into()),codex_refill_policy:Default::default(),project_path:String::new(),screen_monitor_enabled:false,screen_monitor_interval_seconds:default_monitor_interval(),screen_monitor_typing:default_monitor_typing(),screen_monitor_speed:default_monitor_speed(),speech_backend:SpeechBackend::Nemotron,speech_chunk_ms:160,nemotron_runtime:String::new(),nemotron_device:1,nemotron_device_name:None } }
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
    #[cfg(all(windows, feature = "desktop-dc-experiment"))]
    DesktopDcError(String),
    #[cfg(all(feature = "acceptance", debug_assertions))]
    Protection(bool, oneshot::Sender<()>),
    #[cfg(all(feature = "acceptance", debug_assertions))]
    Inject(InputEvent, oneshot::Sender<u64>),
    #[cfg(all(feature = "acceptance", debug_assertions))]
    InspectJobs(oneshot::Sender<serde_json::Value>),
    #[cfg(all(feature = "acceptance", debug_assertions))]
    FreezeContext(String, String, oneshot::Sender<Result<(), String>>),
    Start(Settings, oneshot::Sender<Result<(), String>>),
    Stop(oneshot::Sender<Result<(), String>>),
    Pause,
    ManualOpen,
    Manual(String),
    AnswerNow(String),
    Displayed(String,u64,String,usize,usize,u64),
    Dismiss,
    NewTask,
    UpdateTask(String, String, String),
    Expand(Option<String>),
    Project(Option<String>, String),
    DetectContext,
    ContextDetected(String, String, Result<crate::attachments::active_context::ActiveContext, String>),
    ClearProject,
    Screenshot(Option<usize>, String),
    ClearScreenshot,
    MonitorAbort,
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
    Summary(String, String, meeting::context::Memory),
    SummaryError(String, String, String),
    Project(String, String, Result<crate::attachments::project::Project, String>),
    Screenshot(String, String, Result<crate::attachments::screenshot::Screenshot, String>),
    /// A solution for an on-screen question: session, source window, question,
    /// cache generation, and the solution-only text (or the generation error).
    MonitorSolution(String, usize, String, u64, Result<String, String>),
    /// The typing worker finished, aborted, or failed to type one answer.
    MonitorTyped(TypingOutcome),
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
    engine.view.can_answer_now=conversation_input_enabled(engine)&&engine.detector.can_accept_now();
    engine.view.revision += 1;
    *view.lock().unwrap() = engine.view.clone();
    #[cfg(all(windows, feature = "desktop-dc-experiment"))]
    crate::overlay::desktop_dc::update(&engine.view);
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
        let brief=prompts::answer_instructions(prompts::BRIEF);
        codex.prewarm(&settings.model,settings.service_tier.as_deref(),settings.reasoning_effort.as_deref(),&brief,&cancel).await?;
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
/// How long vision evidence that the answer field is focused authorizes a
/// typing attempt after it was observed. The live foreground window is still
/// re-checked immediately before typing; evidence older than this is ignored.
const FOCUS_EVIDENCE_WINDOW_MS: u64 = 30_000;
/// Debug-build tracing for the screen monitor; silent in release builds.
macro_rules! monitor_trace {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("monitor: {}", format_args!($($arg)*));
        }
    };
}
/// Vision evidence that the answer field of the analyzed window was focused.
struct FocusEvidence {
    at: u64,
    window: usize,
    executable: String,
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
    engine.detector.conversation_endpoints=true;
    engine.view.protection = view.lock().unwrap().protection;
    let mut session: Option<Session> = None;
    let mut starting: Option<Starting> = None;
    let mut generation: Option<CancellationToken> = None;
    let mut answers = meeting::scheduler::Scheduler::default();
    #[allow(unused_mut)]
    let mut intent_mode=meeting::intent::Mode::configured();
    let mut intent_gate=meeting::intent::Gate::default();
    let intent_threshold=meeting::intent::ready_threshold();
    let quiet_priority=meeting::intent::quiet_priority_enabled();
    let mut summary: Option<CancellationToken> = None;
    let (mut events_tx, mut events) = mpsc::channel(256);
    let (work_tx, mut work) = mpsc::channel(256);
    let (monitor_tx, mut monitor_updates) = mpsc::channel(64);
    let mut monitor_cancel: Option<CancellationToken> = None;
    let mut monitor_deduper = QuestionDeduper::default();
    let mut monitor_question: Option<(String, usize)> = None;
    let mut monitor_pending: Option<u64> = None;
    let mut monitor_focus: Option<FocusEvidence> = None;
    let mut monitor_insertion = InsertionGuard::default();
    let mut typing_worker: Option<typing::Worker> = None;
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
                #[cfg(all(windows, feature="desktop-dc-experiment"))]
                Control::DesktopDcError(error)=>{engine.view.error=Some(error);engine.view.status="error".into();publish(&app,&mut engine,&view);},
                #[cfg(all(feature="acceptance",debug_assertions))] Control::InspectJobs(reply)=>{
                    let now=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64);
                    let traces=timings.lock().unwrap();
                    let jobs=answers.jobs.iter().map(|job|{
                        let mut latency=job.latency.clone();
                        if let Some(trace)=traces.get(&job.question.id){latency.pipeline=trace.snapshot();}
                        serde_json::json!({"question":job.question,"phase":job.phase,"confirmed":job.confirmed,
                            "running":job.running,"cancelled":job.cancel.is_cancelled(),"answer":job.buffer,"focusAuthorizedAt":job.focus_authorized_at,
                            "error":job.error,"latency":latency,"selectedContext":job.updates.borrow().context.clone()})
                    }).collect::<Vec<_>>();
                    let speech_transport=session.as_ref().and_then(|s|s.pipeline.as_ref()).and_then(|p|match &p.transcription{SpeechPipeline::Nemotron(n)=>Some(n.acceptance_transport()),SpeechPipeline::Whisper(_)=>None});
                    let _=reply.send(serde_json::json!({"nativeNow":now,"speechTransport":speech_transport,"view":engine.view,"jobs":jobs,"archive":{"recognizedRevisions":engine.context.ledger.recognized.len(),"suggestions":engine.context.ledger.suggestions.len(),"accepted":engine.context.ledger.accepted.len(),"version":engine.context.ledger.version,
                        "recognizedRevisionBytes":engine.context.ledger.recognized.iter().map(|r|r.segment.text.len()).sum::<usize>(),
                        "generatedBytes":engine.context.ledger.suggestions.iter().map(|s|s.generated.len()).sum::<usize>(),
                        "paintedRanges":engine.context.ledger.suggestions.iter().map(|s|s.painted_ranges.len()).sum::<usize>(),
                        "paintedRangeBytes":engine.context.ledger.suggestions.iter().flat_map(|s|s.painted_ranges.iter()).map(|(_,start,end)|end-start).sum::<usize>(),
                        "paintMetadataBytes":engine.context.ledger.suggestions.iter().map(|s|s.painted_ranges.capacity()*std::mem::size_of::<(u64,usize,usize)>()).sum::<usize>(),
                        "displayedBytes":engine.context.ledger.suggestions.iter().map(|s|s.display_versions.iter().chain(std::iter::once(&s.displayed)).flat_map(|v|v.iter()).map(|(_,text)|text.len()).sum::<usize>()).sum::<usize>()}}));
                },
                #[cfg(all(feature="acceptance",debug_assertions))] Control::FreezeContext(context,policy,reply)=>{
                    if !engine.view.active || !answers.jobs.is_empty() || generation.is_some() {
                        let _=reply.send(Err("Frozen replay context requires an active, dismissed meeting".into()));
                    } else {
                        engine.context.frozen_acceptance_context=(!context.is_empty()).then_some(context);
                        intent_mode=if policy=="final" {meeting::intent::Mode::FinalOnly}else{meeting::intent::Mode::Existing};
                        let _=reply.send(Ok(()));
                    }
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
                    if let Some(cancel)=monitor_cancel.take(){cancel.cancel();}
                    if let Some(worker)=typing_worker.take(){worker.shutdown();}
                    monitor_deduper=QuestionDeduper::default();monitor_question=None;monitor_pending=None;monitor_focus=None;monitor_insertion=InsertionGuard::default();
                    if let Some(pending)=starting.take(){pending.cancel.cancel();let _=pending.reply.send(Err("Speech startup cancelled".into()));}
                    answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);if let Some(c)=summary.take(){c.cancel()}
                    if let Some(codex)=&client.codex { codex.close(); }
                    let result=if let Some(mut s)=session.take(){if let Some(mut p)=s.pipeline.take(){let _=tokio::task::spawn_blocking(move||p.stop()).await;}db.stop(&s.id,crate::openai::auth::now())}else{Ok(())};
                    let (tx, rx) = mpsc::channel(256); events_tx = tx; events = rx; while work.try_recv().is_ok(){}*levels.lock().unwrap()=(0.,0.);engine.clear_meeting();window::set_manual(&app,false);window::hide(&app);publish(&app,&mut engine,&view);emit(&app,"meeting.stopped",());let _=reply.send(result);
                },
                Control::Pause=>{if let Some(s)=session.as_mut(){
                    intent_gate.invalidate();
                    answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.view.answer.clear();engine.view.question=None;engine.detector.clear();
                    if let Some(mut p)=s.pipeline.take(){let _=tokio::task::spawn_blocking(move||p.stop()).await;engine.view.paused=true;*levels.lock().unwrap()=(0.,0.);let (tx, rx) = mpsc::channel(256); events_tx = tx; events = rx; engine.view.error=None;engine.view.status="listening".into();if let Some(cancel)=monitor_cancel.take(){cancel.cancel();}if let Some(worker)=typing_worker.take(){worker.shutdown();}monitor_deduper=QuestionDeduper::default();monitor_question=None;monitor_pending=None;monitor_focus=None;monitor_insertion=InsertionGuard::default();engine.view.monitor=None;}
                    else {let model=s.model.clone();let settings=s.settings.clone();let clock=s.clock;let tx=events_tx.clone();let lv=levels.clone();match pipeline(model,&settings,clock,tx,lv).await{Ok(p)=>{s.pipeline=Some(p);engine.view.paused=false;engine.view.status="listening".into();engine.view.error=None;if let Some(start)=spawn_monitor(s,&client,&auth,monitor_tx.clone(),work_tx.clone()){monitor_cancel=Some(start.cancel);typing_worker=start.typing;engine.view.monitor=Some(MonitorStatus::watching());monitor_deduper=QuestionDeduper::default();monitor_question=None;monitor_pending=None;monitor_focus=None;monitor_insertion=InsertionGuard::default();}},Err(e)=>{engine.view.error=Some(e);engine.view.status="error".into();}}}
                    publish(&app,&mut engine,&view);
                }},
                Control::Displayed(id,revision,text,visible_start,visible_end,paint_host_ms)=>{if let Some(s)=session.as_ref(){
                    let now=s.clock.elapsed().as_millis()as u64;
                    let host_now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()as u64;
                    if revision==0 {if let Some(at)=display_session_time(now,host_now,paint_host_ms){
                        // Browser offsets are UTF-16, while the exact source
                        // ledger uses UTF-8 byte boundaries.
                        if let (Some(start),Some(end))=(utf16_byte_offset(&text,visible_start),utf16_byte_offset(&text,visible_end)){
                            let accepted=engine.context.ledger.acknowledge_paint(&id,&text,start,end,at);
                            // Local evaluation observes the actual ledger verdict rather
                            // than replacing Tauri's intentionally read-only IPC bridge.
                            #[cfg(debug_assertions)]
                            let _=app.emit_to("overlay","copilot:paint",serde_json::json!({
                                "id":id,"revision":revision,"start":visible_start,"end":visible_end,
                                "textLength":text.encode_utf16().count(),"source":&text[start..end],
                                "paintHostMs":paint_host_ms,"sessionPaintMs":at,"accepted":accepted
                            }));
                            #[cfg(not(debug_assertions))]
                            let _=accepted;
                        }
                    }}
                }},
                Control::AnswerNow(expected)=>{if let Some(s)=session.as_ref(){if conversation_input_enabled(&engine)&&answers.candidate.as_deref()==Some(expected.as_str()) {
                    let now=s.clock.elapsed().as_millis()as u64;
                    if let Some((question,stopped))=engine.detector.confirm_now(now) {
                        if let Some(floor)=engine.detector.remote_turn_started_at {
                            engine.context.ledger.associate_remote_utterance(floor,engine.detector.recognized_segment_ids());
                        }
                        cancel_answer(&app,&mut generation);if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}
                        let context=engine.context.answer_context_for_utterance(&question,speech_metrics.remote_speech_started_at);
                        let id=answers.confirm_explicit_with_context(question,now,stopped,transcript_at,context);
                        engine.context.ledger.accept(&id,&answers.find_mut(&id).unwrap().question.text,now);
                        let revision=speech_metrics.remote_speech_started_at.map(|floor|engine.context.ledger.accepted_revision(floor)).unwrap_or(0);
                        if let Some(job)=answers.find_mut(&id){job.explicit_request=true;job.context_version=engine.context.ledger.version;job.utterance_revision=revision;
                            job.latency.remote_speech_started_at=speech_metrics.remote_speech_started_at;job.latency.first_remote_partial_at=speech_metrics.first_remote_partial_at;
                            job.latency.first_credible_candidate_at=speech_metrics.first_credible_candidate_at;job.latency.remote_partial_updates=speech_metrics.remote_partial_updates;}
                        emit(&app,"question.confirmed",serde_json::json!({"id":id,"timestamp":now,"explicit":true}));
                        drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);
                    }
                }}},
                Control::ManualOpen=>{if session.is_some(){engine.view.manual=true;hidden.store(false,Ordering::Release);window::show(&app,&hidden);window::set_manual(&app,true);publish(&app,&mut engine,&view);}},
                Control::Manual(question)=>{if let Some(s)=session.as_ref(){let question=question.trim().to_string();if !question.is_empty()&&question.len()<=4000{engine.view.manual=false;window::set_manual(&app,false);cancel_answer(&app,&mut generation);if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}let now=s.clock.elapsed().as_millis()as u64;accept_typed_question(&mut engine,&mut answers,question,now);drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);}}},
                Control::Dismiss=>{answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.detector.clear();engine.view.question=None;engine.view.answer.clear();engine.view.error=None;engine.view.expanded=false;engine.view.manual=false;window::set_manual(&app,false);engine.view.status=if engine.view.active{"listening"}else{"off"}.into();publish(&app,&mut engine,&view);},
                Control::Expand(expected)=>{if let Some(s)=session.as_ref(){if let Some(q)=engine.view.question.clone().filter(|q|expected.as_ref().map_or(true,|id|q.id==*id)){let now=s.clock.elapsed().as_millis()as u64;if let Some(id)=answers.expand(&q.id,now){engine.view.expanded=true;cancel_answer(&app,&mut generation);if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}engine.context.ledger.accept(&id,&q.text,now);drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);}}}},
                Control::NewTask=>{if let Some(s)=session.as_ref(){
                    let now=s.clock.elapsed().as_millis()as u64;
                    project_request=None;screenshot_request=None;
                    answers.clear();cancel_answer(&app,&mut generation);
                    if let Some(c)=summary.take(){c.cancel();}
                    intent_gate=meeting::intent::Gate::default();speech_metrics=Latency::default();summary_retry_at=now;
                    monitor_deduper=QuestionDeduper::default();monitor_question=None;monitor_pending=None;monitor_focus=None;monitor_insertion=InsertionGuard::default();
                    engine.new_task(now);timings.lock().unwrap().clear();
                    emit(&app,"task.started",());
                    window::set_manual(&app,false);window::show(&app,&hidden);
                    publish(&app,&mut engine,&view);
                }},
                Control::UpdateTask(task_id,field,text)=>{if let Some(s)=session.as_ref(){
                    if engine.view.task.id!=task_id{continue;}
                    if let Err(error)=engine.view.task.update(&field,text){engine.view.error=Some(error);publish(&app,&mut engine,&view);continue;}
                    engine.view.error=None;
                    let question=engine.view.question.as_ref().map(|q|q.text.clone());
                    answers.clear();cancel_answer(&app,&mut generation);
                    if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}
                    if let Some(question)=question {
                        let now=s.clock.elapsed().as_millis()as u64;
                        accept_typed_question(&mut engine,&mut answers,question,now);
                        drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);
                    }
                    sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);
                }},
                Control::Project(path,task_id)=>{if task_id!=engine.view.task.id{continue;}if let Some(s)=session.as_ref(){
                    let path=path.unwrap_or_else(||s.settings.project_path.clone());
                    if path.trim().is_empty(){engine.view.error=Some("Choose a project folder in the main window first".into());publish(&app,&mut engine,&view);continue;}
                    let id=uuid::Uuid::new_v4().to_string();project_request=Some(id.clone());engine.view.attachment_busy=true;engine.view.error=None;publish(&app,&mut engine,&view);
                    let session_id=s.id.clone();let tx=work_tx.clone();
                    tauri::async_runtime::spawn(async move{let result=tokio::task::spawn_blocking(move||crate::attachments::project::collect(std::path::Path::new(&path))).await.map_err(|_|"Project collection failed".to_string()).and_then(|r|r);let _=tx.send(Work::Project(session_id,id,result)).await;});
                }},
                Control::DetectContext=>{if let Some(s)=session.as_ref(){
                    let session_id=s.id.clone();let task_id=engine.view.task.id.clone();let tx=app.state::<Runtime>().tx.clone();
                    tauri::async_runtime::spawn(async move{
                        let result=tokio::task::spawn_blocking(crate::attachments::active_context::detect).await.map_err(|_|"Context inspection failed".to_string()).and_then(|r|r);
                        let _=tx.send(Control::ContextDetected(session_id,task_id,result)).await;
                    });
                }},
                Control::ContextDetected(session_id,task_id,result)=>{if engine.view.task.id==task_id&&session.as_ref().is_some_and(|s|s.id==session_id){
                    match result {
                        Ok(context)=>{
                            emit(&app,"context.detected",&context);
                            let command=context.project_path.map(|p|Control::Project(Some(p),task_id.clone())).unwrap_or(Control::Screenshot(Some(context.source_window),task_id));
                            // Return to the actor queue; inspection itself never sends to a model.
                            let tx=app.state::<Runtime>().tx.clone();
                            tauri::async_runtime::spawn(async move{let _=tx.send(command).await;});
                        },
                        Err(error)=>{engine.view.error=Some(error);publish(&app,&mut engine,&view);}
                    }
                }},
                Control::ClearProject=>{project_request=None;engine.project=None;engine.view.project=None;engine.view.attachment_busy=screenshot_request.is_some();answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.view.answer.clear();engine.view.question=None;engine.detector.clear();engine.view.status=if session.is_some(){"listening"}else{"off"}.into();publish(&app,&mut engine,&view);},
                Control::Screenshot(source_window,task_id)=>{if task_id!=engine.view.task.id{continue;}if let Some(s)=session.as_ref(){if screenshot_request.is_none(){
                    let id=uuid::Uuid::new_v4().to_string();screenshot_request=Some(id.clone());engine.view.attachment_busy=true;engine.view.error=None;publish(&app,&mut engine,&view);let suppression=window::suspend_for_capture(&app);
                    let session_id=s.id.clone();let tx=work_tx.clone();
                    tauri::async_runtime::spawn(async move{let result=tokio::task::spawn_blocking(move||{let _suppression=suppression;std::thread::sleep(Duration::from_millis(80));crate::attachments::screenshot::capture_window(source_window)}).await.map_err(|_|"Screen capture failed".to_string()).and_then(|r|r);let _=tx.send(Work::Screenshot(session_id,id,result)).await;});
                }}},
                Control::ClearScreenshot=>{screenshot_request=None;engine.screenshot_data=None;engine.view.screenshot=None;engine.view.attachment_busy=project_request.is_some();answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.view.answer.clear();engine.view.question=None;engine.detector.clear();engine.view.status=if session.is_some(){"listening"}else{"off"}.into();if session.is_some(){window::show(&app,&hidden);}publish(&app,&mut engine,&view);},
                Control::MonitorAbort=>{if let Some(worker)=typing_worker.as_ref(){worker.abort();}monitor_focus=None;monitor_insertion=InsertionGuard::default();},
            }},
            event=events.recv(),if session.is_some()=>{let Some(event)=event else{continue};let s=session.as_ref().unwrap();let now=s.clock.elapsed().as_millis()as u64;engine.detector.semantic_intent=true;engine.detector.conversation_endpoints=true;engine.detector.independent_asr_endpoint=s.settings.speech_backend==SpeechBackend::Nemotron;answers.semantic_intent=engine.detector.semantic_intent;if engine.view.paused{continue;}
                match event {
                    #[cfg(all(feature="acceptance",debug_assertions))]
                    InputEvent::RawTranscriptBoundary(source,final_,text,started,ended)=>{
                        emit(&app,"asr.raw_boundary",serde_json::json!({"source":source,"final":final_,"text":text,
                            "startedAt":started,"endedAt":ended,"observedAt":now}));
                    },
                    InputEvent::SpeechStarted(source,t)=>{
                        if source==SpeakerSource::Remote&&!engine.detector.remote_source_current(t) {
                            emit(&app,"speech.started",serde_json::json!({"source":source,"timestamp":t,"ignoredForFocus":true}));continue;
                        }
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
                        if segment.started_at<engine.task_started_at{continue;}
                        #[cfg(debug_assertions)]{let _=app.emit("copilot:transcript",&segment);}
                        engine.context.ledger.observe(segment.clone(),now);
                        if segment.final_&&!segment.text.trim().is_empty(){engine.context.push(segment.clone());}
                        if segment.source==SpeakerSource::Remote&&!engine.detector.remote_source_current(segment.started_at){continue;}
                        if segment.source==SpeakerSource::Remote&&segment.final_{transcript_at=now;}
                        if segment.source==SpeakerSource::Remote && !segment.final_ {speech_metrics.first_remote_partial_at.get_or_insert(now);speech_metrics.remote_partial_updates+=1;}
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
                        if let Some(cancel)=monitor_cancel.take(){cancel.cancel();}
                        if let Some(worker)=typing_worker.take(){worker.shutdown();}
                        monitor_deduper=QuestionDeduper::default();monitor_question=None;monitor_pending=None;monitor_focus=None;monitor_insertion=InsertionGuard::default();engine.view.monitor=None;
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
                    let Some((w,focus_changed))=prepare_answer_work(&mut answers,&id,w,now)else{continue};
                    let job=answers.find_mut(&id).unwrap();
                    let valid=!job.cancel.is_cancelled() && !matches!(job.phase,meeting::scheduler::Phase::Cancelled|meeting::scheduler::Phase::Superseded);
                    if focus_changed {emit(&app,"question.focus_accepted",serde_json::json!({"id":id,"timestamp":now,"inferenceAcceptedAt":job.latency.question_confirmed_at,"decision":"model_answer_intent"}));}
                    match w {
                        Work::NoReply(_,_,_) if valid=>{job.phase=meeting::scheduler::Phase::Cancelled;job.confirmed=false;job.buffer.clear();job.latency.completed_at=Some(now);emit(&app,"question.ignored",serde_json::json!({"id":id,"timestamp":now}));},
                        Work::Sent(_,t) if valid=>job.latency.request_sent_at=t,
                        Work::Revision(_,text) if valid=>{engine.context.forget_visible_answer(&id);job.buffer=text;job.latency.first_token_at=None;job.latency.first_word_at=None;job.latency.response_revision+=1;if let Some(trace)=timings.lock().unwrap().get(&id){trace.reset_answer();}},
                        Work::Delta(_,delta) if valid=>{job.output_observed_at=now;engine.context.ledger.generated(&id,&job.question.text,&delta);job.latency.observe_answer_delta(&delta,now);if job.latency.first_token_at==Some(now){job.latency.first_token_at=Some(now);if let Some(trace)=timings.lock().unwrap().get(&id){trace.retained_delta_at(now);}}if job.buffer.len()+delta.len()>32_000 {job.cancel.cancel();job.error=Some("Answer exceeds display size limit".into());job.latency.completed_at=Some(now);if job.confirmed{job.phase=meeting::scheduler::Phase::Complete;}}else{job.buffer.push_str(&delta);}},
                        Work::Complete(_) if valid=>{job.latency.completed_at=Some(now);if job.confirmed{job.phase=meeting::scheduler::Phase::Complete;engine.context.remember_answer_at(&id,&job.question.text,&job.buffer,job.question.detected_at);}emit(&app,"answer.completed",serde_json::json!({"id":id}));},
                        Work::Error(_,e) if valid=>{job.error=Some(e);job.latency.completed_at=Some(now);if job.confirmed{job.phase=meeting::scheduler::Phase::Complete;}},
                        Work::Finished(_)=>{job.running=false;engine.context.ledger.terminal(&id,now,valid&&job.error.is_none()&&job.phase==meeting::scheduler::Phase::Complete);},_=>{}
                    }
                    sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);continue;
                }}
                match w {
                Work::Finished(_)|Work::QuestionDelta(_,_,_,_)|Work::NoReply(_,_,_)|Work::QuestionComplete(_,_,_)=>{},
                Work::Started(id,result)=>{if starting.as_ref().is_some_and(|pending|pending.id==id){let pending=starting.take().unwrap();
                    match result {
                        Ok(s)=>{match db.start(&s.id,crate::openai::auth::now()){
                            Ok(())=>{if let Some(start)=spawn_monitor(&s,&client,&auth,monitor_tx.clone(),work_tx.clone()){monitor_cancel=Some(start.cancel);typing_worker=start.typing;engine.view.monitor=Some(MonitorStatus::watching());monitor_deduper=QuestionDeduper::default();monitor_question=None;monitor_pending=None;monitor_focus=None;monitor_insertion=InsertionGuard::default();}session=Some(s);intent_gate=meeting::intent::Gate::default();summary_retry_at=0;transcript_at=0;engine.view.active=true;engine.view.status="listening".into();hidden.store(false,Ordering::Release);let _=window::position(&app);window::show(&app,&hidden);emit(&app,"meeting.started",());let _=pending.reply.send(Ok(()));},
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
                Work::Summary(id,task_id,memory)=>{if let Some(s)=session.as_ref().filter(|s|s.id==id&&engine.view.task.id==task_id){summary=None;engine.context.complete_summary(memory);summary_retry_at=s.clock.elapsed().as_millis()as u64+30_000;}},
                Work::SummaryError(id,task_id,error)=>{if let Some(s)=session.as_ref().filter(|s|s.id==id&&engine.view.task.id==task_id){summary=None;engine.context.fail_summary();summary_retry_at=s.clock.elapsed().as_millis()as u64+30_000;emit(&app,"context.error",error);}}
                Work::Project(session_id,id,result)=>{if let Some(s)=session.as_ref().filter(|s|s.id==session_id&&project_request.as_ref()==Some(&id)){
                    project_request=None;engine.view.attachment_busy=screenshot_request.is_some();
                    match result {Ok(project)=>{engine.view.project=Some(project.info());engine.project=Some(project);answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.detector.clear();if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}let now=s.clock.elapsed().as_millis()as u64;let question=attachment_question(engine.view.question.as_ref(),task_question(&engine.view.task,PROJECT_CONTEXT_QUESTION));let context=engine.context.answer_context(&question);let id=answers.confirm_explicit_with_context(question.clone(),now,now,now,context);engine.context.ledger.typed(&id,&question,now);if let Some(job)=answers.find_mut(&id){job.detailed=true;job.context_version=engine.context.ledger.version;}drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);sync_answers(&mut engine,&answers);},Err(error)=>{engine.view.error=Some(error);}}
                    publish(&app,&mut engine,&view);
                }},
                Work::Screenshot(session_id,id,result)=>{if session.is_some(){window::show(&app,&hidden);}if let Some(s)=session.as_ref().filter(|s|s.id==session_id&&screenshot_request.as_ref()==Some(&id)){
                    screenshot_request=None;engine.view.attachment_busy=project_request.is_some();
                    match result {Ok(screenshot)=>{engine.view.screenshot=Some(screenshot.info);engine.screenshot_data=Some(screenshot.data_url);answers.clear();engine.view.questions.clear();cancel_answer(&app,&mut generation);engine.detector.clear();if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}let now=s.clock.elapsed().as_millis()as u64;let question=attachment_question(engine.view.question.as_ref(),task_question(&engine.view.task,SCREEN_CONTEXT_QUESTION));let context=engine.context.answer_context(&question);let id=answers.confirm_explicit_with_context(question.clone(),now,now,now,context);engine.context.ledger.typed(&id,&question,now);if let Some(job)=answers.find_mut(&id){job.detailed=true;job.context_version=engine.context.ledger.version;}drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);sync_answers(&mut engine,&answers);},Err(error)=>{engine.view.error=Some(error);}}
                    window::show(&app,&hidden);publish(&app,&mut engine,&view);
                }},
                Work::MonitorSolution(session_id,window,question,generation,result)=>{if let Some(s)=session.as_ref().filter(|s|s.id==session_id){
                    let now=s.clock.elapsed().as_millis()as u64;
                    let current=monitor_pending==Some(generation);
                    match result {
                        Ok(solution)=>{if !current{monitor_trace!("solution generation {generation} dropped (pending {monitor_pending:?})");continue;}monitor_pending=None;
                            let length=solution.chars().count();
                            let stored=if solution.is_empty()||length>8_000{false}else{engine.screen_answers.insert(&question,&solution,window,generation,now,DEFAULT_TTL)};
                            if let Some(status)=engine.view.monitor.as_mut(){status.updated_at=now;
                                if solution.is_empty(){status.warning=Some("The vision model returned no answer text".into());}
                                else if length>8_000{status.warning=Some("The generated answer exceeds 8000 characters and was not cached".into());}
                                else if stored{status.solutions+=1;status.answer_cached=true;status.question=Some(question);status.window=Some(window);status.warning=None;}
                            }
                            monitor_trace!("solution stored={stored} generation={generation} chars={length}");
                            if stored{if let Some(warning)=type_monitor_answer(&mut engine,&mut monitor_insertion,&typing_worker,monitor_focus.as_ref(),monitor_question.as_ref(),TypingSpeed::from_setting(&s.settings.screen_monitor_speed).unwrap_or(TypingSpeed::Normal).timings(),now){if let Some(status)=engine.view.monitor.as_mut(){status.warning=Some(warning);}}}
                            publish(&app,&mut engine,&view);
                        },
                        Err(error)=>{monitor_trace!("solution generation {generation} failed: {error}");if current{monitor_pending=None;if let Some(status)=engine.view.monitor.as_mut(){status.updated_at=now;status.warning=Some(format!("Could not generate the on-screen answer: {error}"));}publish(&app,&mut engine,&view);}}
                    }
                }},
                Work::MonitorTyped(outcome)=>{let now=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64).unwrap_or(0);
                    let generation=match &outcome{TypingOutcome::Finished{generation}|TypingOutcome::Aborted{generation}|TypingOutcome::Failed{generation,..}=>*generation};
                    monitor_trace!("typing outcome {:?} generation={generation} latest={}", outcome, engine.screen_answers.latest_generation());
                    monitor_insertion.observe_outcome(generation, &outcome);
                    if generation==engine.screen_answers.latest_generation(){
                        let warning=match &outcome{TypingOutcome::Finished{..}=>None,TypingOutcome::Aborted{..}=>Some("Typing was stopped".to_string()),TypingOutcome::Failed{error,..}=>Some(error.clone())};
                        if let Some(status)=engine.view.monitor.as_mut(){status.updated_at=now;if warning.is_none(){status.typed=true;status.warning=None;}else{status.warning=warning;}}
                        publish(&app,&mut engine,&view);
                    }
                },
            }},
            update=monitor_updates.recv()=>{let Some(update)=update else{continue};
                let Some(s)=session.as_ref() else{continue};
                let now=s.clock.elapsed().as_millis()as u64;
                match update {
                    MonitorUpdate::Skipped{reason}=>{if let Some(status)=engine.view.monitor.as_mut(){status.state="watching".into();status.warning=Some(reason);status.updated_at=now;}publish(&app,&mut engine,&view);},
                    MonitorUpdate::Captured{window,executable,changed}=>{if let Some(status)=engine.view.monitor.as_mut(){status.window=Some(window);status.executable=Some(executable);status.state=(if changed{"analyzing"}else{"watching"}).into();status.warning=None;status.updated_at=now;}publish(&app,&mut engine,&view);},
                    MonitorUpdate::Failed{error}=>{if let Some(status)=engine.view.monitor.as_mut(){status.state="error".into();status.warning=Some(error);status.updated_at=now;}publish(&app,&mut engine,&view);},
                    MonitorUpdate::Analysis{window,executable,image,analysis}=>{
                        let focused=analysis.focus&&!analysis.password;
                        monitor_trace!("analysis: focus={} password={} question={:?}", analysis.focus, analysis.password, analysis.question.as_deref().map(|question| question.chars().take(80).collect::<String>()));
                        monitor_focus=focused.then(||FocusEvidence{at:now,window,executable:executable.clone()});
                        if let Some(status)=engine.view.monitor.as_mut(){
                            status.window=Some(window);status.executable=Some(executable);status.state="watching".into();status.warning=None;status.updated_at=now;status.analyzed_frames+=1;status.focus=analysis.focus;
                            status.answer_cached=monitor_question.as_ref().is_some_and(|(question,_)|engine.screen_answers.get(question,now).is_some());
                            if let Some(question)=&analysis.question{status.question=Some(question.clone());}
                        }
                        if let Some(question)=analysis.question.clone(){
                            let fresh=monitor_deduper.first_seen(&question);
                            let cached=engine.screen_answers.get(&question,now).is_some();
                            if fresh&&!cached&&monitor_pending.is_none(){
                                let Some(cancel)=monitor_cancel.clone()else{continue};
                                let generation=engine.screen_answers.next_generation();
                                monitor_pending=Some(generation);monitor_question=Some((question.clone(),window));
                                monitor_trace!("solution generation {generation} started (fresh={fresh} cached={cached})");
                                if let Some(status)=engine.view.monitor.as_mut(){status.question=Some(question.clone());status.answer_cached=false;status.typed=false;}
                                let mut input=String::from("Solve the task shown in this screenshot.");input.push_str("\nExtracted question text: ");input.push_str(&question);
                                if !analysis.note.is_empty(){input.push_str("\nScreen note: ");input.push_str(&analysis.note);}
                                let model=s.settings.model.clone();
                                let solution_client=client.clone().with_backend(s.settings.answer_backend,s.settings.service_tier.as_deref()).with_reasoning(s.settings.reasoning_effort.as_deref()).with_refill(s.settings.codex_refill_policy);
                                let auth=auth.clone();let tx=work_tx.clone();let session_id=s.id.clone();
                                tauri::async_runtime::spawn(async move{
                                    let result=async{let token=answer_token(&auth,&solution_client,&cancel).await?;let solution=solution_client.text_with_image(&token,&model,prompts::MONITOR_SOLUTION,&input,Some(&image),cancel.clone()).await?;Ok::<_,String>(clean_solution(&solution))}.await;
                                    if cancel.is_cancelled(){return;}
                                    let _=tx.send(Work::MonitorSolution(session_id,window,question,generation,result)).await;
                                });
                            }else{monitor_trace!("solution skipped: question already known (fresh={fresh} cached={cached} pending={})",monitor_pending.is_some());}
                        }
                        if let Some(warning)=type_monitor_answer(&mut engine,&mut monitor_insertion,&typing_worker,monitor_focus.as_ref(),monitor_question.as_ref(),TypingSpeed::from_setting(&s.settings.screen_monitor_speed).unwrap_or(TypingSpeed::Normal).timings(),now){
                            if let Some(status)=engine.view.monitor.as_mut(){status.warning=Some(warning);}
                        }
                        publish(&app,&mut engine,&view);
                    },
                }
            },
            _=tick.tick()=>{if let Some(s)=session.as_ref(){let now=s.clock.elapsed().as_millis()as u64;
                if conversation_input_enabled(&engine) {
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
                        if let Some(floor)=engine.detector.remote_turn_started_at {
                            engine.context.ledger.associate_remote_utterance(floor,engine.detector.recognized_segment_ids());
                        }
                        emit(&app,"asr.finalization_ready",serde_json::json!({"floor":engine.detector.remote_turn_started_at,
                            "speechStoppedAt":stopped,"lastRemoteActivity":engine.detector.last_remote_activity(),"timestamp":now}));
                        let background=intent_mode==meeting::intent::Mode::Learned&&meeting::intent::background_enabled()&&engine.detector.remote_turn_started_at.is_some_and(|floor|intent_gate.background(floor,&question,&engine.context.classifier_context(floor),0.95));
                        if background {
                            answers.resumed();emit(&app,"intent.background_ignored",serde_json::json!({"timestamp":now,"floor":engine.detector.remote_turn_started_at}));
                            sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);
                        } else {
                            let excerpts=engine.context.answer_context_for_utterance(&question,speech_metrics.remote_speech_started_at);let id=answers.confirm_automatic_with_context(question,now,stopped,transcript_at,Some(excerpts));if let Some(job)=answers.find_mut(&id){job.latency.remote_speech_started_at=speech_metrics.remote_speech_started_at;job.latency.first_remote_partial_at=speech_metrics.first_remote_partial_at;job.latency.first_credible_candidate_at=speech_metrics.first_credible_candidate_at;job.latency.remote_partial_updates=speech_metrics.remote_partial_updates;if job.latency.completed_at.is_some()&&job.error.is_none(){engine.context.remember_answer_at(&id,&job.question.text,&job.buffer,job.question.detected_at);}}if let Some(trace)=timings.lock().unwrap().get(&id){trace.confirmed_at(now);if answers.jobs.iter().any(|job|job.question.id==id&&job.latency.first_token_at.is_none()){trace.reset_answer();}}engine.context.ledger.accept(&id,&answers.find_mut(&id).unwrap().question.text,now);let revision=speech_metrics.remote_speech_started_at.map(|floor|engine.context.ledger.accepted_revision(floor)).unwrap_or(0);if let Some(job)=answers.find_mut(&id){job.context_version=engine.context.ledger.version;job.utterance_revision=revision;}emit(&app,"question.confirmed",serde_json::json!({"id":id,"timestamp":now}));sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);
                        }
                    }
                    if answers.busy(){if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}drive_answers(&app,&engine,s,&auth,&client,&timings,work_tx.clone(),&mut answers,now);sync_answers(&mut engine,&answers);publish(&app,&mut engine,&view);}
                    if generation.is_none()&&!answers.busy()&&summary.is_none()&&now>=summary_retry_at{if let Some(batch)=engine.context.take_summary_batch(){let input=format!("PRIOR MEMORY\n{}\nOLDER TRANSCRIPT\n{}",serde_json::to_string(&engine.context.memory).unwrap_or_default(),meeting::context::conversation(&batch));let cancel=CancellationToken::new();summary=Some(cancel.clone());let id=s.id.clone();let task_id=engine.view.task.id.clone();let model=s.settings.model.clone();let auth=auth.clone();let client=client.clone().with_backend(s.settings.answer_backend,s.settings.service_tier.as_deref()).with_reasoning(s.settings.reasoning_effort.as_deref());let tx=work_tx.clone();tauri::async_runtime::spawn(async move{let result=async{let token=answer_token(&auth,&client,&cancel).await?;let text=client.text(&token,&model,prompts::SUMMARY,&input,cancel.clone()).await?;serde_json::from_str(&text).map_err(|_|"Could not parse meeting memory".to_string())}.await;if cancel.is_cancelled(){return;}let result=match result{Ok(m)=>Work::Summary(id,task_id,m),Err(e)=>Work::SummaryError(id,task_id,e)};let _=tx.send(result).await;});}}
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
// Evaluation-only replay of an already captured public context. It cannot be
// accessed in release builds and never installs future questions or rubrics.
#[tauri::command]
async fn acceptance_freeze_context(rt:State<'_,Runtime>,context:String,policy:String)->Result<(),String> {
    #[cfg(all(feature="acceptance",debug_assertions))]
    if crate::openai::acceptance_mode() {
        if context.len()>160_000{return Err("Frozen context is oversized".into());}
        if policy!="final"&&policy!="existing" {return Err("Choose final or existing replay policy".into());}
        let (tx,rx)=oneshot::channel();send(&rt,Control::FreezeContext(context,policy,tx)).await?;
        return rx.await.map_err(|_|"Frozen context cancelled".to_string())?;
    }
    let _=(rt,context,policy);Err("Frozen context is available only in acceptance/debug mode".into())
}
#[tauri::command]
fn answer_visible(rt:State<'_,Runtime>,id:String,revision:Option<u64>) {
    let view=rt.view.lock().unwrap();
    if view.active && !view.answer.is_empty() && view.question.as_ref().is_some_and(|q|q.id==id) && revision.is_none_or(|revision|view.latency.as_ref().is_some_and(|latency|latency.response_revision==revision)) {
        if let Some(trace)=rt.timings.lock().unwrap().get(&id){trace.mark(crate::openai::timing::Stage::FirstVisible);}
    }
}
// Host monotonic session time is reconstructed at receipt so a delayed IPC
// message does not turn a late paint into a pre-interruption visible answer.
// Future clocks and observations predating this session are rejected.
fn display_session_time(native_now:u64,host_now:u64,paint_host_ms:u64)->Option<u64> {
    native_now.checked_sub(host_now.checked_sub(paint_host_ms)?)
}
fn utf16_byte_offset(text:&str,offset:usize)->Option<usize>{
    let mut units=0;
    for (byte,c) in text.char_indices(){if units==offset{return Some(byte);}units+=c.len_utf16();if units>offset{return None;}}
    (units==offset).then_some(text.len())
}
#[tauri::command]
async fn answer_displayed(rt:State<'_,Runtime>,id:String,revision:u64,text:String,visible_start:usize,visible_end:usize,paint_host_ms:u64)->Result<(),String> {
    if text.len()>32_000{return Err("Displayed answer is oversized".into());}
    send(&rt,Control::Displayed(id,revision,text,visible_start,visible_end,paint_host_ms)).await
}
#[tauri::command]
fn acceptance_disconnect_answers(rt:State<'_,Runtime>)->Result<(),String> {
    #[cfg(all(feature="acceptance",debug_assertions))]
    if crate::openai::acceptance_mode(){
        rt.client.codex.as_ref().ok_or("Codex runtime is unavailable")?.close();
        return Ok(());
    }
    let _=rt;Err("Connection faults are available only in acceptance/debug mode".into())
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
fn accept_typed_question(engine:&mut Engine,answers:&mut meeting::scheduler::Scheduler,question:String,now:u64)->String {
    // A typed request is a new input, not a revision of an older speech draft.
    // Retain all recognized source in the ledger but retire its focus eligibility.
    answers.resumed();engine.detector.supersede_remote_before(now);
    let context=engine.context.answer_context(&question);
    let id=answers.confirm_explicit_with_context(question,now,now,now,context);
    engine.context.ledger.typed(&id,&answers.find_mut(&id).unwrap().question.text,now);
    answers.find_mut(&id).unwrap().context_version=engine.context.ledger.version;id
}
fn conversation_input_enabled(engine:&Engine)->bool {
    // A terminal answer failure is display state, not a failed speech pipeline.
    // Pipeline failures pause the session explicitly; the next recognized
    // request must still be accepted after an independent generation fails.
    engine.view.active&&!engine.view.paused
}
fn sync_answers(engine: &mut Engine, answers: &meeting::scheduler::Scheduler) {
    engine.view.questions=answers.rows();
    let request_error=answers.latest_request_error().map(str::to_owned);
    if let Some(error)=request_error.as_ref(){engine.view.error=Some(error.clone());}
    if let Some(j)=answers.visible() {
        engine.view.question=Some(j.question.clone());engine.view.answer=j.buffer.clone();engine.view.latency=Some(j.latency.clone());engine.view.error=request_error.or_else(||j.error.clone());
        engine.view.status=if engine.view.error.is_some(){"error"}else if !j.buffer.is_empty(){"answer"}else{"thinking"}.into();
    } else if answers.busy() {engine.view.question=None;engine.view.answer.clear();engine.view.latency=None;engine.view.status="question".into();}
    else if engine.view.active && engine.view.question.is_none() && !engine.view.manual && engine.view.status=="question" {
        engine.view.status="listening".into();engine.view.latency=None;
    }
}
#[cfg(test)]
mod answer_view_tests {
    use super::*;
    #[test]
    fn typed_request_does_not_inherit_an_old_drafts_identity_or_lose_focus_to_its_final() {
        let mut engine=Engine::default();engine.view.active=true;
        engine.detector.semantic_intent=true;engine.detector.conversation_endpoints=true;
        let mut answers=meeting::scheduler::Scheduler::default();
        answers.local_revisions=true;answers.semantic_intent=true;
        engine.detector.speech_started(meeting::SpeakerSource::Remote,100);
        let mut old=meeting::TranscriptSegment{id:"older-source".into(),source:meeting::SpeakerSource::Remote,
            text:"Earlier unfinished request".into(),started_at:100,ended_at:200,final_:true};
        engine.context.ledger.observe(old.clone(),200);engine.detector.transcript(&old);
        let draft=answers.propose(old.text.clone(),200,200,200);answers.find_mut(&draft).unwrap().latency.remote_speech_started_at=Some(100);
        let draft_cancel=answers.find_mut(&draft).unwrap().cancel.clone();
        let typed=accept_typed_question(&mut engine,&mut answers,"Newer typed request".into(),300);
        assert_ne!(draft,typed);assert!(draft_cancel.is_cancelled());
        assert!(answers.candidate.is_none());
        assert_eq!(answers.find_mut(&typed).unwrap().latency.remote_speech_started_at,None);
        assert_eq!(answers.next(300),Some(typed.clone()));
        old.text="Earlier request with a delayed correction".into();old.ended_at=400;
        engine.context.ledger.observe(old.clone(),450);assert!(!engine.detector.transcript(&old));
        assert!(engine.detector.confirm(1000).is_none());sync_answers(&mut engine,&answers);
        assert_eq!(engine.view.question.as_ref().unwrap().id,typed);
        assert_eq!(engine.context.ledger.recognized.len(),2);
        assert_eq!(engine.context.ledger.recognized[0].segment.text,"Earlier unfinished request");
        assert_eq!(engine.context.ledger.recognized[1].segment.text,old.text);
        assert!(engine.context.answer_context("Follow up").contains(&old.text));
    }
    #[test]
    fn failed_answer_does_not_disable_next_spoken_request_or_erase_history() {
        let mut engine=Engine::default();engine.view.active=true;
        engine.detector.semantic_intent=true;engine.detector.conversation_endpoints=true;
        let mut answers=meeting::scheduler::Scheduler::default();
        let initial="Explain the invariant";
        let old=answers.confirm_explicit_with_context(initial.into(),0,0,0,String::new());
        engine.context.ledger.typed(&old,initial,0);
        engine.context.ledger.generated(&old,initial,"The partial explanation");
        assert!(engine.context.ledger.acknowledge_display(&old,"The partial explanation",20));
        answers.next(0);
        let job=answers.find_mut(&old).unwrap();
        job.error=Some("Provider did not complete the response".into());
        job.phase=meeting::scheduler::Phase::Complete;job.running=false;
        job.latency.completed_at=Some(100);
        sync_answers(&mut engine,&answers);
        assert_eq!(engine.view.status,"error");assert!(engine.view.error.is_some());
        assert!(conversation_input_enabled(&engine));

        engine.detector.speech_started(meeting::SpeakerSource::Remote,1000);
        let segment=meeting::TranscriptSegment{id:"next-spoken-request".into(),source:meeting::SpeakerSource::Remote,
            text:"Why?".into(),started_at:1000,ended_at:1200,final_:true};
        engine.context.ledger.observe(segment.clone(),1250);engine.detector.transcript(&segment);
        engine.detector.speech_ended(meeting::SpeakerSource::Remote,1200);
        assert!(engine.detector.can_accept_now());
        let (question,stopped)=engine.detector.confirm(4000).unwrap();
        let context=engine.context.answer_context_for_utterance(&question,Some(1000));
        assert!(context.contains(initial));assert!(context.contains("The partial explanation"));
        let current=answers.confirm_with_context(question,4000,stopped,1250,Some(context));
        assert_ne!(old,current);assert_eq!(answers.next(4000),Some(current.clone()));
        sync_answers(&mut engine,&answers);
        assert!(engine.view.error.is_none());assert_eq!(engine.view.question.as_ref().unwrap().id,current);
        assert!(answers.find_mut(&old).unwrap().error.is_some());
        assert_eq!(engine.context.ledger.recognized[0].segment.text,"Why?");
        assert_eq!(engine.context.ledger.suggestions[0].generated,"The partial explanation");
    }
    #[test]
    fn stopped_or_paused_capture_still_blocks_conversation_input() {
        let mut engine=Engine::default();engine.view.status="listening".into();
        assert!(!conversation_input_enabled(&engine));
        engine.view.active=true;engine.view.paused=true;
        assert!(!conversation_input_enabled(&engine));
        engine.view.status="error".into();engine.view.error=Some("Speech pipeline stopped".into());
        assert!(!conversation_input_enabled(&engine));
    }
    #[test]
    fn delayed_paint_ack_uses_paint_time_and_rejects_other_session_clocks() {
        assert_eq!(display_session_time(1000,100_000,99_800),Some(800));
        assert_eq!(display_session_time(1000,100_000,100_001),None);
        assert_eq!(display_session_time(1000,100_000,98_999),None);
        assert_eq!(utf16_byte_offset("a🎉z",3),Some(5));
        assert_eq!(utf16_byte_offset("a🎉z",2),None);
    }
    #[test]
    fn continued_question_does_not_feed_its_retracted_visible_draft_back_as_context() {
        let mut engine=Engine::default();
        let mut answers=meeting::scheduler::Scheduler{local_revisions:false,semantic_intent:true,..Default::default()};
        engine.context.remember_answer("previous","Implement","```rust\nlet exact=17;\n```");
        let question="Explain the invariant";
        let baseline=engine.context.answer_context_for_utterance(question,Some(100));
        let id=answers.confirm_with_context(question.into(),400,300,350,Some(baseline.clone()));
        answers.next(400);
        let job=answers.find_mut(&id).unwrap();job.steer_supported=true;job.latency.remote_speech_started_at=Some(100);
        job.buffer="The unfinished draft assumes a different boundary.".into();job.output_observed_at=450;
        sync_answers(&mut engine,&answers);
        engine.context.ledger.generated(&id,question,&engine.view.answer);
        assert!(!engine.context.prompt("Why that boundary?").contains(&engine.view.answer));
        engine.context.ledger.acknowledge_display(&id,&engine.view.answer,450);
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
        let mut answers=meeting::scheduler::Scheduler{local_revisions:false,semantic_intent:true,..Default::default()};
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
        let mut answers=meeting::scheduler::Scheduler{local_revisions:false,semantic_intent:true,..Default::default()};
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
    fn automatic_ignore_cannot_cancel_an_authorized_stream_and_keeps_exact_memory() {
        let mut engine=Engine::default();engine.view.active=true;
        let mut answers=meeting::scheduler::Scheduler::default();
        let parent=answers.confirm_with_context("Earlier arbitrary request".into(),100,90,95,Some("Original exact context".into()));
        answers.next(100);answers.find_mut(&parent).unwrap().buffer="Exact displayed partial code".into();
        engine.context.ledger.generated(&parent,"Earlier arbitrary request","Exact displayed partial code");
        engine.context.ledger.displayed(&parent,"Earlier arbitrary request","Exact displayed partial code",110);
        let ignored=answers.confirm_automatic_with_context("Opaque later recognized content".into(),200,180,190,Some("Frozen next context".into()));
        answers.next(200);sync_answers(&mut engine,&answers);
        assert_eq!(engine.view.question.as_ref().unwrap().id,parent);
        assert!(!answers.find_mut(&parent).unwrap().cancel.is_cancelled());
        let key=crate::openai::codex::context_key("Frozen next context");
        assert!(matches!(prepare_answer_work(&mut answers,&ignored,Work::NoReply(ignored.clone(),"Opaque later recognized content".into(),key),250),Some((Work::NoReply(_,_,_),false))));
        let job=answers.find_mut(&ignored).unwrap();job.phase=meeting::scheduler::Phase::Cancelled;job.confirmed=false;job.latency.completed_at=Some(250);job.running=false;
        sync_answers(&mut engine,&answers);
        assert_eq!(engine.view.question.as_ref().unwrap().id,parent);
        assert_eq!(engine.view.answer,"Exact displayed partial code");
        assert!(!answers.find_mut(&parent).unwrap().cancel.is_cancelled());
        assert_eq!(engine.context.ledger.suggestions[0].generated,"Exact displayed partial code");
    }
    #[test]
    fn exact_frame_answer_intent_takes_focus_but_stale_or_empty_frames_do_not() {
        let mut answers=meeting::scheduler::Scheduler::default();
        let parent=answers.confirm("Earlier request".into(),100,90,95);answers.next(100);
        let newer=answers.confirm_automatic_with_context("Arbitrary next request".into(),200,180,190,Some("Exact next context".into()));answers.next(200);
        let key=crate::openai::codex::context_key("Exact next context");
        assert!(prepare_answer_work(&mut answers,&newer,Work::QuestionDelta(newer.clone(),"Wrong frame".into(),key,"Answer".into()),210).is_none());
        assert!(prepare_answer_work(&mut answers,&newer,Work::QuestionDelta(newer.clone(),"Arbitrary next request".into(),crate::openai::codex::context_key("Obsolete context"),"Answer".into()),211).is_none());
        assert!(matches!(prepare_answer_work(&mut answers,&newer,Work::QuestionDelta(newer.clone(),"Arbitrary next request".into(),key,String::new()),212),Some((Work::Delta(_,_),false))));
        assert!(!answers.find_mut(&parent).unwrap().cancel.is_cancelled());
        assert!(matches!(prepare_answer_work(&mut answers,&newer,Work::QuestionDelta(newer.clone(),"Arbitrary next request".into(),key,"Current answer".into()),220),Some((Work::Delta(_,_),true))));
        assert!(answers.find_mut(&parent).unwrap().cancel.is_cancelled());
        assert_eq!(answers.visible().unwrap().question.id,newer);
        assert_eq!(answers.find_mut(&newer).unwrap().latency.question_confirmed_at,200);
        assert_eq!(answers.find_mut(&newer).unwrap().focus_authorized_at,Some(220));
        assert_eq!(answers.active(),2);
    }
    #[test]
    fn terminal_provisional_error_cannot_be_reactivated_by_a_late_answer_frame() {
        let mut answers=meeting::scheduler::Scheduler::default();
        let parent=answers.confirm("Foreground".into(),100,90,95);answers.next(100);
        let newer=answers.confirm_automatic_with_context("Arbitrary candidate".into(),200,180,190,Some("Frozen context".into()));answers.next(200);
        let job=answers.find_mut(&newer).unwrap();job.error=Some("Transport error".into());job.phase=meeting::scheduler::Phase::Complete;job.latency.completed_at=Some(250);
        let key=crate::openai::codex::context_key("Frozen context");
        assert!(prepare_answer_work(&mut answers,&newer,Work::QuestionDelta(newer.clone(),"Arbitrary candidate".into(),key,"Late answer".into()),300).is_none());
        assert!(!answers.find_mut(&parent).unwrap().cancel.is_cancelled());
        assert_eq!(answers.visible().unwrap().question.id,parent);
        assert_eq!(answers.find_mut(&newer).unwrap().focus_authorized_at,None);
    }
    #[test]
    fn empty_scheduler_does_not_hide_a_paused_capture_failure() {
        let mut engine=Engine::default();engine.view.active=true;engine.view.paused=true;
        engine.view.status="error".into();engine.view.error=Some("Capture disconnected".into());
        sync_answers(&mut engine,&meeting::scheduler::Scheduler::default());
        assert_eq!(engine.view.error.as_deref(),Some("Capture disconnected"));
    }
    #[test]
    fn provisional_failure_is_displayed_without_replacing_the_foreground_answer() {
        let mut engine=Engine::default();engine.view.active=true;
        let mut answers=meeting::scheduler::Scheduler::default();
        let parent=answers.confirm("Foreground".into(),100,90,95);answers.next(100);
        answers.find_mut(&parent).unwrap().buffer="Exact existing partial".into();
        let failed=answers.confirm_automatic_with_context("Arbitrary candidate".into(),200,180,190,None);
        let job=answers.find_mut(&failed).unwrap();job.error=Some("Capacity unavailable".into());job.phase=meeting::scheduler::Phase::Complete;job.latency.completed_at=Some(250);
        sync_answers(&mut engine,&answers);
        assert_eq!(engine.view.question.as_ref().unwrap().id,parent);
        assert_eq!(engine.view.answer,"Exact existing partial");
        assert_eq!(engine.view.error.as_deref(),Some("Capacity unavailable"));
        assert!(conversation_input_enabled(&engine));
    }
    #[test]
    fn ignored_automatic_turn_returns_to_listening_without_overwriting_manual_input() {
        let mut engine=Engine::default();engine.view.active=true;engine.view.status="question".into();
        let mut answers=meeting::scheduler::Scheduler{local_revisions:false,semantic_intent:false,..Default::default()};
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
        let mut answers=meeting::scheduler::Scheduler{local_revisions:false,semantic_intent:false,..Default::default()};
        let id=answers.confirm("Implement it".into(),0,0,0);answers.next(0);
        let job=answers.find_mut(&id).unwrap();job.steer_supported=true;job.buffer="```rust\nlet changed=7;".into();
        sync_answers(&mut engine,&answers);
        engine.context.ledger.generated(&id,"Implement it",&engine.view.answer);
        assert!(!engine.context.prompt("Why 7?").contains(&engine.view.answer));
        assert!(engine.context.ledger.acknowledge_display(&id,&engine.view.answer,1));
        assert!(engine.context.prompt("Why 7?").contains(&engine.view.answer));
        assert!(engine.context.prompt("Why 7?").contains("may be unfinished"));
        assert!(engine.view.latency.as_ref().unwrap().completed_at.is_none());
    }
}
fn prepare_answer_work(answers:&mut meeting::scheduler::Scheduler,id:&str,work:Work,now:u64)->Option<(Work,bool)> {
    let job=answers.find_mut(id)?;
    let valid=!job.cancel.is_cancelled() && !matches!(job.phase,meeting::scheduler::Phase::Cancelled|meeting::scheduler::Phase::Superseded);
    if matches!(&work,Work::QuestionDelta(_,_,_,_)) && (!valid || job.latency.completed_at.is_some()){return None;}
    let accepts=matches!(&work,Work::QuestionDelta(_,question,key,text)
        if valid && job.confirmed && !text.is_empty() && job.accepts_stream(question,key));
    let work=gate_question_work(job,work)?;
    let changed=accepts && answers.authorize_answer(id,now);
    Some((work,changed))
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
        job.steer_supported=false;
        let selected_context=job.updates.borrow().context.clone().unwrap_or_else(||engine.context.answer_context_for_utterance(&job.question.text,job.latency.remote_speech_started_at));
        job.set_context(selected_context.clone());
        let updates=job.updates.subscribe();
        let references=job.references.get_or_insert_with(||meeting::scheduler::FrozenReferences {
            task:Arc::new(engine.view.task.reference()),
            project:Arc::new(engine.project.as_ref().map(|project|project.prompt()).unwrap_or_default()),
            screenshot:engine.screenshot_data.clone().map(Arc::new),
        }).clone();
        let input=crate::openai::codex::QuestionPrompt::new(selected_context,job.question.text.clone()).with_reference(format!("{}{}",active_attachment_reference(references.project.as_str(),references.screenshot.is_some()),references.task)).with_explicit_request(job.explicit_request);
        let instructions=prompts::answer_instructions(if job.detailed||matches!(s.settings.answer_objective,AnswerObjective::Detailed){prompts::ANSWER}else{prompts::BRIEF});
        let image=references.screenshot;let model=s.settings.model.clone();let auth=auth.clone();let clock=s.clock;let tx=tx.clone();
        let client=client.clone().with_backend(s.settings.answer_backend,s.settings.service_tier.as_deref()).with_reasoning(s.settings.reasoning_effort.as_deref());
        let trace=crate::openai::timing::Trace::new(clock,job.question.detected_at);trace.prompt_chars(input.render().chars().count());if job.confirmed{trace.confirmed_at(job.latency.question_confirmed_at);}
        trace.frame(&s.id,job.latency.remote_speech_started_at,job.utterance_revision,job.context_version,&job.generation_id,crate::openai::codex::context_key(&input.render()));
        crate::openai::timing::register(timings,id.clone(),trace.clone());let client=client.with_refill(s.settings.codex_refill_policy).with_trace(trace);
        emit(app,"answer.started",serde_json::json!({"id":id,"generationId":job.generation_id,"sessionId":s.id,"utteranceId":job.latency.remote_speech_started_at,"utteranceRevision":job.utterance_revision,"contextVersion":job.context_version,"parentGenerationId":job.parent_generation_id,"inputHash":crate::openai::codex::context_key(&input.render()),"speculative":!job.confirmed}));
        #[cfg(all(feature="acceptance",debug_assertions))]
        let diagnostic_app=app.clone();
        tauri::async_runtime::spawn(async move {
            #[cfg(all(feature="acceptance",debug_assertions))]
            let mut prefix=meeting::provisional::Prefix::default();
            let result=async {let token=answer_token(&auth,&client,&cancel).await?;
                tx.send(Work::Sent(id.clone(),clock.elapsed().as_millis()as u64)).await.map_err(|_|"Meeting receiver closed".to_string())?;
                client.stream_question(&token,&model,&instructions,&input,image.as_ref().map(|data|data.as_str()),cancel.clone(),updates,|event|{
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
const PROJECT_CONTEXT_QUESTION: &str = "Give a concise overview of this project and explain its main architecture.";
const SCREEN_CONTEXT_QUESTION: &str = "Explain what is on this screen and help me with the visible task.";
fn task_question<'a>(task: &'a meeting::task::Task, fallback: &'a str) -> &'a str {
    if task.problem.trim().is_empty() { fallback } else { &task.problem }
}
fn attachment_question(current: Option<&meeting::state::CurrentQuestion>, fallback: &str) -> String {
    current.map(|question| question.text.as_str())
        .filter(|text| !text.trim().is_empty() && ![PROJECT_CONTEXT_QUESTION, SCREEN_CONTEXT_QUESTION].contains(text))
        .unwrap_or(fallback).to_string()
}
fn active_attachment_reference(project:&str,screenshot:bool)->String{
    format!("\nAPPLICATION ATTACHMENTS (current request): {}\nEarlier attachments are historical context. Use only the current attachments when asked about the current project or screen. If a source is absent, do not claim an older attachment is still attached.{}",serde_json::json!({"project":!project.is_empty(),"screenshot":screenshot}),project)
}
#[cfg(test)]mod attachment_frame_tests{
    use super::{active_attachment_reference, attachment_question, task_question, PROJECT_CONTEXT_QUESTION, SCREEN_CONTEXT_QUESTION};
    #[test]fn a_saved_task_problem_is_the_default_after_dismissing_a_followup(){
        let mut task=crate::meeting::task::Task::default();
        task.update("problem","Implement a bounded queue".into()).unwrap();
        assert_eq!(attachment_question(None,task_question(&task,SCREEN_CONTEXT_QUESTION)),"Implement a bounded queue");
        assert_eq!(attachment_question(None,task_question(&task,PROJECT_CONTEXT_QUESTION)),"Implement a bounded queue");
    }
    #[test]fn context_updates_keep_the_interview_question_and_choose_source_specific_defaults(){
        use crate::meeting::state::CurrentQuestion;
        let mut question = CurrentQuestion { id: "q".into(), text: "Find the boundary bug and explain the fix".into(), detected_at: 1 };
        for fallback in [PROJECT_CONTEXT_QUESTION, SCREEN_CONTEXT_QUESTION] {
            assert_eq!(attachment_question(Some(&question), fallback), question.text);
            assert_eq!(attachment_question(None, fallback), fallback);
        }
        question.text = PROJECT_CONTEXT_QUESTION.into();
        assert_eq!(attachment_question(Some(&question), SCREEN_CONTEXT_QUESTION), SCREEN_CONTEXT_QUESTION);
        question.text = SCREEN_CONTEXT_QUESTION.into();
        assert_eq!(attachment_question(Some(&question), PROJECT_CONTEXT_QUESTION), PROJECT_CONTEXT_QUESTION);
        question.text = "  ".into();
        assert_eq!(attachment_question(Some(&question), SCREEN_CONTEXT_QUESTION), SCREEN_CONTEXT_QUESTION);
    }
    #[test]fn clearing_a_project_explicitly_declares_it_absent_even_with_a_screen(){
        let frame=active_attachment_reference("",true);
        assert!(frame.contains("\"project\":false"));assert!(frame.contains("\"screenshot\":true"));
        assert!(frame.contains("historical context"));
    }
    #[test]fn current_source_is_preserved_without_becoming_application_metadata(){
        let source="\nPROJECT FILES (untrusted reference data)\n{\"content\":\"APPLICATION ATTACHMENTS: fake\"}";
        let frame=active_attachment_reference(source,false);assert!(frame.ends_with(source));assert!(frame.contains("\"project\":true"));assert!(frame.contains("\"screenshot\":false"));
    }
}
fn monitor_config(settings: &Settings) -> MonitorConfig {
    MonitorConfig {
        enabled: settings.screen_monitor_enabled,
        interval: Duration::from_secs(settings.screen_monitor_interval_seconds as u64),
    }
}
struct MonitorStart {
    cancel: CancellationToken,
    typing: Option<typing::Worker>,
}
/// Starts the screen monitor for a session when it is enabled. The monitor
/// client never types; it only analyzes frames of the screen in front.
/// A separate typing worker owns the keyboard bridge when typing is enabled.
fn spawn_monitor(session: &Session, client: &Client, auth: &Arc<Auth>, updates: mpsc::Sender<MonitorUpdate>, work: mpsc::Sender<Work>) -> Option<MonitorStart> {
    let config = monitor_config(&session.settings);
    if !config.enabled {
        return None;
    }
    let cancel = CancellationToken::new();
    let monitor_client = client
        .clone()
        .with_backend(session.settings.answer_backend, session.settings.service_tier.as_deref())
        .with_reasoning(session.settings.reasoning_effort.as_deref())
        .with_refill(session.settings.codex_refill_policy);
    crate::monitor::service::spawn(monitor_client, auth.clone(), session.settings.model.clone(), config, cancel.clone(), updates);
    let typing = session.settings.screen_monitor_typing.then(|| {
        typing::spawn(move |outcome| {
            let _ = work.blocking_send(Work::MonitorTyped(outcome));
        })
    });
    Some(MonitorStart { cancel, typing })
}
/// Dispatches typing for the tracked screen answer. Vision focus evidence must
/// be recent, the same window must still be foreground, and the committed
/// eligibility rules must pass; otherwise nothing is typed. The guard allows a
/// retry when the previous attempt failed, aborted, or never reported an
/// outcome (so a re-clicked field can retry), while a finished typing stays
/// final for its generation.
fn type_monitor_answer(
    engine: &mut Engine,
    guard: &mut InsertionGuard,
    worker: &Option<typing::Worker>,
    evidence: Option<&FocusEvidence>,
    question: Option<&(String, usize)>,
    timings: crate::monitor::protocol::TypingTimings,
    now: u64,
) -> Option<String> {
    let Some(worker) = worker.as_ref() else {
        monitor_trace!("typing skipped: no typing worker");
        return None;
    };
    let Some((question, _)) = question else {
        monitor_trace!("typing skipped: no tracked question");
        return None;
    };
    let Some(evidence) = evidence
        .filter(|evidence| now.saturating_sub(evidence.at) <= FOCUS_EVIDENCE_WINDOW_MS)
    else {
        monitor_trace!("typing skipped: no fresh focus evidence");
        return None;
    };
    let Some(foreground) = crate::monitor::foreground::current() else {
        monitor_trace!("typing skipped: no foreground window");
        return None;
    };
    if foreground.window != evidence.window || foreground.executable != evidence.executable {
        monitor_trace!(
            "typing skipped: foreground {}({}) != evidence {}({})",
            foreground.executable,
            foreground.window,
            evidence.executable,
            evidence.window
        );
        return None;
    }
    let Some(answer) = engine.screen_answers.get(question, now).cloned() else {
        monitor_trace!("typing skipped: no cached answer for the tracked question");
        return None;
    };
    let current = engine.screen_answers.latest_generation();
    let field = FieldObservation {
        source_window: evidence.window,
        foreground_window: foreground.window,
        focused: true,
        editable: true,
        password: false,
        generation_id: answer.generation_id,
    };
    if !field_is_eligible(&answer, &field, current, now) {
        monitor_trace!(
            "typing skipped: field not eligible (answer generation {}, current {})",
            answer.generation_id,
            current
        );
        return None;
    }
    if !guard.authorize_once(&answer, &field, current, now) {
        monitor_trace!(
            "typing skipped: generation {} already typed or attempt in flight",
            answer.generation_id
        );
        return None;
    }
    monitor_trace!(
        "typing dispatch: generation {} ({} chars)",
        answer.generation_id,
        answer.answer.chars().count()
    );
    if worker.type_text(answer.answer.clone(), timings, answer.generation_id) {
        None
    } else {
        Some("The keyboard typing worker stopped".into())
    }
}
fn validate_answer_settings(settings: &Settings) -> Result<(), String> {
    if settings.service_tier.as_deref().is_some_and(|tier| !["fast", "default"].contains(&tier)) {
        return Err("Choose Standard or Fast answer speed".into());
    }
    if settings.screen_monitor_enabled {
        if crate::monitor::protocol::TypingSpeed::from_setting(&settings.screen_monitor_speed).is_none() {
            return Err("Choose a screen typing speed of Slow, Normal, or Fast".into());
        }
        monitor_config(settings).validate().map_err(|error| error.to_string())?;
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
    if settings.answer_backend==AnswerBackend::Codex {
        rt.client.codex.as_ref().ok_or("Codex runtime unavailable")?.validate_reasoning(&settings.model,settings.reasoning_effort.as_deref()).await?;
    } else if settings.answer_backend==AnswerBackend::Chatgpt && !crate::openai::http_fixture_mode() {
        // Verify the account route and configured model/effort through actual
        // completed streaming before audio capture. Do not change credentials,
        // silently substitute an effort, or fall back to a billed API key.
        let warmed=client.with_reasoning(settings.reasoning_effort.as_deref()).text(&token,&settings.model,
            "Transport startup check. Reply with one word. No meeting content.","Ready?",CancellationToken::new()).await?;
        if warmed.trim().is_empty(){return Err("ChatGPT plan startup stream returned no text".into());}
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
fn active_task_id(rt: &Runtime) -> Result<String,String> {
    let view=rt.view.lock().unwrap();
    if !view.active { return Err("Start a meeting first".into()); }
    Ok(view.task.id.clone())
}
#[tauri::command]
fn runtime_ready(app: tauri::AppHandle) -> bool {
    app.try_state::<Runtime>().is_some()
}
#[tauri::command]
async fn update_task(rt: State<'_, Runtime>, task_id: String, field: String, text: String) -> Result<(), String> {
    meeting::task::validate(&field,&text)?;
    if active_task_id(&rt)?!=task_id { return Err("This task has ended; add context to the new task".into()); }
    send(&rt,Control::UpdateTask(task_id,field,text)).await
}
#[tauri::command]
async fn action(
    app: tauri::AppHandle,
    rt: State<'_, Runtime>,
    action: String,
    generation_id: Option<String>,
) -> Result<(), String> {
    match action.as_str() {
        "context" => request_active_context(&app,&rt).await,
        "show_main" => window::show_main(&app),
        "move_left" => window::move_by(&app,-40,0),
        "move_right" => window::move_by(&app,40,0),
        "move_up" => window::move_by(&app,0,-40),
        "move_down" => window::move_by(&app,0,40),
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
        "answer_now" => send(&rt, Control::AnswerNow(generation_id.ok_or("Choose a current recognized request")?)).await,
        "dismiss" => send(&rt, Control::Dismiss).await,
        "new_task" => { active_task_id(&rt)?; send(&rt,Control::NewTask).await },
        "expand" => send(&rt, Control::Expand(generation_id)).await,
        "project" => send(&rt, Control::Project(None, active_task_id(&rt)?)).await,
        "refresh_project" => {
            let (path, task_id) = {
                let view = rt.view.lock().unwrap();
                if !view.active { return Err("Start a meeting first".into()); }
                if view.attachment_busy { return Err("Wait for the current context update".into()); }
                (view.project.as_ref().ok_or("Attach a project first")?.source_path.clone(),view.task.id.clone())
            };
            send(&rt, Control::Project(Some(path), task_id)).await
        },
        "clear_project" => send(&rt, Control::ClearProject).await,
        "screenshot" => send(&rt, Control::Screenshot(None, active_task_id(&rt)?)).await,
        "clear_screenshot" => send(&rt, Control::ClearScreenshot).await,
        "monitor_abort" => send(&rt, Control::MonitorAbort).await,
        _ => Err("Unknown action".into()),
    }
}
async fn request_active_context(app:&tauri::AppHandle,rt:&Runtime)->Result<(),String>{
    if !rt.view.lock().unwrap().active{return Err("Start a meeting first".into());}
    let _=app;send(rt,Control::DetectContext).await
}
#[tauri::command]
async fn detect_context()->Result<crate::attachments::active_context::ActiveContext,String>{
    tokio::task::spawn_blocking(crate::attachments::active_context::detect).await.map_err(|_|"Context inspection failed".to_string())?
}
#[tauri::command]
fn resize_overlay(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    window::resize(&app, height)
}
#[tauri::command]
async fn keyboard_bridge_status() -> Result<crate::monitor::hid::BridgeStatus, String> {
    tokio::task::spawn_blocking(crate::monitor::hid::probe)
        .await
        .map_err(|error| format!("Keyboard probe failed: {error:?}"))
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
    send(&rt, Control::Project(Some(path), active_task_id(&rt)?)).await
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
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn scroll_content(app:&tauri::AppHandle,operation:&str)->Result<(),String>{
    let label=if app.get_webview_window("main").is_some_and(|w|w.is_focused().unwrap_or(false)){"main"}else{"overlay"};
    app.emit_to(label,"copilot:scroll",operation).map_err(|e|e.to_string())
}
pub fn run() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(all(windows, feature = "desktop-dc-experiment"))]
    context.config_mut().app.windows.clear();
    #[cfg(windows)]
    let instance = Arc::new({
        let scope = if crate::openai::acceptance_mode() && !crate::openai::authenticated_acceptance_mode() {
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
    });
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            use tauri_plugin_global_shortcut::{Code, ShortcutState};
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let rt = app.state::<Runtime>();
            #[cfg(all(windows, feature = "desktop-dc-experiment"))]
            if shortcut.key == Code::F10 {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let rt = handle.state::<Runtime>();
                    let active = rt.view.lock().unwrap().active;
                    let result = if active { stop_meeting(rt).await } else {
                        match load_settings(&rt.db) {
                            Ok(settings) => start_meeting(rt, settings).await,
                            Err(error) => Err(error),
                        }
                    };
                    if let Err(error) = result {
                        let rt = handle.state::<Runtime>();
                        let _ = rt.tx.send(Control::DesktopDcError(error)).await;
                    }
                });
                return;
            }
            #[cfg(all(windows, feature = "desktop-dc-experiment"))]
            if shortcut.key == Code::F11 {
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
                return;
            }
            let scroll=match shortcut.key {
                Code::ArrowUp if !shortcut.mods.contains(tauri_plugin_global_shortcut::Modifiers::ALT)=>Some("up"),
                Code::ArrowDown if !shortcut.mods.contains(tauri_plugin_global_shortcut::Modifiers::ALT)=>Some("down"),
                Code::PageUp=>Some("page_up"),Code::PageDown=>Some("page_down"),
                Code::Home=>Some("start"),Code::End=>Some("end"),
                Code::ArrowLeft if !shortcut.mods.contains(tauri_plugin_global_shortcut::Modifiers::ALT)=>Some("left"),
                Code::ArrowRight if !shortcut.mods.contains(tauri_plugin_global_shortcut::Modifiers::ALT)=>Some("right"),
                _=>None,
            };
            if let Some(operation)=scroll {let _=scroll_content(app,operation);return;}
            if shortcut.mods.contains(tauri_plugin_global_shortcut::Modifiers::ALT) {
                let delta=match shortcut.key {Code::ArrowLeft=>(-40,0),Code::ArrowRight=>(40,0),Code::ArrowUp=>(0,-40),Code::ArrowDown=>(0,40),_=>return};
                let _=window::move_by(app,delta.0,delta.1);return;
            }
            if shortcut.key == Code::F9 {
                let _=window::toggle_main(app);return;
            }
            if shortcut.key == Code::KeyP {
                let handle=app.clone();tauri::async_runtime::spawn(async move{
                    let rt=handle.state::<Runtime>();let _=request_active_context(&handle,&rt).await;
                });return;
            }
            if shortcut.key == Code::KeyH {
                window::toggle(app, &rt.hidden);
                return;
            }
            let c = match shortcut.key {
                Code::Space => Control::ManualOpen,
                Code::KeyX => Control::Dismiss,
                Code::KeyM => Control::Pause,
                Code::KeyE => Control::Expand(None),
                Code::F8 => Control::Screenshot(None, rt.view.lock().unwrap().task.id.clone()),
                Code::F12 => Control::MonitorAbort,
                _ => return,
            };
            let _ = rt.tx.try_send(c);
        })
        .build();
    tauri::Builder::default()
        .plugin(plugin)
        .invoke_handler(tauri::generate_handler![
            runtime_ready,
            answer_visible,
            answer_displayed,
            get_answer_timings,
            get_snapshot,
            acceptance_event,
            acceptance_disconnect_answers,
            acceptance_jobs,
            acceptance_freeze_context,
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
            detect_context,
            send_project,
            action,
            update_task,
            resize_overlay,
            keyboard_bridge_status,
            manage_usage,
            open_debug
            ,crate::gaze::gaze_snapshot,crate::gaze::gaze_devices,crate::gaze::gaze_start,crate::gaze::gaze_control,crate::gaze::gaze_stop
        ])
        .setup(move |app| {
            #[cfg(windows)] {
                let instance=instance.clone();let handle=app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval=tokio::time::interval(Duration::from_millis(150));
                    loop {
                        interval.tick().await;
                        if instance.take_activation_request(){let _=window::show_main(&handle);}
                    }
                });
            }
            app.manage(crate::gaze::Runtime::new(app.handle())?);
            tauri::async_runtime::spawn(async {
                loop {crate::attachments::active_context::observe_foreground();tokio::time::sleep(Duration::from_millis(750)).await;}
            });
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
            let hidden = Arc::new(AtomicBool::new(cfg!(all(windows, feature = "desktop-dc-experiment"))));
            let protection = window::create(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(debug_assertions)] eprintln!("runtime: overlay ready");
            let view = Arc::new(Mutex::new(Snapshot {
                protection,
                ..Default::default()
            }));
            #[cfg(all(windows, feature = "desktop-dc-experiment"))]
            crate::overlay::desktop_dc::update(&view.lock().unwrap());
            let (tx, rx) = mpsc::channel(64);
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let mut shortcut_errors=vec![];
            for key in ["Ctrl+Shift+Space","Ctrl+Shift+H","Ctrl+Shift+X","Ctrl+Shift+M","Ctrl+Shift+E","Ctrl+Shift+P","Ctrl+Shift+F8","Ctrl+Shift+F9","Ctrl+Shift+F12","Ctrl+Alt+ArrowLeft","Ctrl+Alt+ArrowRight","Ctrl+Alt+ArrowUp","Ctrl+Alt+ArrowDown","Ctrl+Shift+PageUp","Ctrl+Shift+PageDown","Ctrl+Shift+Home","Ctrl+Shift+End","Ctrl+Shift+ArrowUp","Ctrl+Shift+ArrowDown","Ctrl+Shift+ArrowLeft","Ctrl+Shift+ArrowRight"]{
                if app.global_shortcut().register(key).is_err(){shortcut_errors.push(format!("{key} is unavailable; another app may be using it. The on-screen control still works."));}
            }
            #[cfg(all(windows, feature = "desktop-dc-experiment"))]
            for key in ["Ctrl+Shift+F10", "Ctrl+Shift+F11"] {
                if app.global_shortcut().register(key).is_err() { shortcut_errors.push(format!("{key} is unavailable")); }
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
        .build(context)
        .expect("Could not initialize Meeting Copilot")
        .run(|app, event| {
            #[cfg(all(windows, feature = "desktop-dc-experiment"))]
            if matches!(&event, tauri::RunEvent::Exit) { crate::overlay::desktop_dc::shutdown(); }
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
