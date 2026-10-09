//! Offline probe using the production VAD, including nonzero quiet frames.
//! No production endpoint or confirmation policy is changed by this example.
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{path::PathBuf,fs};

#[allow(dead_code)]
mod native_vad {
    include!("../src/transcription/vad.rs");
    pub fn cuts(samples:&[f32],quiet_frames:usize)->Vec<(u64,u64)> {
        let mut vad=Vad::default();let mut cuts=vec![];let mut last=None;
        for (i,frame) in samples.chunks(480).enumerate() {
            let events=vad.process(frame,i as u64*30);
            if quiet_frames==17 {
                for event in events{if let VadEvent::Ended(ended)=event{cuts.push((ended,(i as u64+1)*30));}}
            } else if vad.active&&vad.silent>=quiet_frames&&last!=Some(vad.last_voice) {
                cuts.push((vad.last_voice,(i as u64+1)*30));last=Some(vad.last_voice);
            }
        }
        cuts
    }
}
fn pcm(bytes:&[u8])->Result<Vec<f32>,String> {
    if bytes.len()<12||&bytes[..4]!=b"RIFF"||&bytes[8..12]!=b"WAVE"{return Err("Expected a RIFF WAVE file".into());}
    let mut cursor=12;let mut format=None;let mut data=None;
    while cursor+8<=bytes.len() {
        let size=u32::from_le_bytes(bytes[cursor+4..cursor+8].try_into().unwrap())as usize;
        let end=cursor.checked_add(8).and_then(|x|x.checked_add(size)).ok_or("Invalid wave chunk size")?;
        if end>bytes.len(){return Err("Truncated wave chunk".into());}
        let body=&bytes[cursor+8..end];
        match &bytes[cursor..cursor+4] {
            b"fmt " if body.len()>=16=>format=Some((u16::from_le_bytes(body[..2].try_into().unwrap()),u16::from_le_bytes(body[2..4].try_into().unwrap()),u32::from_le_bytes(body[4..8].try_into().unwrap()),u16::from_le_bytes(body[14..16].try_into().unwrap()))),
            b"data"=>data=Some(body),_=>{}
        }
        cursor=end+size%2;
    }
    if format!=Some((1,1,16000,16)){return Err("Probe requires mono PCM16 at 16 kHz".into());}
    let data=data.ok_or("Missing wave samples")?;if data.len()%2!=0{return Err("Incomplete PCM sample".into());}
    Ok(data.chunks_exact(2).map(|x|i16::from_le_bytes(x.try_into().unwrap())as f32/32768.).collect())
}
fn main()->Result<(),Box<dyn std::error::Error>> {
    let mut args=std::env::args().skip(1);let output=PathBuf::from(args.next().ok_or("Supply output JSON and wave files")?);
    let quiet_ms=std::env::var("COPILOT_TURN_PROBE_QUIET_MS").unwrap_or_else(|_|"150".into()).parse::<usize>()?;
    if ![150,300,510].contains(&quiet_ms){return Err("Probe quiet time must be 150, 300 or 510 ms".into());}
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize()?;
    let parent=output.parent().ok_or("Output needs a parent directory")?.canonicalize()?;
    if !parent.starts_with(&root){return Err("Output must stay in the workspace".into());}
    let mut rows:Vec<Value>=vec![];
    for argument in args {
        let path=PathBuf::from(argument).canonicalize()?;if !path.starts_with(&root){return Err("Wave files must stay in the workspace".into());}
        let bytes=fs::read(&path)?;let mut samples=pcm(&bytes)?;let original=samples.len();samples.extend(std::iter::repeat_n(0.,16000));
        let cuts=native_vad::cuts(&samples,quiet_ms/30);let last=cuts.last().map(|cut|cut.0);
        rows.push(json!({"wave":path.strip_prefix(&root)?,"sha256":format!("{:x}",Sha256::digest(&bytes)),"originalSamples":original,
            "cuts":cuts.into_iter().map(|(last_voice,available)|json!({"lastVoiceMs":last_voice,"availableAtMs":available,"complete":Some(last_voice)==last})).collect::<Vec<_>>() }));
    }
    if rows.is_empty(){return Err("Supply at least one wave file".into());}
    fs::write(output,serde_json::to_vec_pretty(&json!({"quietMs":quiet_ms,
        "vadSha256":format!("{:x}",Sha256::digest(include_bytes!("../src/transcription/vad.rs"))),
        "probeSha256":format!("{:x}",Sha256::digest(include_bytes!("turn-candidates.rs"))),
        "scope":"Offline recorded synthetic interviewer questions; production VAD quiet-state probe. Each whole file is one question, so earlier pauses are continuation labels. Future audio is used only for labels, never inference. Excludes live capture, ASR and answer service.","rows":rows}))?)?;
    Ok(())
}
