use meeting_copilot_core::{
    audio::resampler::Resampler,
    transcription::{
        vad::{Vad, VadEvent},
        whisper,
    },
};
#[test]
#[ignore = "Requires the bundled local model"]
fn stop_interrupts_whisper_inference() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let ctx = whisper::load(root.join("models/ggml-tiny.en.bin").to_str().unwrap()).unwrap();
    let mut state = ctx.create_state().unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let trigger = stop.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        trigger.store(true, std::sync::atomic::Ordering::Release);
    });
    let samples: Vec<f32> = (0..16000 * 15)
        .map(|i| (i as f32 * 0.04).sin() * 0.15)
        .collect();
    let started = std::time::Instant::now();
    assert!(whisper::transcribe_cancellable(&mut state, &samples, Some(&stop)).is_err());
    thread.join().unwrap();
    assert!(
        started.elapsed().as_millis() < 1000,
        "Whisper did not stop promptly"
    );
}

#[test]
#[ignore = "Requires the bundled local model"]
fn superseded_partial_interrupts_without_stopping_meeting() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let ctx = whisper::load(root.join("models/ggml-tiny.en.bin").to_str().unwrap()).unwrap();
    let mut state = ctx.create_state().unwrap();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let superseded = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let trigger = superseded.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        trigger.store(true, std::sync::atomic::Ordering::Release);
    });
    let samples: Vec<f32> = (0..16000 * 15)
        .map(|i| (i as f32 * 0.04).sin() * 0.15)
        .collect();
    let started = std::time::Instant::now();
    assert!(whisper::transcribe_interruptible(
        &mut state,
        &samples,
        Some(&stop),
        Some(&superseded)
    )
    .is_err());
    thread.join().unwrap();
    assert!(
        started.elapsed().as_millis() < 1000,
        "Obsolete partial did not yield promptly"
    );
    assert!(!stop.load(std::sync::atomic::Ordering::Acquire));
    assert!(whisper::transcribe_cancellable(&mut state, &vec![0.; 16000], Some(&stop)).is_ok());
}
#[test]
#[ignore = "Requires downloaded Whisper model and scripts/create-audio-fixture.ps1"]
fn local_speech_fixture_transcribes_and_detects_question() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let wav = std::fs::read(root.join(".local/audio/remote-question.wav")).unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    let mut offset = 12;
    let mut samples = vec![];
    let mut rate = 0;
    let mut channels = 0;
    while offset + 8 <= wav.len() {
        let n = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let data = &wav[offset + 8..offset + 8 + n];
        if &wav[offset..offset + 4] == b"fmt " {
            assert_eq!(u16::from_le_bytes(data[..2].try_into().unwrap()), 1);
            channels = u16::from_le_bytes(data[2..4].try_into().unwrap()) as usize;
            rate = u32::from_le_bytes(data[4..8].try_into().unwrap());
            assert_eq!(u16::from_le_bytes(data[14..16].try_into().unwrap()), 16);
        }
        if &wav[offset..offset + 4] == b"data" {
            samples = data
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes(b.try_into().unwrap()) as f32 / 32768.)
                .collect();
        }
        offset += 8 + n + (n % 2);
    }
    let mono = meeting_copilot_core::audio::resampler::downmix(&samples, channels);
    let normalized = Resampler::new(rate).process(&mono);
    let mut vad = Vad::default();
    let mut chunks = vec![];
    for (i, packet) in normalized.chunks(480).enumerate() {
        chunks.extend(vad.process(packet, i as u64 * 30));
    }
    chunks.extend(vad.process(&vec![0.; 16000], normalized.len() as u64 / 16));
    assert!(chunks.iter().any(|e| matches!(e, VadEvent::Started(_))));
    assert!(chunks.iter().any(|e| matches!(e, VadEvent::Ended(_))));
    let context = whisper::load(root.join("models/ggml-tiny.en.bin").to_str().unwrap()).unwrap();
    let mut state = context.create_state().unwrap();
    let mut text = String::new();
    let start = std::time::Instant::now();
    for event in chunks {
        if let VadEvent::Chunk {
            samples,
            final_: true,
            ..
        } = event
        {
            text.push_str(&whisper::transcribe(&mut state, &samples).unwrap());
        }
    }
    assert!(
        text.to_lowercase().contains("launch"),
        "Whisper did not recognize the fixture launch question"
    );
    assert!(
        meeting_copilot_core::meeting::questions::score(&text, false) >= 4,
        "Question punctuation/opening was not recognized"
    );
    println!(
        "Local fixture transcription: {} ms (audio never uploaded)",
        start.elapsed().as_millis()
    );
}
