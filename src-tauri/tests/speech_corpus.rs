use meeting_copilot_core::{
    meeting::questions::score,
    transcription::{
        vad::{Vad, VadEvent},
        whisper,
    },
};
use serde::Deserialize;
#[derive(Deserialize)]
struct Label {
    question: bool,
}
fn wav_samples(path: &std::path::Path) -> Vec<f32> {
    let wav = std::fs::read(path).unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    let mut offset = 12;
    while offset + 8 <= wav.len() {
        let n = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let data = &wav[offset + 8..offset + 8 + n];
        if &wav[offset..offset + 4] == b"fmt " {
            assert_eq!(u16::from_le_bytes(data[..2].try_into().unwrap()), 1);
            assert_eq!(u16::from_le_bytes(data[2..4].try_into().unwrap()), 1);
            assert_eq!(u32::from_le_bytes(data[4..8].try_into().unwrap()), 16000);
        }
        if &wav[offset..offset + 4] == b"data" {
            return data
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes(b.try_into().unwrap()) as f32 / 32768.)
                .collect();
        }
        offset += 8 + n + (n % 2);
    }
    panic!("Fixture has no PCM data")
}
#[test]
#[ignore = "Requires scripts/create-corpus.ps1 and the bundled local model"]
fn labelled_synthetic_speech_corpus() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let labels: Vec<Label> =
        serde_json::from_str(include_str!("../../tests/fixtures/utterances.json")).unwrap();
    let ctx = whisper::load(root.join("models/ggml-tiny.en.bin").to_str().unwrap()).unwrap();
    let mut state = ctx.create_state().unwrap();
    let (mut speech, mut questions, mut detected, mut false_triggers) = (0, 0, 0, 0);
    let mut times = vec![];
    let mut misses = vec![];
    for (i, label) in labels.iter().enumerate() {
        let mut samples = wav_samples(&root.join(format!(".local/audio/corpus/{i:03}.wav")));
        // Reproducible low-level room noise, with both clean and noisy clips.
        if i % 2 == 1 {
            let mut seed = 42u32;
            for s in &mut samples {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                *s += ((seed >> 8) as f32 / 16777216. - 0.5) * 0.004;
            }
        }
        let mut vad = Vad::default();
        let mut events = vec![];
        for (j, packet) in samples.chunks(480).enumerate() {
            events.extend(vad.process(packet, j as u64 * 30));
        }
        events.extend(vad.process(&vec![0.; 16000], samples.len() as u64 / 16));
        let heard = events.iter().any(|e| matches!(e, VadEvent::Started(_)));
        if heard {
            speech += 1;
        }
        let started = std::time::Instant::now();
        let mut text = String::new();
        for e in events {
            if let VadEvent::Chunk {
                samples,
                final_: true,
                ..
            } = e
            {
                text.push_str(&whisper::transcribe(&mut state, &samples).unwrap());
                text.push(' ');
            }
        }
        times.push(started.elapsed().as_millis() as u64);
        let candidate = score(text.trim(), false) >= 4;
        if label.question {
            questions += 1;
            if candidate {
                detected += 1;
            } else {
                misses.push(i);
            }
        } else if candidate {
            false_triggers += 1;
            misses.push(i);
        }
        // Recognized text is never printed or written into the evidence file.
    }
    times.sort();
    let result = serde_json::json!({"kind":"synthetic English corpus; not a human meeting accuracy certification","clips":labels.len(),"speechDetected":speech,"questionCount":questions,"questionsDetected":detected,"negativeFalseTriggers":false_triggers,"medianTranscriptionMs":times[times.len()/2],"mismatchedFixtureIndices":misses});
    std::fs::create_dir_all(root.join("artifacts/corpus")).unwrap();
    std::fs::write(
        root.join("artifacts/corpus/results.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
    println!("{result}");
    assert!(
        speech as f64 / labels.len() as f64 > 0.95,
        "Synthetic speech detection missed the target"
    );
    assert!(
        detected as f64 / questions as f64 > 0.85,
        "Synthetic basic question detection missed the target"
    );
    assert_eq!(
        false_triggers, 0,
        "A negative synthetic fixture triggered a question"
    );
}
