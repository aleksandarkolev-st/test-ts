use crate::{
    audio,
    meeting::{
        self,
        state::{CurrentQuestion, Engine, Latency, Snapshot},
        InputEvent, SpeakerSource,
    },
    openai::{
        auth::{Account, Auth},
        client::{Client, Model, StreamEvent},
        prompts,
    },
    overlay::window,
    storage::db::Database,
    transcription,
};
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub microphone: String,
    pub output: String,
    pub model_path: String,
    pub model: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    settings: Settings,
    devices: Vec<audio::AudioDevice>,
    accounts: Vec<Account>,
    selected: Option<Account>,
    models: Vec<Model>,
    snapshot: Snapshot,
    debug: bool,
    shortcut_errors: Vec<String>,
}
struct Pipeline {
    capture: audio::Capture,
    transcription: transcription::Transcription,
}
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
    model: Arc<whisper_rs::WhisperContext>,
    pipeline: Option<Pipeline>,
}
enum Control {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    Protection(bool, oneshot::Sender<()>),
    #[cfg(all(feature = "acceptance", debug_assertions))]
    Inject(InputEvent, oneshot::Sender<u64>),
    Start(Settings, oneshot::Sender<Result<(), String>>),
    Stop(oneshot::Sender<Result<(), String>>),
    Pause,
    ManualOpen,
    Manual(String),
    Dismiss,
    Expand,
}
enum Work {
    Sent(String, u64),
    Delta(String, String),
    Complete(String),
    Error(String, String),
    Summary(String, meeting::context::Memory),
    SummaryError(String, String),
}
pub struct Runtime {
    tx: mpsc::Sender<Control>,
    view: Arc<Mutex<Snapshot>>,
    auth: Arc<Auth>,
    db: Arc<Database>,
    client: Client,
    hidden: Arc<AtomicBool>,
    lifecycle: tokio::sync::Mutex<()>,
    models: tokio::sync::Mutex<Vec<Model>>,
    default_model: String,
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
fn pipeline(
    model: Arc<whisper_rs::WhisperContext>,
    s: &Settings,
    clock: Instant,
    events: mpsc::Sender<InputEvent>,
    levels: Arc<Mutex<(f32, f32)>>,
) -> Result<Pipeline, String> {
    let (tx, rx) = mpsc::channel(128);
    let transcription = transcription::start(model, rx, events.clone(), levels)?;
    let capture = audio::start(s.output.clone(), s.microphone.clone(), clock, tx, events)?;
    Ok(Pipeline {
        capture,
        transcription,
    })
}
async fn actor(
    app: tauri::AppHandle,
    mut controls: mpsc::Receiver<Control>,
    view: Arc<Mutex<Snapshot>>,
    auth: Arc<Auth>,
    db: Arc<Database>,
    client: Client,
    hidden: Arc<AtomicBool>,
) {
    let mut engine = Engine::default();
    engine.view.protection = view.lock().unwrap().protection;
    let mut session: Option<Session> = None;
    let mut generation: Option<CancellationToken> = None;
    let mut automatic = false;
    let mut summary: Option<CancellationToken> = None;
    let (mut events_tx, mut events) = mpsc::channel(256);
    let (work_tx, mut work) = mpsc::channel(256);
    let levels = Arc::new(Mutex::new((0., 0.)));
    let mut tick = tokio::time::interval(Duration::from_millis(40));
    let mut transcript_at = 0;
    let mut summary_retry_at = 0;
    loop {
        tokio::select! {
            control=controls.recv()=>{let Some(control)=control else{break};match control {
                #[cfg(all(feature="acceptance",debug_assertions))] Control::Protection(enabled,reply)=>{engine.view.protection=enabled;publish(&app,&mut engine,&view);let _=reply.send(());},
                #[cfg(all(feature="acceptance",debug_assertions))] Control::Inject(mut event,reply)=>{let now=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64).unwrap_or(0);match &mut event{InputEvent::SpeechStarted(_,t)|InputEvent::SpeechEnded(_,t)=>*t=now,InputEvent::Transcript(s)=>{s.started_at=now;s.ended_at=now;},_=>{}}let _=events_tx.send(event).await;let _=reply.send(now);}, Control::Start(settings,reply)=>{
                    if session.is_some(){let _=reply.send(Err("A meeting is already active".into()));continue;}
                    let (tx, rx) = mpsc::channel(256); events_tx = tx; events = rx;
                    let model_path=settings.model_path.clone();let started=tokio::task::spawn_blocking(move||transcription::whisper::load(&model_path)).await.map_err(|e|e.to_string()).and_then(|r|r);
                    match started {
                        Ok(model)=>{let clock=Instant::now();let copy=settings.clone();let ctx=model.clone();let tx=events_tx.clone();let lv=levels.clone();let result=tokio::task::spawn_blocking(move||pipeline(ctx,&copy,clock,tx,lv)).await.map_err(|e|e.to_string()).and_then(|r|r);
                            match result {Ok(p)=>{let id=uuid::Uuid::new_v4().to_string();if let Err(e)=db.start(&id,crate::openai::auth::now()){drop(p);let _=reply.send(Err(e));continue;}
                                summary_retry_at=0;transcript_at=0;engine.clear_meeting();engine.view.active=true;engine.view.status="listening".into();hidden.store(false,Ordering::Release);session=Some(Session{id,clock,settings,model,pipeline:Some(p)});publish(&app,&mut engine,&view);let _=window::position(&app);window::show(&app,&hidden);emit(&app,"meeting.started",());let _=reply.send(Ok(()));},Err(e)=>{let _=reply.send(Err(e));}}
                        },Err(e)=>{let _=reply.send(Err(e));}
                    }
                },
                Control::Stop(reply)=>{automatic=false;
                    cancel_answer(&app,&mut generation);if let Some(c)=summary.take(){c.cancel()}
                    let result=if let Some(mut s)=session.take(){if let Some(mut p)=s.pipeline.take(){let _=tokio::task::spawn_blocking(move||p.stop()).await;}db.stop(&s.id,crate::openai::auth::now())}else{Ok(())};
                    let (tx, rx) = mpsc::channel(256); events_tx = tx; events = rx; while work.try_recv().is_ok(){}*levels.lock().unwrap()=(0.,0.);engine.clear_meeting();window::set_manual(&app,false);window::hide(&app);publish(&app,&mut engine,&view);emit(&app,"meeting.stopped",());let _=reply.send(result);
                },
                Control::Pause=>{automatic=false;if let Some(s)=session.as_mut(){
                    cancel_answer(&app,&mut generation);engine.view.answer.clear();engine.view.question=None;engine.detector.clear();
                    if let Some(mut p)=s.pipeline.take(){let _=tokio::task::spawn_blocking(move||p.stop()).await;engine.view.paused=true;*levels.lock().unwrap()=(0.,0.);let (tx, rx) = mpsc::channel(256); events_tx = tx; events = rx; engine.view.error=None;engine.view.status="listening".into();}
                    else {let model=s.model.clone();let settings=s.settings.clone();let clock=s.clock;let tx=events_tx.clone();let lv=levels.clone();match tokio::task::spawn_blocking(move||pipeline(model,&settings,clock,tx,lv)).await.map_err(|e|e.to_string()).and_then(|r|r){Ok(p)=>{s.pipeline=Some(p);engine.view.paused=false;engine.view.status="listening".into();engine.view.error=None;},Err(e)=>{engine.view.error=Some(e);engine.view.status="error".into();}}}
                    publish(&app,&mut engine,&view);
                }},
                Control::ManualOpen=>{if session.is_some(){engine.view.manual=true;hidden.store(false,Ordering::Release);window::show(&app,&hidden);window::set_manual(&app,true);publish(&app,&mut engine,&view);}},
                Control::Manual(question)=>{automatic=false;if let Some(s)=session.as_ref(){let question=question.trim().to_string();if !question.is_empty()&&question.len()<=4000{engine.view.manual=false;window::set_manual(&app,false);cancel_answer(&app,&mut generation);let now=s.clock.elapsed().as_millis()as u64;generation=Some(generate(&app,&mut engine,s,&auth,&client,work_tx.clone(),question,now,now,prompts::ANSWER));publish(&app,&mut engine,&view);}}},
                Control::Dismiss=>{automatic=false;cancel_answer(&app,&mut generation);engine.detector.clear();engine.view.question=None;engine.view.answer.clear();engine.view.error=None;engine.view.expanded=false;engine.view.manual=false;window::set_manual(&app,false);engine.view.status=if engine.view.active{"listening"}else{"off"}.into();publish(&app,&mut engine,&view);},
                Control::Expand=>{if let Some(s)=session.as_ref(){if let Some(q)=engine.view.question.clone(){engine.view.expanded=true;cancel_answer(&app,&mut generation);let now=s.clock.elapsed().as_millis()as u64;generation=Some(generate(&app,&mut engine,s,&auth,&client,work_tx.clone(),q.text,now,now,prompts::EXPAND));publish(&app,&mut engine,&view);}}},
            }},
            event=events.recv(),if session.is_some()=>{let Some(event)=event else{continue};let s=session.as_ref().unwrap();let now=s.clock.elapsed().as_millis()as u64;if engine.view.paused{continue;}
                match event {
                    InputEvent::SpeechStarted(source,t)=>{
                        emit(&app,"speech.started",serde_json::json!({"source":source,"timestamp":t}));
                        let continuing = source==SpeakerSource::Remote && automatic && (generation.is_some() || (engine.view.question.is_some() && engine.detector.may_continue(now)));
                        engine.detector.speech_started(source,now);
                        if continuing{engine.detector.continue_question();cancel_answer(&app,&mut generation);engine.view.question=None;engine.view.answer.clear();engine.view.status="listening".into();publish(&app,&mut engine,&view);}
                    },
                    InputEvent::SpeechEnded(source,t)=>{engine.detector.speech_ended(source,t);emit(&app,"speech.ended",serde_json::json!({"source":source,"timestamp":t}));},
                    InputEvent::Transcript(segment)=>{
                        #[cfg(debug_assertions)]{let _=app.emit("copilot:transcript",&segment);}
                        if segment.final_{if segment.source==SpeakerSource::Remote{transcript_at=now;}if !segment.text.trim().is_empty(){engine.context.push(segment.clone());}if engine.detector.transcript(&segment){engine.view.status="question".into();emit(&app,"question.candidate",());publish(&app,&mut engine,&view);}}
                    },
                    InputEvent::Failure(error)=>{
                        cancel_answer(&app,&mut generation);
                        if let Some(c)=summary.take(){c.cancel();engine.context.fail_summary();}
                        if let Some(s)=session.as_mut(){if let Some(mut p)=s.pipeline.take(){let _=tokio::task::spawn_blocking(move||p.stop()).await;}}
                        let (tx,rx)=mpsc::channel(256);events_tx=tx;events=rx;
                        *levels.lock().unwrap()=(0.,0.);engine.detector.clear();
                        engine.view.paused=true;engine.view.error=Some(error);engine.view.status="error".into();publish(&app,&mut engine,&view);
                    },_=>{}
                }
            },
            w=work.recv()=>{let Some(w)=w else{continue};match w {
                Work::Sent(id,time)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){if let Some(l)=engine.view.latency.as_mut(){l.request_sent_at=time;}}},
                Work::Delta(id,delta)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){let now=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64).unwrap_or(0);if let Some(l)=engine.view.latency.as_mut(){if l.first_token_at.is_none(){l.first_token_at=Some(now)}}if engine.view.answer.len()+delta.len()>32_000{cancel_answer(&app,&mut generation);engine.view.error=Some("Answer exceeds display size limit".into());engine.view.status="error".into();publish(&app,&mut engine,&view);continue;}engine.view.answer.push_str(&delta);engine.view.status="answer".into();emit(&app,"answer.delta",serde_json::json!({"id":id,"delta":delta}));publish(&app,&mut engine,&view);}},
                Work::Complete(id)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){generation=None;if let Some(l)=engine.view.latency.as_mut(){l.completed_at=session.as_ref().map(|s|s.clock.elapsed().as_millis()as u64);let metrics=serde_json::json!({"speech_to_transcript":l.transcript_final_at.saturating_sub(l.speech_stopped_at),"question_detection":l.question_confirmed_at.saturating_sub(l.transcript_final_at),"request_to_first_token":l.first_token_at.map(|t|t.saturating_sub(l.request_sent_at)),"total_to_first_answer":l.first_token_at.map(|t|t.saturating_sub(l.speech_stopped_at))});emit(&app,"latency.measured",metrics.clone());eprintln!("latency {metrics}");}emit(&app,"answer.completed",serde_json::json!({"id":id}));publish(&app,&mut engine,&view);}},
                Work::Error(id,error)=>{if engine.view.question.as_ref().is_some_and(|q|q.id==id)&&generation.is_some(){generation=None;engine.view.status="error".into();engine.view.error=Some(error);publish(&app,&mut engine,&view);}},
                Work::Summary(id,memory)=>{if let Some(s)=session.as_ref().filter(|s|s.id==id){summary=None;engine.context.complete_summary(memory);summary_retry_at=s.clock.elapsed().as_millis()as u64+30_000;}},
                Work::SummaryError(id,error)=>{if let Some(s)=session.as_ref().filter(|s|s.id==id){summary=None;engine.context.fail_summary();summary_retry_at=s.clock.elapsed().as_millis()as u64+30_000;emit(&app,"context.error",error);}}
            }},
            _=tick.tick()=>{if let Some(s)=session.as_ref(){let now=s.clock.elapsed().as_millis()as u64;
                if !engine.view.paused&&engine.view.status!="error" {
                    if let Some((question,stopped))=engine.detector.confirm(now){automatic=true;cancel_answer(&app,&mut generation);emit(&app,"question.confirmed",());generation=Some(generate(&app,&mut engine,s,&auth,&client,work_tx.clone(),question,stopped,transcript_at,prompts::ANSWER));publish(&app,&mut engine,&view);}
                    if generation.is_none()&&summary.is_none()&&now>=summary_retry_at{if let Some(batch)=engine.context.take_summary_batch(){let input=format!("PRIOR MEMORY\n{}\nOLDER TRANSCRIPT\n{}",serde_json::to_string(&engine.context.memory).unwrap_or_default(),meeting::context::conversation(&batch));let cancel=CancellationToken::new();summary=Some(cancel.clone());let id=s.id.clone();let model=s.settings.model.clone();let auth=auth.clone();let client=client.clone();let tx=work_tx.clone();tauri::async_runtime::spawn(async move{let result=async{let token=tokio::select!{_=cancel.cancelled()=>return Err("cancelled".into()),r=auth.token()=>r?};let text=client.text(&token,&model,prompts::SUMMARY,&input,cancel.clone()).await?;serde_json::from_str(&text).map_err(|_|"Could not parse meeting memory".to_string())}.await;if cancel.is_cancelled(){return;}let result=match result{Ok(m)=>Work::Summary(id,m),Err(e)=>Work::SummaryError(id,e)};let _=tx.send(result).await;});}}
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
    tx: mpsc::Sender<Work>,
    question: String,
    stopped: u64,
    transcript: u64,
    instructions: &'static str,
) -> CancellationToken {
    let id = uuid::Uuid::new_v4().to_string();
    let now = s.clock.elapsed().as_millis() as u64;
    let input = engine.context.prompt(&question);
    engine.view.question = Some(CurrentQuestion {
        id: id.clone(),
        text: question,
        detected_at: now,
    });
    engine.view.answer.clear();
    engine.view.error = None;
    engine.view.status = "thinking".into();
    engine.view.expanded = instructions == prompts::EXPAND;
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
        .with_reasoning(s.settings.reasoning_effort.as_deref());
    let model = s.settings.model.clone();
    let clock = s.clock;
    tauri::async_runtime::spawn(async move {
        let result=async{let token=tokio::select!{_=abort.cancelled()=>return Err("cancelled".into()),r=auth.token()=>r?};if abort.is_cancelled(){return Err("cancelled".into());}tx.send(Work::Sent(id.clone(),clock.elapsed().as_millis()as u64)).await.map_err(|_|"Meeting receiver closed")?;client.stream(&token,&model,instructions,&input,abort.clone(),|event|{let event=match event{StreamEvent::Delta(d)=>Work::Delta(id.clone(),d),StreamEvent::Completed=>Work::Complete(id.clone())};let queue=tx.clone();async move{queue.send(event).await.map_err(|_|"Meeting stream receiver closed".to_string())}}).await}.await;
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
    if settings.model_path.is_empty() {
        settings.model_path = rt.default_model.clone();
    }
    let devices = tokio::task::spawn_blocking(audio::devices)
        .await
        .map_err(|e| e.to_string())??;
    Ok(Bootstrap {
        settings,
        devices,
        accounts: rt.auth.accounts().await,
        selected: rt.auth.selected_account().await,
        models: rt.models.lock().await.clone(),
        snapshot: rt.view.lock().unwrap().clone(),
        debug: cfg!(debug_assertions),
        shortcut_errors: rt.shortcut_errors.clone(),
    })
}
#[tauri::command]
fn get_snapshot(rt: State<'_, Runtime>) -> Snapshot {
    rt.view.lock().unwrap().clone()
}
#[tauri::command]
async fn acceptance_event(
    rt: State<'_, Runtime>,
    kind: String,
    source: SpeakerSource,
    text: Option<String>,
) -> Result<u64, String> {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    if crate::openai::acceptance_mode() {
        let event = match kind.as_str() {
            "started" => InputEvent::SpeechStarted(source, 0),
            "ended" => InputEvent::SpeechEnded(source, 0),
            "transcript" => InputEvent::Transcript(meeting::TranscriptSegment {
                id: uuid::Uuid::new_v4().to_string(),
                source,
                text: text.unwrap_or_default(),
                started_at: 0,
                ended_at: 0,
                final_: true,
            }),
            _ => return Err("Unknown test event".into()),
        };
        let (tx, rx) = oneshot::channel();
        send(&rt, Control::Inject(event, tx)).await?;
        return rx.await.map_err(|e| e.to_string());
    }
    let _ = (rt, kind, source, text);
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
        .map(|s| s.unwrap_or_default())
}
#[tauri::command]
async fn sign_in(rt: State<'_, Runtime>, client_id: Option<String>) -> Result<Account, String> {
    let _lock = rt.lifecycle.lock().await;
    if rt.view.lock().unwrap().active {
        return Err("Stop the meeting before changing accounts".into());
    }
    let a = rt.auth.sign_in(client_id).await?;
    rt.models.lock().await.clear();
    Ok(a)
}
#[tauri::command]
async fn cancel_sign_in(rt: State<'_, Runtime>) -> Result<(), String> {
    rt.auth.cancel_sign_in().await;
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
    let token = rt.auth.token().await?;
    let models = rt.client.models(&token).await?;
    *rt.models.lock().await = models.clone();
    Ok(models)
}
#[tauri::command]
async fn save_settings(rt: State<'_, Runtime>, settings: Settings) -> Result<(), String> {
    if rt.view.lock().unwrap().active {
        return Err("Stop the meeting before changing devices".into());
    }
    rt.db.set(
        "audio_settings",
        &serde_json::to_string(&settings).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
async fn start_meeting(rt: State<'_, Runtime>, settings: Settings) -> Result<(), String> {
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
    let token = rt.auth.token().await?;
    let models = rt.client.models(&token).await?;
    if !models.iter().any(|m| m.slug == settings.model) {
        return Err("Choose a model from the account catalog".into());
    }
    rt.db.set(
        "audio_settings",
        &serde_json::to_string(&settings).map_err(|e| e.to_string())?,
    )?;
    let (tx, rx) = oneshot::channel();
    send(&rt, Control::Start(settings, tx)).await?;
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
        _ => Err("Unknown action".into()),
    }
}
#[tauri::command]
fn resize_overlay(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    window::resize(&app, height)
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
                _ => return,
            };
            let _ = rt.tx.try_send(c);
        })
        .build();
    tauri::Builder::default()
        .plugin(plugin)
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            acceptance_event,
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
            action,
            resize_overlay,
            manage_usage,
            open_debug
        ])
        .setup(|app| {
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
            let db = Arc::new(
                Database::open(&dir.join("settings.sqlite")).map_err(std::io::Error::other)?,
            );
            let auth = Arc::new(Auth::new(db.clone()).map_err(std::io::Error::other)?);
            #[cfg(debug_assertions)] eprintln!("runtime: local storage ready");
            let client = Client::default();
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
            for key in ["Ctrl+Shift+Space","Ctrl+Shift+H","Ctrl+Shift+X","Ctrl+Shift+M","Ctrl+Shift+ArrowUp"]{
                if app.global_shortcut().register(key).is_err(){shortcut_errors.push(format!("{key} is unavailable; another app may be using it. The on-screen control still works."));}
            }
            app.manage(Runtime {
                tx,
                view: view.clone(),
                auth: auth.clone(),
                db: db.clone(),
                client: client.clone(),
                hidden: hidden.clone(),
                lifecycle: tokio::sync::Mutex::new(()),
            models: tokio::sync::Mutex::new(vec![]),
            default_model,
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
                        rt.auth.wait_for_token_requests().await;
                        handle.exit(0);
                    });
                }
            }
        });
}
