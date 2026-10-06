pub mod vad;
pub mod whisper;
use crate::{
    audio::AudioFrame,
    meeting::{InputEvent, SpeakerSource, TranscriptSegment},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::JoinHandle,
};
use tokio::sync::mpsc;
use vad::{Vad, VadEvent};
struct Job {
    samples: Vec<f32>,
    started: u64,
    ended: u64,
    final_: bool,
    preview: bool,
    id: String,
    queued_at: std::time::Instant,
    superseded: Arc<AtomicBool>,
}
struct Preview {
    job: Job,
    text: String,
}
impl Preview {
    fn matches(&self, final_job: &Job) -> bool {
        final_job.final_
            && self.job.id == final_job.id
            && self.job.started == final_job.started
            && self.job.ended == final_job.ended
            && self.job.samples.len() == final_job.samples.len()
            && self
                .job
                .samples
                .iter()
                .zip(&final_job.samples)
                .all(|(a, b)| a.to_bits() == b.to_bits())
    }
}
fn transcribe_job(
    job: Job,
    preview: &mut Option<Preview>,
    stopping: &AtomicBool,
    infer: impl FnOnce(&[f32]) -> Result<String, String>,
) -> Option<(Job, Result<String, String>, bool)> {
    let cached = if job.final_ {
        preview.take().filter(|p| p.matches(&job)).map(|p| p.text)
    } else {
        None
    };
    let reused = cached.is_some();
    let result = cached.map(Ok).unwrap_or_else(|| infer(&job.samples));
    if job.preview {
        // Speculative text never reaches context, detection, UI or the cloud.
        // A mismatch or failure uses normal final STT.
        if let Ok(text) = result {
            if !stopping.load(Ordering::Acquire) {
                *preview = Some(Preview { job, text });
            }
        }
        None
    } else {
        Some((job, result, reused))
    }
}
// Partial updates are replaceable. A queued partial must never prevent the
// final transcript from being accepted, especially during long utterances.
#[derive(Default)]
struct Jobs {
    pending: Mutex<std::collections::VecDeque<Job>>,
    running_partial: Mutex<Option<Arc<AtomicBool>>>,
    ready: Condvar,
}
impl Jobs {
    fn interrupt_partial(&self) {
        if let Some(flag) = self.running_partial.lock().unwrap().as_ref() {
            flag.store(true, Ordering::Release);
        }
    }
    fn push(&self, job: Job) -> Result<(), ()> {
        let mut pending = self.pending.lock().unwrap();
        if job.final_ {
            pending.retain(|old| old.final_ || old.id != job.id);
            if pending.len() >= 4 {
                pending.retain(|old| old.final_);
            }
            if pending.len() >= 4 {
                return Err(());
            }
        } else {
            pending.retain(|old| old.final_);
            if pending.len() >= 4 {
                return Ok(());
            }
        }
        if job.final_ || job.preview {
            // Free the worker from obsolete partial output. A final or a
            // prospective final is never canceled by this queue policy.
            self.interrupt_partial();
        }
        pending.push_back(job);
        self.ready.notify_one();
        Ok(())
    }
    fn next(&self) -> Option<Job> {
        let pending = self.pending.lock().unwrap();
        let (mut pending, _) = self
            .ready
            .wait_timeout_while(pending, std::time::Duration::from_millis(100), |q| {
                q.is_empty()
            })
            .unwrap();
        let job = pending.pop_front();
        *self.running_partial.lock().unwrap() = job
            .as_ref()
            .filter(|job| !job.final_ && !job.preview)
            .map(|job| job.superseded.clone());
        job
    }
}
pub struct Transcription {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
    pump: tauri::async_runtime::JoinHandle<()>,
}
impl Transcription {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.pump.abort();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}
impl Drop for Transcription {
    fn drop(&mut self) {
        self.stop();
    }
}
pub fn start(
    ctx: Arc<whisper_rs::WhisperContext>,
    mut frames: mpsc::Receiver<AudioFrame>,
    events: mpsc::Sender<InputEvent>,
    levels: Arc<std::sync::Mutex<(f32, f32)>>,
) -> Result<Transcription, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = vec![];
    let mut queues = vec![];
    for source in [SpeakerSource::Remote, SpeakerSource::Self_] {
        let mut state = ctx.create_state().map_err(|e| e.to_string())?;
        let jobs = Arc::new(Jobs::default());
        queues.push(jobs.clone());
        let ev = events.clone();
        let stopping = stop.clone();
        threads.push(std::thread::spawn(move || {
            let mut preview: Option<Preview> = None;
            while !stopping.load(Ordering::Acquire) {
                let job = match jobs.next() {
                    Some(j) => j,
                    None => continue,
                };
                if stopping.load(Ordering::Acquire) {
                    break;
                }
                let started = std::time::Instant::now();
                let queue_wait = job.queued_at.elapsed().as_millis() as u64;
                let is_preview = job.preview;
                let log_timing = is_preview || job.final_;
                let superseded = job.superseded.clone();
                let outcome = transcribe_job(job, &mut preview, &stopping, |samples| {
                        whisper::transcribe_interruptible(&mut state, samples, Some(&stopping), Some(&superseded))
                    });
                if log_timing && !stopping.load(Ordering::Acquire) {
                    eprintln!(
                        "local_stt {}",
                        serde_json::json!({
                            "source": source,
                            "kind": if is_preview { "preview" } else { "final" },
                            "preview_reused": outcome.as_ref().is_some_and(|(_, _, reused)| *reused),
                            "queue_wait_ms": queue_wait,
                            "inference_ms": started.elapsed().as_millis() as u64,
                        })
                    );
                }
                let Some((job, result, _)) = outcome else { continue; };
                if superseded.load(Ordering::Acquire) { continue; }
                match result {
                    Ok(text) if (job.final_ || !text.is_empty()) && !stopping.load(Ordering::Acquire) => {
                        if ev
                            .try_send(InputEvent::Transcript(TranscriptSegment {
                                id: job.id,
                                source,
                                text,
                                started_at: job.started,
                                ended_at: job.ended,
                                final_: job.final_,
                            }))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(e) if !stopping.load(Ordering::Acquire) => {
                        let _ = ev.try_send(InputEvent::Failure(e));
                        break;
                    }
                    _ => {}
                }
            }
        }));
    }
    let stopping = stop.clone();
    let pump = tauri::async_runtime::spawn(async move {
        let mut vads = [Vad::default(), Vad::default()];
        while let Some(frame) = frames.recv().await {
            if stopping.load(Ordering::Acquire) {
                break;
            }
            let i = if frame.source == SpeakerSource::Remote {
                0
            } else {
                1
            };
            let rms = if frame.samples.is_empty() {
                0.
            } else {
                (frame.samples.iter().map(|s| s * s).sum::<f32>() / frame.samples.len() as f32)
                    .sqrt()
            };
            {
                let mut l = levels.lock().unwrap();
                if i == 0 {
                    l.0 = rms
                } else {
                    l.1 = rms
                }
            }
            for event in vads[i].process(&frame.samples, frame.timestamp_ms) {
                match event {
                    VadEvent::Started(t) => {
                        let _ = events
                            .send(InputEvent::SpeechStarted(frame.source, t))
                            .await;
                    }
                    VadEvent::Ended(t) => {
                        let _ = events.send(InputEvent::SpeechEnded(frame.source, t)).await;
                    }
                    VadEvent::Preview { .. } if frame.source == SpeakerSource::Self_ => {}
                    VadEvent::Preview {
                        samples,
                        started,
                        ended,
                    } => {
                        // Optional work is replaceable and must not occupy
                        // capacity reserved for final transcripts.
                        let _ = queues[i].push(Job {
                            samples,
                            started,
                            ended,
                            final_: false,
                            preview: true,
                            id: format!("{:?}-{started}", frame.source),
                            queued_at: std::time::Instant::now(),
                            superseded: Arc::new(AtomicBool::new(false)),
                        });
                    }
                    VadEvent::Chunk {
                        samples,
                        started,
                        ended,
                        final_,
                    } => {
                        let job = Job {
                            samples,
                            started,
                            ended,
                            final_,
                            preview: false,
                            id: format!("{:?}-{started}", frame.source),
                            queued_at: std::time::Instant::now(),
                            superseded: Arc::new(AtomicBool::new(false)),
                        };
                        if queues[i].push(job).is_err() && final_ {
                            let _ = events
                                .send(InputEvent::Failure(
                                    "Local transcription cannot keep up with audio".into(),
                                ))
                                .await;
                            return;
                        }
                    }
                }
            }
        }
    });
    Ok(Transcription {
        stop,
        threads,
        pump,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(id: &str, final_: bool) -> Job {
        Job {
            samples: vec![],
            started: 0,
            ended: 0,
            final_,
            preview: false,
            id: id.into(),
            queued_at: std::time::Instant::now(),
            superseded: Arc::new(AtomicBool::new(false)),
        }
    }
    #[test]
    fn coalesces_partial_updates_and_prioritizes_final_transcripts() {
        let jobs = Jobs::default();
        for _ in 0..100 {
            jobs.push(job("long", false)).unwrap();
        }
        assert_eq!(jobs.pending.lock().unwrap().len(), 1);
        jobs.push(job("long", true)).unwrap();
        assert!(jobs.next().unwrap().final_);
        for id in ["a", "b", "c"] {
            jobs.push(job(id, true)).unwrap();
        }
        jobs.push(job("d", false)).unwrap();
        jobs.push(job("d", true)).unwrap();
        assert_eq!(jobs.pending.lock().unwrap().len(), 4);
        assert!(jobs.push(job("e", true)).is_err());
        for id in ["a", "b", "c", "d"] {
            let next = jobs.next().unwrap();
            assert!(next.final_);
            assert_eq!(next.id, id);
        }
    }
    #[test]
    fn preview_reuse_requires_identical_final_audio_and_utterance() {
        let mut predicted = job("remote-0", false);
        predicted.preview = true;
        predicted.ended = 100;
        predicted.samples = vec![0.1, 0.0];
        let preview = Preview {
            job: predicted,
            text: "Synthetic question?".into(),
        };
        let mut final_job = job("remote-0", true);
        final_job.ended = 100;
        final_job.samples = vec![0.1, 0.0];
        assert!(preview.matches(&final_job));
        final_job.samples[1] = 0.001; // Quiet real audio still invalidates reuse.
        assert!(!preview.matches(&final_job));
        final_job.samples[1] = -0.0; // Match the actual PCM bits, not an estimate.
        assert!(!preview.matches(&final_job));
        final_job.samples[1] = 0.0;
        final_job.id = "self-0".into();
        assert!(!preview.matches(&final_job));
        final_job.id = "remote-0".into();
        final_job.ended += 30;
        assert!(!preview.matches(&final_job));
        final_job.ended = 100;
        final_job.final_ = false;
        assert!(!preview.matches(&final_job));
    }
    #[test]
    fn preview_interrupts_obsolete_partial_but_final_preserves_running_preview() {
        let jobs = Jobs::default();
        jobs.push(job("remote-0", false)).unwrap();
        let partial = jobs.next().unwrap();
        assert!(!partial.superseded.load(Ordering::Acquire));
        jobs.push(preview_job()).unwrap();
        assert!(partial.superseded.load(Ordering::Acquire));
        let preview = jobs.next().unwrap();
        jobs.push(final_job()).unwrap();
        assert!(!preview.superseded.load(Ordering::Acquire));
        let final_job = jobs.next().unwrap();
        jobs.push(job("remote-1", false)).unwrap();
        assert!(!final_job.superseded.load(Ordering::Acquire));
    }
    fn preview_job() -> Job {
        let mut job = job("remote-0", false);
        job.samples = vec![0.1, 0.];
        job.preview = true;
        job
    }
    fn final_job() -> Job {
        let mut job = preview_job();
        job.preview = false;
        job.final_ = true;
        job
    }
    #[test]
    fn preview_emits_nothing_until_matching_final_and_skips_second_inference() {
        let stop = AtomicBool::new(false);
        let mut cache = None;
        assert!(transcribe_job(preview_job(), &mut cache, &stop, |_| Ok(
            "Synthetic question?".into()
        ))
        .is_none());
        let (job, result, reused) = transcribe_job(final_job(), &mut cache, &stop, |_| {
            panic!("Matching final must reuse identical-input inference")
        })
        .unwrap();
        assert!(job.final_ && !job.preview);
        assert!(reused);
        assert_eq!(result.unwrap(), "Synthetic question?");
        assert!(cache.is_none());
    }
    #[test]
    fn changed_final_and_failed_preview_use_normal_inference() {
        let stop = AtomicBool::new(false);
        let mut cache = None;
        transcribe_job(preview_job(), &mut cache, &stop, |_| {
            Ok("Obsolete preview".into())
        });
        let mut changed = final_job();
        changed.samples.push(0.01);
        let (_, result, reused) =
            transcribe_job(changed, &mut cache, &stop, |_| Ok("Confirmed final".into())).unwrap();
        assert_eq!(result.unwrap(), "Confirmed final");
        assert!(!reused);
        assert!(cache.is_none());
        assert!(transcribe_job(preview_job(), &mut cache, &stop, |_| Err(
            "Speculative failure".into()
        ))
        .is_none());
        assert!(cache.is_none());
        let (_, result, reused) = transcribe_job(final_job(), &mut cache, &stop, |_| {
            Err("Final failure".into())
        })
        .unwrap();
        assert_eq!(result.unwrap_err(), "Final failure");
        assert!(!reused);
    }
    #[test]
    fn stop_during_preview_does_not_preserve_its_text() {
        let stop = AtomicBool::new(false);
        let mut cache = None;
        assert!(transcribe_job(preview_job(), &mut cache, &stop, |_| {
            stop.store(true, Ordering::Release);
            Ok("Discard on Stop".into())
        })
        .is_none());
        assert!(cache.is_none());
    }
}
