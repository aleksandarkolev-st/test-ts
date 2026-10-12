//! The official NeMo runtime lives in its own process: its GGML DLLs must not
//! share an address space with Whisper. Each source owns a cache-aware socket.
use crate::{
    audio::AudioFrame,
    meeting::{InputEvent, SpeakerSource, TranscriptSegment},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;
#[cfg(windows)]
use crate::process::ProcessJob;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
#[derive(Clone,Debug,serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct Device { pub index:u32, pub name:String, pub kind:String, pub memory_total:u64 }
pub async fn devices(runtime:&str,cancel:&CancellationToken)->Result<Vec<Device>,String> {
    let runtime=Path::new(runtime).canonicalize().map_err(|_|"Choose the installed local nemo-speech.exe runtime")?;
    let mut command=tokio::process::Command::new(&runtime);
    command.args(["doctor","--json"]).current_dir(runtime.parent().unwrap()).stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let output=tokio::select!{_=cancel.cancelled()=>return Err("Speech startup cancelled".into()),output=tokio::time::timeout(Duration::from_secs(5),command.output())=>output.map_err(|_|"Local speech GPU discovery timed out")?.map_err(|_|"Cannot inspect local speech GPUs")?};
    if !output.status.success() || output.stdout.len()>128*1024{return Err("Cannot inspect local speech GPUs".into());}
    let value:Value=serde_json::from_slice(&output.stdout).map_err(|_|"Invalid local speech GPU catalog")?;
    let devices=value["devices"].as_array().ok_or("Local speech runtime returned no GPU catalog")?.iter().filter_map(|device|{
        let kind=device["type"].as_str()?;
        if !matches!(kind,"gpu"|"integrated-gpu") || !device["name"].as_str()?.starts_with("Vulkan"){return None;}
        Some(Device{index:u32::try_from(device["index"].as_u64()?).ok()?,name:device["description"].as_str()?.into(),kind:kind.into(),memory_total:device["memory_total"].as_u64().unwrap_or(0)})
    }).collect::<Vec<_>>();
    if devices.is_empty(){return Err("No Vulkan GPU is available for local speech".into());}Ok(devices)
}
pub fn select_device<'a>(devices:&'a[Device],index:u32,name:Option<&str>)->Result<&'a Device,String> {
    if let Some(name)=name.filter(|name|!name.is_empty()) {
        return devices.iter().find(|d|d.name==name && d.index==index).or_else(||devices.iter().find(|d|d.name==name)).ok_or_else(||"The selected speech GPU is unavailable; choose an available GPU".into());
    }
    // Legacy numeric indices cannot identify an adapter after a driver or
    // display change. Migrate to a named discrete GPU, then persist its name.
    devices.iter().max_by_key(|d|(d.kind=="gpu",d.memory_total)).ok_or_else(||"No Vulkan GPU is available for local speech".into())
}

pub fn right_context(chunk_ms: u32) -> Result<u32, String> {
    match chunk_ms {
        80 => Ok(0),
        160 => Ok(1),
        560 => Ok(6),
        1120 => Ok(13),
        _ => Err("Choose a Nemotron chunk of 80, 160, 560 or 1120 ms".into()),
    }
}

pub struct Service {
    child: Mutex<Child>,
    #[cfg(windows)]
    _job: ProcessJob,
    url: String,
    key: String,
    chunk_ms: u32,
}
impl Drop for Service {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Service {
    pub async fn load(
        runtime: &str,
        model: &str,
        chunk_ms: u32,
        device: u32,
        cancel: &CancellationToken,
    ) -> Result<Arc<Self>, String> {
        let context = right_context(chunk_ms)?;
        let backend = format!("vulkan:{device}");
        let runtime = Path::new(runtime)
            .canonicalize()
            .map_err(|_| "Choose the installed local nemo-speech.exe runtime".to_string())?;
        let model = Path::new(model)
            .canonicalize()
            .map_err(|_| "Choose the local Nemotron English GGUF model".to_string())?;
        if !runtime.is_file() || !model.is_file() {
            return Err("Nemotron runtime and model must be files".into());
        }
        // Reserve a random loopback port, then authenticate our child. A port
        // collision fails readiness authentication rather than sending audio.
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|_| "Cannot reserve a local speech port".to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let key = uuid::Uuid::new_v4().to_string();
        let mut command = Command::new(&runtime);
        command
            .current_dir(runtime.parent().unwrap())
            .args([
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--asr-model",
                &model.to_string_lossy(),
                "--backend",
                &backend,
                "--no-ui",
                "--asr.batching.enabled=false",
                "--asr.batching.max_batch_size",
                "2",
                "--asr.batching.state_arena_slots",
                "2",
                "--asr.streaming.rnnt_right_context",
                &context.to_string(),
                "--asr.endpointing.enable=true",
                "--asr.endpointing.stop_history_eou_ms",
                "510",
            ])
            .env("NEMO_SPEECH_HTTP_API_KEY", &key)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(if cfg!(feature="acceptance") && std::env::var("COPILOT_NEMO_DIAGNOSTICS").as_deref()==Ok("1"){Stdio::inherit()}else{Stdio::null()});
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child=command.spawn().map_err(|_|"Cannot launch the local Nemotron runtime".to_string())?;
        #[cfg(windows)]
        let job=match ProcessJob::attach(&child){Ok(job)=>job,Err(error)=>{let _=child.kill();let _=child.wait();return Err(error);}};
        let service = Arc::new(Self {
            child: Mutex::new(child),
            #[cfg(windows)]
            _job: job,
            url: format!("ws://127.0.0.1:{port}/v1/audio/transcriptions/realtime"),
            key,
            chunk_ms,
        });
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
            .map_err(|e| e.to_string())?;
        let started = Instant::now();
        loop {
            if cancel.is_cancelled() {
                return Err("Speech startup cancelled".into());
            }
            if let Some(status)=service
                .child
                .lock()
                .unwrap()
                .try_wait()
                .map_err(|e| e.to_string())?
            {
                return Err(format!("Nemotron exited while loading ({status}). Check the runtime, GGUF model and Vulkan driver"));
            }
            if let Ok(response) = http
                .get(format!("http://127.0.0.1:{port}/ready"))
                .send()
                .await
            {
                if response.status().is_success() {
                    if let Ok(body) = response.json::<Value>().await {
                        if body["ready"] == true
                        && body["device"] == backend
                            && body["capabilities"]
                                .as_array()
                                .is_some_and(|a| a.iter().any(|v| v == "asr"))
                        {
                            // Verify the private API credential before capture starts.
                            let probe = service.connect().await?;
                            drop(probe);
                            return Ok(service);
                        }
                    }
                }
            }
            if started.elapsed() > Duration::from_secs(600) {
                return Err("Nemotron GPU startup exceeded ten minutes".into());
            }
            tokio::select! { _ = cancel.cancelled() => return Err("Speech startup cancelled".into()), _ = tokio::time::sleep(Duration::from_millis(200)) => {} }
        }
    }

    async fn connect(&self) -> Result<Socket, String> {
        let mut request = self
            .url
            .as_str()
            .into_client_request()
            .map_err(|_| "Invalid local speech URL")?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", self.key)
                .parse()
                .map_err(|_| "Invalid local speech credential")?,
        );
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(request))
            .await
            .map_err(|_| "Local speech connection timed out")?
            .map_err(|_| "Cannot connect to the private Nemotron service")?;
        let created = next_json(&mut socket).await?;
        if created["type"] != "session.created" {
            return Err("Nemotron did not create a streaming session".into());
        }
        socket.send(Message::Text(json!({"type":"session.update","session":{"sample_rate":16000,"language":"en-US","automatic_punctuation":true,"endpointing_ms":510}}).to_string().into())).await.map_err(|_|"Cannot configure local speech stream")?;
        if next_json(&mut socket).await?["type"] != "session.updated" {
            return Err("Nemotron rejected streaming configuration".into());
        }
        Ok(socket)
    }
}

async fn next_json(socket: &mut Socket) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    return serde_json::from_str(&text)
                        .map_err(|_| "Invalid local speech event".into())
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                _ => return Err("Local speech connection closed".into()),
            }
        }
    })
    .await
    .map_err(|_| "Local speech handshake timed out".to_string())?
}


// Numeric acceptance diagnostics only: no speech text or audio is retained.
// Socket writes attest local sink flushing, never peer receipt or decoding.
#[cfg(all(feature="acceptance",debug_assertions))]
#[derive(Default)]
struct TransportCounters {
    captured_frames: std::sync::atomic::AtomicU64,
    captured_samples: std::sync::atomic::AtomicU64,
    queued_chunks: std::sync::atomic::AtomicU64,
    queued_bytes: std::sync::atomic::AtomicU64,
    queue_failures: std::sync::atomic::AtomicU64,
    socket_flushed_chunks: std::sync::atomic::AtomicU64,
    socket_flushed_bytes: std::sync::atomic::AtomicU64,
    socket_write_failures: std::sync::atomic::AtomicU64,
    transcript_events: std::sync::atomic::AtomicU64,
    final_events: std::sync::atomic::AtomicU64,
    empty_final_events: std::sync::atomic::AtomicU64,
    nonempty_transcript_events: std::sync::atomic::AtomicU64,
    provider_audio_frontier_micros: std::sync::atomic::AtomicU64,
    provider_frontier_observed: std::sync::atomic::AtomicBool,
}
#[cfg(all(feature="acceptance",debug_assertions))]
impl TransportCounters {
    fn add(counter:&std::sync::atomic::AtomicU64,value:u64){counter.fetch_add(value,std::sync::atomic::Ordering::Relaxed);}
    fn captured(&self,samples:usize){Self::add(&self.captured_frames,1);Self::add(&self.captured_samples,samples as u64);}
    fn queued(&self,bytes:usize){Self::add(&self.queued_chunks,1);Self::add(&self.queued_bytes,bytes as u64);}
    fn flushed(&self,bytes:usize){Self::add(&self.socket_flushed_chunks,1);Self::add(&self.socket_flushed_bytes,bytes as u64);}
    fn received(&self,event:&Value,final_:bool,text:&str){
        Self::add(&self.transcript_events,1);
        if !text.trim().is_empty(){Self::add(&self.nonempty_transcript_events,1);}
        if final_ {Self::add(&self.final_events,1);if text.trim().is_empty(){Self::add(&self.empty_final_events,1);}}
        if let Some(seconds)=event["audio_processed"].as_f64().filter(|v|v.is_finite()&&*v>=0.&&*v<(u64::MAX as f64)/1_000_000.) {
            self.provider_audio_frontier_micros.fetch_max((seconds*1_000_000.).round()as u64,std::sync::atomic::Ordering::Relaxed);
            self.provider_frontier_observed.store(true,std::sync::atomic::Ordering::Relaxed);
        }
    }
    fn snapshot(&self)->Value {
        let load=|c:&std::sync::atomic::AtomicU64|c.load(std::sync::atomic::Ordering::Relaxed);
        json!({"capturedFrames":load(&self.captured_frames),"capturedSamples":load(&self.captured_samples),
            "queuedChunks":load(&self.queued_chunks),"queuedBytes":load(&self.queued_bytes),"queueFailures":load(&self.queue_failures),
            "socketFlushedChunks":load(&self.socket_flushed_chunks),"socketFlushedBytes":load(&self.socket_flushed_bytes),"socketWriteFailures":load(&self.socket_write_failures),
            "transcriptEvents":load(&self.transcript_events),"nonemptyTranscriptEvents":load(&self.nonempty_transcript_events),
            "finalEvents":load(&self.final_events),"emptyFinalEvents":load(&self.empty_final_events),
            "providerAudioFrontierMicros":self.provider_frontier_observed.load(std::sync::atomic::Ordering::Relaxed).then(||load(&self.provider_audio_frontier_micros))})
    }
}

pub struct Streaming {
    #[cfg(all(feature="acceptance",debug_assertions))]
    transport: [Arc<TransportCounters>;2],
    cancel: CancellationToken,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}
impl Streaming {
    #[cfg(all(feature="acceptance",debug_assertions))]
    pub fn acceptance_transport(&self)->Value { json!({"remote":self.transport[0].snapshot(),"self":self.transport[1].snapshot(),"scope":"Per-pipeline numeric diagnostic snapshots are not atomic across stages. Socket flushed means local sink success, not server receipt. Provider audio frontier is raw input frontier, not lexical or source-word time."}) }
    pub fn stop(&mut self) {
        self.cancel.cancel();
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}
impl Drop for Streaming {
    fn drop(&mut self) {
        self.stop();
    }
}

pub async fn start(
    service: Arc<Service>,
    mut frames: mpsc::Receiver<AudioFrame>,
    events: mpsc::Sender<InputEvent>,
    levels: Arc<Mutex<(f32, f32)>>,
) -> Result<Streaming, String> {
    let remote = service.connect().await?;
    let mic = service.connect().await?;
    let cancel = CancellationToken::new();
    #[cfg(all(feature="acceptance",debug_assertions))]
    let transport=[Arc::new(TransportCounters::default()),Arc::new(TransportCounters::default())];
    let capacity = (2000 / service.chunk_ms).max(2) as usize;
    let mut senders = vec![];
    let mut tasks = vec![];
    for (source, socket) in [(SpeakerSource::Remote, remote), (SpeakerSource::Self_, mic)] {
        let (tx, rx) = mpsc::channel(capacity);
        senders.push(tx);
        let token = cancel.clone();
        let ev = events.clone();
        #[cfg(all(feature="acceptance",debug_assertions))]
        let counters=transport[if source==SpeakerSource::Remote {0}else{1}].clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            let result = stream(source, socket, rx, ev.clone(), token.clone(),
                #[cfg(all(feature="acceptance",debug_assertions))] counters).await;
            if !token.is_cancelled() {
                if let Err(error) = result {
                    let _ = ev.send(InputEvent::Failure(error)).await;
                }
            }
        }));
    }
    let token = cancel.clone();
    #[cfg(all(feature="acceptance",debug_assertions))]
    let capture_transport=transport.clone();
    tasks.push(tauri::async_runtime::spawn(async move {
        let mut pending = [Vec::new(), Vec::new()];
        let mut vads = [super::vad::Vad::default(), super::vad::Vad::default()];
        let mut timing = [(0, 0), (0, 0)];
        let count = service.chunk_ms as usize * 16;
        loop {
            let frame = tokio::select! { _ = token.cancelled() => break, f = frames.recv() => match f { Some(f)=>f, None=>break } };
            let i = if frame.source == SpeakerSource::Remote {0} else {1};
            #[cfg(all(feature="acceptance",debug_assertions))]
            capture_transport[i].captured(frame.samples.len());
            let rms = if frame.samples.is_empty(){0.} else {(frame.samples.iter().map(|v|v*v).sum::<f32>()/frame.samples.len() as f32).sqrt()};
            { let mut l = levels.lock().unwrap(); if i==0 {l.0=rms} else {l.1=rms} }
            for event in vads[i].process(&frame.samples, frame.timestamp_ms) {
                let event = match event {
                    super::vad::VadEvent::Started(t) => { timing[i] = (t,t); Some(InputEvent::SpeechStarted(frame.source,t)) },
                    super::vad::VadEvent::Ended(t) => { timing[i].1=t; Some(InputEvent::SpeechEnded(frame.source,t)) },
                    super::vad::VadEvent::Activity{quiet,timestamp} => Some(InputEvent::SpeechActivity(frame.source,timestamp,quiet)),
                    _=>None,
                };
                if let Some(event)=event { if events.send(event).await.is_err(){return;} }
            }
            pending[i].extend(frame.samples.into_iter().map(pcm16));
            while pending[i].len()>=count {
                let samples:Vec<_> = pending[i].drain(..count).collect();
                let bytes:Vec<u8> = samples.into_iter().flat_map(i16::to_le_bytes).collect();
                #[cfg(all(feature="acceptance",debug_assertions))]
                let byte_count=bytes.len();
                if senders[i].try_send(Chunk{bytes,started:timing[i].0,ended:timing[i].1.max(frame.timestamp_ms)}).is_err() {
                    #[cfg(all(feature="acceptance",debug_assertions))]
                    TransportCounters::add(&capture_transport[i].queue_failures,1);
                    let _=events.send(InputEvent::Failure("Nemotron cannot keep up with live audio; listening paused".into())).await;
                    return;
                }
                #[cfg(all(feature="acceptance",debug_assertions))]
                capture_transport[i].queued(byte_count);
            }
        }
    }));
    Ok(Streaming { cancel, tasks, #[cfg(all(feature="acceptance",debug_assertions))] transport })
}

fn pcm16(sample: f32) -> i16 {
    if sample.is_finite() {
        (sample.clamp(-1., 1.) * 32767.).round() as i16
    } else {
        0
    }
}
struct Chunk {
    bytes: Vec<u8>,
    started: u64,
    ended: u64,
}

async fn stream(
    source: SpeakerSource,
    socket: Socket,
    mut chunks: mpsc::Receiver<Chunk>,
    events: mpsc::Sender<InputEvent>,
    cancel: CancellationToken,
    #[cfg(all(feature="acceptance",debug_assertions))] counters:Arc<TransportCounters>,
) -> Result<(), String> {
    let (mut write, mut read) = socket.split();
    // Poll both directions independently. Waiting for a write inside the read
    // loop can deadlock when the peer also waits for its outgoing data to drain.
    let timing=Arc::new(Mutex::new((0_u64,0_u64,false)));
    let sending=async {
        loop {
            let chunk=tokio::select!{_=cancel.cancelled()=>return Ok::<(),String>(()),chunk=chunks.recv()=>match chunk{Some(chunk)=>chunk,None=>return Ok(())}};
            {let mut clock=timing.lock().unwrap();if !clock.2{clock.0=chunk.started;}clock.1=chunk.ended;}
            #[cfg(all(feature="acceptance",debug_assertions))]
            let byte_count=chunk.bytes.len();
            let sent=tokio::select!{
                _=cancel.cancelled()=>return Ok(()),
                sent=tokio::time::timeout(Duration::from_secs(2),write.send(Message::Binary(chunk.bytes.into())))=>sent.map_err(|_|"Local speech stream stalled").and_then(|result|result.map_err(|_|"Local speech stream disconnected"))
            };
            #[cfg(all(feature="acceptance",debug_assertions))]
            if sent.is_ok(){counters.flushed(byte_count);}else{TransportCounters::add(&counters.socket_write_failures,1);}
            sent?;
        }
    };
    let receiving=async {
        let mut text=String::new();let mut id=uuid::Uuid::new_v4().to_string();
        loop {
            let message=tokio::select!{_=cancel.cancelled()=>return Ok::<(),String>(()),message=read.next()=>message.ok_or("Local speech stream disconnected")?.map_err(|_|"Local speech stream disconnected")?};
            match message {
                Message::Text(data)=>{
                    let event:Value=serde_json::from_str(&data).map_err(|_|"Invalid local speech event")?;
                    #[cfg(all(feature="acceptance",debug_assertions))]
                    let first_piece=text.is_empty();
                    let final_=match event["type"].as_str(){
                        Some("conversation.item.input_audio_transcription.delta")=>{text.push_str(event["delta"].as_str().ok_or("Missing streaming transcript")?);false},
                        Some("conversation.item.input_audio_transcription.completed")=>{text=event["transcript"].as_str().ok_or("Missing final transcript")?.into();true},
                        Some("error")=>return Err("Nemotron rejected the live audio stream".into()),_=>continue,
                    };
                    #[cfg(all(feature="acceptance",debug_assertions))]
                    counters.received(&event,final_,&text);
                    if text.len()>32000{return Err("Local transcript exceeds the utterance limit".into());}
                    let (started,ended)={let mut clock=timing.lock().unwrap();clock.2=!final_;(clock.0,clock.1)};
                    #[cfg(all(feature="acceptance",debug_assertions))]
                    if (first_piece||final_)&&std::env::var("COPILOT_TRACE_PROVISIONAL").as_deref()==Ok("1") {
                        tokio::select!{_=cancel.cancelled()=>return Ok(()),
                            sent=events.send(InputEvent::RawTranscriptBoundary(source,final_,text.clone(),started,ended))=>sent.map_err(|_|"Meeting receiver closed")?};
                    }
                    let segment=TranscriptSegment{id:format!("{source:?}-{id}"),source,text:text.trim().into(),started_at:started,ended_at:ended,final_};
                    tokio::select!{_=cancel.cancelled()=>return Ok(()),sent=events.send(InputEvent::Transcript(segment))=>sent.map_err(|_|"Meeting receiver closed")?};
                    if final_{text.clear();id=uuid::Uuid::new_v4().to_string();}
                },
                // Tungstenite queues and flushes automatic Pong replies while
                // polling the stream/sink; a second custom Pong is unnecessary.
                Message::Ping(_)|Message::Pong(_)=>{},
                Message::Close(_)=>return Err("Local speech stream closed unexpectedly".into()),_=>{},
            }
        }
    };
    tokio::select!{result=sending=>result,result=receiving=>result}

}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn named_gpu_survives_reordering_and_legacy_indices_prefer_discrete() {
        let before=vec![Device{index:0,name:"Integrated".into(),kind:"integrated-gpu".into(),memory_total:16},Device{index:1,name:"Discrete".into(),kind:"gpu".into(),memory_total:8}];
        let after=vec![Device{index:1,name:"Integrated".into(),kind:"integrated-gpu".into(),memory_total:16},Device{index:0,name:"Discrete".into(),kind:"gpu".into(),memory_total:8}];
        assert_eq!(select_device(&before,1,None).unwrap().name,"Discrete");
        assert_eq!(select_device(&after,1,None).unwrap().index,0);
        assert_eq!(select_device(&after,1,Some("Discrete")).unwrap().index,0);
        assert_eq!(select_device(&after,0,Some("Integrated")).unwrap().index,1);
        assert!(select_device(&after,0,Some("Missing")).is_err());
        assert_eq!(select_device(&after[..1],0,None).unwrap().name,"Integrated");
        assert!(select_device(&[],0,None).is_err());
    }
    #[test]
    fn native_cache_contexts_match_all_requested_chunks() {
        for (ms, r) in [(80, 0), (160, 1), (560, 6), (1120, 13)] {
            assert_eq!(right_context(ms).unwrap(), r)
        }
        assert!(right_context(320).is_err());
    }
    #[test]
    fn audio_is_finite_clamped_little_endian_pcm() {
        assert_eq!(pcm16(f32::NAN), 0);
        assert_eq!(pcm16(-2.), -32767);
        assert_eq!(pcm16(1.), 32767);
        assert_eq!(pcm16(0.5).to_le_bytes(), [0, 64]);
    }
    #[tokio::test]
    async fn receives_transcripts_while_audio_write_is_backpressured() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            let (tcp,_)=listener.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(tcp).await.unwrap();
            let filler=json!({"type":"fixture.keepalive","padding":"x".repeat(256*1024)}).to_string();
            for _ in 0..100 {socket.send(Message::Text(filler.clone().into())).await.unwrap();}
            assert_eq!(socket.next().await.unwrap().unwrap().into_data().len(),16*1024*1024);
            socket.send(Message::Text(json!({"type":"conversation.item.input_audio_transcription.completed","transcript":"What is our launch target?"}).to_string().into())).await.unwrap();
            std::future::pending::<()>().await;
        });
        let (socket,_)=connect_async(format!("ws://{address}")).await.unwrap();let (tx,rx)=mpsc::channel(2);let (events,mut received)=mpsc::channel(4);
        let cancel=CancellationToken::new();let job=tokio::spawn(stream(SpeakerSource::Remote,socket,rx,events,cancel.clone(),
            #[cfg(all(feature="acceptance",debug_assertions))] Arc::new(TransportCounters::default())));
        tx.send(Chunk{bytes:vec![0;16*1024*1024],started:100,ended:600}).await.unwrap();
        let event=tokio::time::timeout(Duration::from_secs(4),received.recv()).await.unwrap().unwrap();
        assert!(matches!(event,InputEvent::Transcript(segment) if segment.final_ && segment.text=="What is our launch target?"));
        cancel.cancel();assert!(tokio::time::timeout(Duration::from_secs(1),job).await.unwrap().unwrap().is_ok());server.abort();
    }
    #[tokio::test]
    async fn two_sockets_keep_sources_separate_and_cancel_idle_reads() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut jobs = vec![];
            for _ in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                jobs.push(tokio::spawn(async move {
                    let mut socket=tokio_tungstenite::accept_async(tcp).await.unwrap();
                    let bytes=socket.next().await.unwrap().unwrap().into_data();
                    let text=if bytes==[1,0].as_slice(){"remote question?"}else{"self context"};
                    for event in [json!({"type":"conversation.item.input_audio_transcription.delta","delta":text}),json!({"type":"conversation.item.input_audio_transcription.completed","transcript":text})] {
                        socket.send(Message::Text(event.to_string().into())).await.unwrap();
                    }
                    // The client must be stoppable without another audio frame.
                    while socket.next().await.is_some() {}
                }));
            }
            for job in jobs {
                let _ = job.await;
            }
        });
        let (events, mut received) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let mut jobs = vec![];
        let mut senders = vec![];
        for (source, value) in [
            (SpeakerSource::Remote, 1_i16),
            (SpeakerSource::Self_, 2_i16),
        ] {
            let (socket, _) = connect_async(format!("ws://{address}")).await.unwrap();
            let (tx, rx) = mpsc::channel(2);
            senders.push(tx.clone());
            jobs.push(tokio::spawn(stream(
                source,
                socket,
                rx,
                events.clone(),
                cancel.clone(),
                #[cfg(all(feature="acceptance",debug_assertions))] Arc::new(TransportCounters::default()),
            )));
            tx.send(Chunk {
                bytes: value.to_le_bytes().to_vec(),
                started: 100,
                ended: 600,
            })
            .await
            .unwrap();
        }
        let mut finals = vec![];
        for _ in 0..4 {
            let event = tokio::time::timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap()
                .unwrap();
            if let InputEvent::Transcript(segment) = event {
                if segment.final_ {
                    finals.push(segment);
                }
            }
        }
        assert_eq!(finals.len(), 2);
        assert_ne!(finals[0].id, finals[1].id);
        assert!(finals.iter().any(|s| s.source == SpeakerSource::Remote
            && s.text == "remote question?"
            && s.started_at == 100
            && s.ended_at == 600));
        assert!(finals
            .iter()
            .any(|s| s.source == SpeakerSource::Self_ && s.text == "self context"));
        cancel.cancel();
        for job in jobs {
            assert!(tokio::time::timeout(Duration::from_secs(1), job)
                .await
                .unwrap()
                .unwrap()
                .is_ok());
        }
        server.abort();
    }
}

#[cfg(all(test,feature="acceptance",debug_assertions))]
mod transport_counter_tests {
    use super::*;
    #[test]
    fn stages_do_not_infer_receipt_or_nonempty_recognition(){
        let c=TransportCounters::default();c.captured(2560);c.queued(5120);
        assert_eq!(c.snapshot()["socketFlushedChunks"],0);assert_eq!(c.snapshot()["transcriptEvents"],0);
        c.flushed(5120);assert_eq!(c.snapshot()["transcriptEvents"],0);
        c.received(&json!({"audio_processed":0.16}),true,"");let s=c.snapshot();
        assert_eq!(s["capturedSamples"],2560);assert_eq!(s["queuedBytes"],5120);assert_eq!(s["socketFlushedBytes"],5120);
        assert_eq!(s["finalEvents"],1);assert_eq!(s["emptyFinalEvents"],1);assert_eq!(s["nonemptyTranscriptEvents"],0);assert_eq!(s["providerAudioFrontierMicros"],160000);
    }
    #[test]
    fn frontiers_are_optional_monotonic_and_not_lexical_time(){
        let c=TransportCounters::default();assert!(c.snapshot()["providerAudioFrontierMicros"].is_null());
        for event in [json!({}),json!({"audio_processed":-1}),json!({"audio_processed":"bad"})]{c.received(&event,false,"");}
        assert!(c.snapshot()["providerAudioFrontierMicros"].is_null());
        c.received(&json!({"audio_processed":0}),false,"");assert_eq!(c.snapshot()["providerAudioFrontierMicros"],0);
        c.received(&json!({"audio_processed":7.5}),false,"test");c.received(&json!({"audio_processed":2}),true,"test");
        assert_eq!(c.snapshot()["providerAudioFrontierMicros"],7500000);assert_eq!(c.snapshot()["nonemptyTranscriptEvents"],2);
    }
    #[test]
    fn channels_and_new_pipeline_counters_are_independent(){
        let sources=[TransportCounters::default(),TransportCounters::default()];sources[0].captured(17);sources[1].captured(31);
        TransportCounters::add(&sources[0].queue_failures,1);TransportCounters::add(&sources[1].socket_write_failures,1);
        assert_eq!(sources[0].snapshot()["capturedSamples"],17);assert_eq!(sources[1].snapshot()["capturedSamples"],31);
        assert_eq!(sources[0].snapshot()["socketWriteFailures"],0);assert_eq!(sources[1].snapshot()["queueFailures"],0);
        assert_eq!(TransportCounters::default().snapshot()["capturedSamples"],0);
    }
}
