pub mod resampler;
#[cfg(windows)]
mod windows_capture;
use crate::meeting::SpeakerSource;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::Instant,
};
use tokio::sync::mpsc;
#[derive(Clone, Debug, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub source: SpeakerSource,
    pub default: bool,
}
pub struct AudioFrame {
    pub source: SpeakerSource,
    pub samples: Vec<f32>,
    pub timestamp_ms: u64,
}
pub struct Capture {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}
impl Capture {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}
#[cfg(windows)]
pub fn devices() -> Result<Vec<AudioDevice>, String> {
    windows_capture::devices()
}
#[cfg(not(windows))]
pub fn devices() -> Result<Vec<AudioDevice>, String> {
    Err("Meeting Copilot requires Windows 10/11".into())
}
#[cfg(windows)]
pub fn start(
    remote: String,
    mic: String,
    clock: Instant,
    frames: mpsc::Sender<AudioFrame>,
    events: mpsc::Sender<crate::meeting::InputEvent>,
) -> Result<Capture, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = vec![];
    for (id, source) in [(remote, SpeakerSource::Remote), (mic, SpeakerSource::Self_)] {
        let stopping = stop.clone();
        let tx = frames.clone();
        let errors = events.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            if let Err(e) = windows_capture::capture(&id, source, clock, &stopping, &tx, ready_tx) {
                let _ = errors.try_send(crate::meeting::InputEvent::Failure(e));
            }
        });
        threads.push(thread);
        if let Err(e) = ready_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Audio initialization timed out".to_string())
            .and_then(|r| r)
        {
            let mut c = Capture { stop, threads };
            c.stop();
            return Err(e);
        }
    }
    Ok(Capture { stop, threads })
}
#[cfg(not(windows))]
pub fn start(
    _: String,
    _: String,
    _: Instant,
    _: mpsc::Sender<AudioFrame>,
    _: mpsc::Sender<crate::meeting::InputEvent>,
) -> Result<Capture, String> {
    Err("Windows required".into())
}
