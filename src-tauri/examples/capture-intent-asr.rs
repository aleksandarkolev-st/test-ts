//! Offline data collection through the production Nemotron service and VAD.
//! No answer backend, intent labels, or production settings are loaded here.
use meeting_copilot_core::{
    audio::AudioFrame,
    meeting::{questions::QuestionDetector, InputEvent, SpeakerSource},
    transcription::nemotron,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    runtime: PathBuf,
    model: PathBuf,
    gpu_name: Option<String>,
    chunk_ms: u32,
    utterances: Vec<Utterance>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Utterance {
    id: String,
    wave: PathBuf,
    source_group: String,
    #[serde(default)]
    context: String,
}
fn resolve(base: &Path, path: &Path) -> Result<PathBuf, String> {
    base.join(path).canonicalize().map_err(|e| e.to_string())
}
fn sha(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn record(output: &mut File, value: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *output, &value).map_err(|e| e.to_string())?;
    output.write_all(b"\n").and_then(|_| output.flush()).map_err(|e| e.to_string())
}
fn pcm(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Expected RIFF WAVE".into());
    }
    let limit = (u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize)
        .checked_add(8).ok_or("Invalid RIFF size")?;
    if limit != bytes.len() { return Err("RIFF size does not match file".into()); }
    let (mut offset, mut format, mut samples) = (12_usize, None, None);
    while offset < limit {
        if limit - offset < 8 { return Err("Truncated WAVE chunk header".into()); }
        let size = u32::from_le_bytes(bytes[offset+4..offset+8].try_into().unwrap()) as usize;
        let end = offset.checked_add(8).and_then(|n| n.checked_add(size)).ok_or("Invalid WAVE chunk size")?;
        let next = end.checked_add(size % 2).ok_or("Invalid WAVE padding")?;
        if next > limit { return Err("Truncated WAVE chunk".into()); }
        let body = &bytes[offset+8..end];
        match &bytes[offset..offset+4] {
            b"fmt " => {
                if format.is_some() || body.len() < 16 { return Err("Invalid or duplicate WAVE format".into()); }
                format = Some((
                    u16::from_le_bytes(body[..2].try_into().unwrap()),
                    u16::from_le_bytes(body[2..4].try_into().unwrap()),
                    u32::from_le_bytes(body[4..8].try_into().unwrap()),
                    u32::from_le_bytes(body[8..12].try_into().unwrap()),
                    u16::from_le_bytes(body[12..14].try_into().unwrap()),
                    u16::from_le_bytes(body[14..16].try_into().unwrap()),
                ));
            }
            b"data" => {
                if samples.is_some() { return Err("Duplicate WAVE data".into()); }
                samples = Some(body);
            }
            _ => {},
        }
        offset = next;
    }
    if format != Some((1, 1, 16000, 32000, 2, 16)) {
        return Err("Capture requires mono PCM16, 16 kHz, with consistent byte rate and alignment".into());
    }
    let samples = samples.ok_or("Missing WAVE data")?;
    if samples.is_empty() || samples.len() % 2 != 0 { return Err("Empty or incomplete PCM samples".into()); }
    Ok(samples.chunks_exact(2).map(|x| i16::from_le_bytes(x.try_into().unwrap()) as f32 / 32768.).collect())
}

async fn capture(service: Arc<nemotron::Service>, row: &Utterance, samples: Vec<f32>, output: &mut File) -> Result<(), String> {
    let (frames, receiver) = mpsc::channel(4);
    let (events, mut received) = mpsc::channel(256);
    let mut stream = nemotron::start(service, receiver, events, Arc::new(Mutex::new((0., 0.)))).await?;
    let clock = Instant::now();
    let mut audio = samples;
    // Match live endpointing without a protocol-specific commit or guessed text.
    // Pad the last frame and provide two seconds of actual silent PCM.
    audio.resize(audio.len().div_ceil(160) * 160 + 32000, 0.);
    let feed = async {
        let mut max_lateness = 0_u64;
        for (index, frame) in audio.chunks(160).enumerate() {
            let timestamp = index as u64 * 10;
            tokio::time::sleep_until((clock + Duration::from_millis(timestamp)).into()).await;
            max_lateness = max_lateness.max((clock.elapsed().as_millis() as u64).saturating_sub(timestamp));
            frames.send(AudioFrame { source: SpeakerSource::Remote, samples: frame.to_vec(), timestamp_ms: timestamp })
                .await.map_err(|_| "Audio receiver stopped")?;
        }
        Ok::<u64, String>(max_lateness)
    };
    tokio::pin!(feed);
    let mut detector = QuestionDetector::default();
    detector.semantic_intent = true;
    detector.independent_asr_endpoint = true;
    let mut feeding = true;
    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(86400);
    let (mut speech_end, mut final_end, mut pending_partial) = (None, None, false);
    let mut changed = None;
    let mut event_count = 0;
    let result = loop {
        tokio::select! {
            result = &mut feed, if feeding => {
                let lateness = match result { Ok(value) => value, Err(error) => break Err(error) };
                feeding = false;
                deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                record(output, json!({"type":"audio.finished","id":row.id,"observedAtMs":clock.elapsed().as_millis(),
                    "audioMs":audio.len()/16,"maxFrameLatenessMs":lateness}))?;
            }
            _ = tokio::time::sleep_until(deadline), if !feeding => break Err("Final transcript did not cover the last VAD endpoint".into()),
            event = received.recv() => {
                let Some(event) = event else { break Err("ASR event receiver stopped".into()); };
                let observed = clock.elapsed().as_millis() as u64;
                let value = match event {
                    InputEvent::SpeechStarted(source, time) => {
                        detector.speech_started(source,time);
                        speech_end = None; final_end = None;
                        json!({"type":"speech.started","source":source,"audioTimestampMs":time})
                    }
                    InputEvent::SpeechEnded(source, time) => {
                        detector.speech_ended(source,time); speech_end = Some(time);
                        json!({"type":"speech.ended","source":source,"audioTimestampMs":time})
                    }
                    InputEvent::SpeechActivity(source, time, quiet) => {
                        detector.speech_activity(source,time,quiet);
                        json!({"type":"speech.activity","source":source,"audioTimestampMs":time,"quiet":quiet})
                    }
                    InputEvent::Transcript(segment) => {
                        pending_partial = !segment.final_;
                        if segment.final_ && !segment.text.is_empty() { final_end = Some(segment.ended_at); }
                        detector.transcript(&segment);
                        json!({"type":"transcript","segment":segment})
                    }
                    InputEvent::Failure(error) => break Err(error),
                    _ => continue,
                };
                event_count += 1;
                record(output, json!({"type":"event","id":row.id,"observedAtMs":observed,"event":value}))?;
                let text = detector.classifier_text();
                if text != changed {
                    record(output,json!({"type":"candidate","id":row.id,"observedAtMs":observed,
                        "floor":detector.remote_turn_started_at,"text":text,"remoteQuiet":detector.remote_quiet,
                        "remoteSpeaking":detector.remote_speaking}))?;
                    changed = text;
                }
            }
        }
        if !feeding && !pending_partial && speech_end.is_some() && final_end.is_some() && detector.finalization_ready() {
            // Drain already queued events before closing the owned stream.
            if received.is_empty() { break Ok(()); }
        }
    };
    stream.stop();
    record(output,json!({"type":"utterance.finished","id":row.id,"complete":result.is_ok(),
        "eventCount":event_count,"lastSpeechEndMs":speech_end,"lastFinalEndMs":final_end,
        "lastRemoteActivityMs":detector.last_remote_activity(),"finalizedCurrentActivity":detector.finalization_ready(),
        "error":result.as_ref().err()}))?;
    result
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let manifest_path = PathBuf::from(args.next().ok_or("Supply manifest JSON and output JSONL")?).canonicalize()?;
    let output_path = PathBuf::from(args.next().ok_or("Supply a new output JSONL path")?);
    if args.next().is_some() { return Err("Only manifest and output arguments are accepted".into()); }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize()?;
    let parent = output_path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new(".")).canonicalize()?;
    if !parent.starts_with(&root) { return Err("Output must stay inside the workspace".into()); }
    let raw = fs::read(&manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(raw.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&raw))?;
    nemotron::right_context(manifest.chunk_ms)?;
    if manifest.utterances.is_empty() { return Err("Supply at least one utterance".into()); }
    let base = manifest_path.parent().unwrap();
    let runtime = resolve(base,&manifest.runtime)?;
    let model = resolve(base,&manifest.model)?;
    let mut ids = HashSet::new();
    let mut waves = Vec::new();
    for row in &manifest.utterances {
        if row.id.is_empty() || row.source_group.is_empty() || !ids.insert(&row.id) { return Err("Nonempty unique IDs and source groups are required".into()); }
        let wave = resolve(base,&row.wave)?;
        let bytes = fs::read(&wave)?;
        waves.push((wave,format!("{:x}",Sha256::digest(&bytes)),pcm(&bytes)?));
    }
    let mut output = OpenOptions::new().write(true).create_new(true).open(&output_path)?;
    record(&mut output,json!({"type":"capture.started","schemaVersion":2,
        "scope":"Offline ASR data, no answer or classifier inference. Real-time paced recorded PCM through production Nemotron and VAD; excludes WASAPI, microphone, monitor rendering, answer latency and full application-state parity. Context is caller-supplied previous conversation and never sent to ASR. No labels are inherited from future words.",
        "manifestSha256":format!("{:x}",Sha256::digest(&raw)),"runtimeSha256":sha(&runtime)?,"modelSha256":sha(&model)?,
        "collectorSha256":format!("{:x}",Sha256::digest(include_bytes!("capture-intent-asr.rs"))),
        "nemotronSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("../src/transcription/nemotron.rs"))),
        "vadSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("../src/transcription/vad.rs"))),
        "detectorSourceSha256":format!("{:x}",Sha256::digest(include_bytes!("../src/meeting/questions.rs"))),
        "chunkMs":manifest.chunk_ms,"audioFrameMs":10,"utteranceCount":manifest.utterances.len()}))?;
    let result = async {
        let cancel = CancellationToken::new();
        let devices = nemotron::devices(runtime.to_str().ok_or("Runtime path is not UTF-8")?,&cancel).await?;
        let device = nemotron::select_device(&devices,0,manifest.gpu_name.as_deref())?;
        record(&mut output,json!({"type":"device.selected","device":device}))?;
        let service = nemotron::Service::load(runtime.to_str().unwrap(),model.to_str().ok_or("Model path is not UTF-8")?,manifest.chunk_ms,device.index,&cancel).await?;
        for (row,(wave,hash,samples)) in manifest.utterances.iter().zip(waves) {
            record(&mut output,json!({"type":"utterance.started","id":row.id,"sourceGroup":row.source_group,
                "context":row.context,"wave":wave,"waveSha256":hash,"originalSamples":samples.len()}))?;
            capture(service.clone(),row,samples,&mut output).await?;
            println!("Captured {}",row.id);
        }
        Ok::<(),String>(())
    }.await;
    record(&mut output,json!({"type":"capture.finished","complete":result.is_ok(),"error":result.as_ref().err()}))?;
    result.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wave() -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec(); bytes.extend(38_u32.to_le_bytes()); bytes.extend(b"WAVEfmt ");
        bytes.extend(16_u32.to_le_bytes()); bytes.extend(1_u16.to_le_bytes()); bytes.extend(1_u16.to_le_bytes());
        bytes.extend(16000_u32.to_le_bytes()); bytes.extend(32000_u32.to_le_bytes());
        bytes.extend(2_u16.to_le_bytes()); bytes.extend(16_u16.to_le_bytes());
        bytes.extend(b"data"); bytes.extend(2_u32.to_le_bytes()); bytes.extend((-32768_i16).to_le_bytes()); bytes
    }
    #[test]
    fn capture_rejects_mislabeled_or_truncated_audio() {
        let bytes=wave(); assert_eq!(pcm(&bytes).unwrap(),vec![-1.]);
        for index in [20,22,24,28,32,34] { let mut invalid=bytes.clone(); invalid[index]^=1; assert!(pcm(&invalid).is_err()); }
        assert!(pcm(&bytes[..bytes.len()-1]).is_err());
        let mut invalid=bytes.clone(); invalid[40]=1; assert!(pcm(&invalid).is_err());
        let mut invalid=bytes.clone(); invalid.extend([0]); assert!(pcm(&invalid).is_err());
    }
}
