//! Typing worker: a dedicated OS thread owns the keyboard bridge so a slow,
//! stuck, or retrying HID write can never block the meeting actor. The worker
//! connects lazily on the first typing request (so a keyboard plugged in later
//! still works), configures the firmware pace once per connection, and honors
//! an abort flag between chunks.
//!
//! If the bridge cannot be reached, the worker reports a failure and nothing is
//! typed — there is no SendInput fallback. Aborting also issues CLEAR so no
//! queued keystrokes remain in the firmware.
use crate::monitor::hid::KeyboardBridge;
use crate::monitor::protocol::TypingTimings;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

/// Debug-build tracing for the typing worker; silent in release builds.
macro_rules! worker_trace {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("monitor: typing worker: {}", format_args!($($arg)*));
        }
    };
}

pub enum TypingCommand {
    Type {
        text: String,
        timings: TypingTimings,
        generation: u64,
    },
    /// Stops any typing immediately and drops the firmware queue, even when the
    /// worker is idle (a queued backlog can still be draining on the keyboard).
    Abort,
    Shutdown,
}

/// Reported exactly once per `Type` command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TypingOutcome {
    Finished { generation: u64 },
    Aborted { generation: u64 },
    Failed { generation: u64, error: String },
}

pub struct Worker {
    commands: Sender<TypingCommand>,
    abort: Arc<AtomicBool>,
}
impl Worker {
    /// Queues `text` for typing. Returns false when the worker has stopped.
    pub fn type_text(&self, text: String, timings: TypingTimings, generation: u64) -> bool {
        self.abort.store(false, Ordering::Release);
        self.commands
            .send(TypingCommand::Type {
                text,
                timings,
                generation,
            })
            .is_ok()
    }
    /// Fast abort: the flag is checked between chunks by the worker in flight,
    /// and the command guarantees a CLEAR even for an idle worker.
    pub fn abort(&self) {
        self.abort.store(true, Ordering::Release);
        let _ = self.commands.send(TypingCommand::Abort);
    }
    /// Ends the worker after a best-effort CLEAR. The thread is detached.
    pub fn shutdown(self) {
        let _ = self.commands.send(TypingCommand::Shutdown);
    }
}

/// The bridge surface the worker needs, kept behind a trait so the command
/// loop is testable without HID hardware.
pub trait TypingBackend: Send {
    fn configure(&mut self, timings: TypingTimings) -> Result<(), String>;
    /// Sends one answer: `Ok(true)` fully sent, `Ok(false)` aborted, `Err` fatal.
    fn send_text(&mut self, text: &str, abort: &AtomicBool) -> Result<bool, String>;
    fn clear(&mut self);
    fn is_alive(&self) -> bool;
}
impl TypingBackend for KeyboardBridge {
    fn configure(&mut self, timings: TypingTimings) -> Result<(), String> {
        KeyboardBridge::configure(self, timings).map_err(|error| error.message())
    }
    fn send_text(&mut self, text: &str, abort: &AtomicBool) -> Result<bool, String> {
        KeyboardBridge::send_text_checked(self, text, || abort.load(Ordering::Acquire))
            .map_err(|error| error.message())
    }
    fn clear(&mut self) {
        let _ = KeyboardBridge::clear(self);
    }
    fn is_alive(&self) -> bool {
        KeyboardBridge::is_alive(self)
    }
}

/// Spawns the worker thread. `report` is called from that thread for every
/// typed text; callers typically forward outcomes through a blocking channel.
pub fn spawn(report: impl Fn(TypingOutcome) + Send + 'static) -> Worker {
    spawn_with(
        || crate::monitor::hid::connect().map_err(|error| error.message()),
        report,
    )
}

fn spawn_with<B: TypingBackend + 'static>(
    connect: impl Fn() -> Result<B, String> + Send + 'static,
    report: impl Fn(TypingOutcome) + Send + 'static,
) -> Worker {
    let (commands, receiver) = mpsc::channel();
    let abort = Arc::new(AtomicBool::new(false));
    let worker_abort = abort.clone();
    let _ = std::thread::Builder::new()
        .name("keyboard-typing".into())
        .spawn(move || run(receiver, worker_abort, connect, report));
    Worker { commands, abort }
}

fn run<B: TypingBackend>(
    commands: Receiver<TypingCommand>,
    abort: Arc<AtomicBool>,
    connect: impl Fn() -> Result<B, String>,
    report: impl Fn(TypingOutcome),
) {
    let mut backend: Option<B> = None;
    let mut configured: Option<TypingTimings> = None;
    while let Ok(command) = commands.recv() {
        match command {
            TypingCommand::Type {
                text,
                timings,
                generation,
            } => {
                abort.store(false, Ordering::Release);
                if backend.is_none() {
                    worker_trace!("connecting to the keyboard bridge");
                    match connect() {
                        Ok(connected) => {
                            backend = Some(connected);
                            configured = None;
                        }
                        Err(error) => {
                            worker_trace!("connect failed: {error}");
                            report(TypingOutcome::Failed { generation, error });
                            continue;
                        }
                    }
                }
                let bridge = backend.as_mut().unwrap();
                if configured != Some(timings) {
                    worker_trace!("configuring press={} gap={}", timings.press_ms, timings.gap_ms);
                    if let Err(error) = bridge.configure(timings) {
                        worker_trace!("configure failed: {error}");
                        report(TypingOutcome::Failed { generation, error });
                        if !bridge.is_alive() {
                            backend = None;
                            configured = None;
                        }
                        continue;
                    }
                    configured = Some(timings);
                    worker_trace!("configured");
                }
                worker_trace!("sending {} chars", text.chars().count());
                match bridge.send_text(&text, &abort) {
                    Ok(true) => {
                        worker_trace!("send finished");
                        report(TypingOutcome::Finished { generation });
                    }
                    Ok(false) => {
                        worker_trace!("send aborted");
                        bridge.clear();
                        report(TypingOutcome::Aborted { generation });
                    }
                    Err(error) => {
                        worker_trace!("send failed: {error}");
                        report(TypingOutcome::Failed { generation, error });
                        if !bridge.is_alive() {
                            backend = None;
                            configured = None;
                        }
                    }
                }
            }
            TypingCommand::Abort => {
                abort.store(false, Ordering::Release);
                if let Some(bridge) = backend.as_mut() {
                    bridge.clear();
                }
            }
            TypingCommand::Shutdown => {
                if let Some(bridge) = backend.as_mut() {
                    bridge.clear();
                }
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    struct FakeBackend {
        log: Arc<Mutex<Vec<String>>>,
        wait_for_abort: bool,
    }
    impl TypingBackend for FakeBackend {
        fn configure(&mut self, timings: TypingTimings) -> Result<(), String> {
            self.log
                .lock()
                .unwrap()
                .push(format!("configure {} {}", timings.press_ms, timings.gap_ms));
            Ok(())
        }
        fn send_text(&mut self, text: &str, abort: &AtomicBool) -> Result<bool, String> {
            if self.wait_for_abort {
                for _ in 0..500 {
                    if abort.load(Ordering::Acquire) {
                        return Ok(false);
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            self.log.lock().unwrap().push(format!("send {text}"));
            Ok(true)
        }
        fn clear(&mut self) {
            self.log.lock().unwrap().push("clear".into());
        }
        fn is_alive(&self) -> bool {
            true
        }
    }

    fn worker(
        backend: Arc<Mutex<Vec<String>>>,
        wait_for_abort: bool,
    ) -> (Worker, Receiver<TypingOutcome>) {
        let (report, outcomes) = mpsc::channel();
        let worker = spawn_with(
            move || {
                Ok(FakeBackend {
                    log: backend.clone(),
                    wait_for_abort,
                })
            },
            move |outcome| {
                let _ = report.send(outcome);
            },
        );
        (worker, outcomes)
    }

    #[test]
    fn typing_configured_once_and_every_request_reports_finished() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (worker, outcomes) = worker(log.clone(), false);
        assert!(worker.type_text("hello".into(), TypingTimings::default(), 1));
        assert!(worker.type_text("again".into(), TypingTimings::default(), 2));
        assert_eq!(
            outcomes.recv_timeout(Duration::from_secs(5)).unwrap(),
            TypingOutcome::Finished { generation: 1 }
        );
        assert_eq!(
            outcomes.recv_timeout(Duration::from_secs(5)).unwrap(),
            TypingOutcome::Finished { generation: 2 }
        );
        worker.shutdown();
        let log = log.lock().unwrap().clone();
        assert_eq!(log.iter().filter(|line| line.starts_with("configure")).count(), 1);
        assert!(log.contains(&"send hello".into()));
        assert!(log.contains(&"send again".into()));
    }

    #[test]
    fn abort_stops_typing_and_clears_the_firmware_queue() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (worker, outcomes) = worker(log.clone(), true);
        assert!(worker.type_text("long answer".into(), TypingTimings::default(), 7));
        std::thread::sleep(Duration::from_millis(40));
        worker.abort();
        assert_eq!(
            outcomes.recv_timeout(Duration::from_secs(5)).unwrap(),
            TypingOutcome::Aborted { generation: 7 }
        );
        // The queued Abort command still clears the (now idle) bridge.
        for _ in 0..100 {
            if log.lock().unwrap().iter().any(|line| line == "clear") {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(log.lock().unwrap().contains(&"clear".into()));
    }

    #[test]
    fn missing_keyboard_fails_the_generation_without_typing() {
        let (report, outcomes) = mpsc::channel::<TypingOutcome>();
        let worker = spawn_with(
            || Err::<FakeBackend, String>("No keyboard firmware connected".into()),
            move |outcome| {
                let _ = report.send(outcome);
            },
        );
        assert!(worker.type_text("hello".into(), TypingTimings::default(), 3));
        assert_eq!(
            outcomes.recv_timeout(Duration::from_secs(5)).unwrap(),
            TypingOutcome::Failed {
                generation: 3,
                error: "No keyboard firmware connected".into()
            }
        );
        worker.shutdown();
    }

    /// Drives the real worker against the flashed keyboard over USB. The text is
    /// typed into whatever window is focused, so only run it with a scratch text
    /// field in front (e.g. the Notepad verification step in the README) and the
    /// GMMK 2 with the screen-typing firmware connected:
    ///
    /// `cargo test --lib -- --ignored --nocapture hardware_smoke`
    #[test]
    #[ignore = "types on the real keyboard; requires the flashed GMMK 2"]
    fn hardware_smoke_types_through_the_worker() {
        let (report, outcomes) = mpsc::channel();
        let worker = spawn(move |outcome| {
            let _ = report.send(outcome);
        });
        assert!(worker.type_text("abc 123".into(), TypingTimings::default(), 1));
        match outcomes.recv_timeout(Duration::from_secs(20)) {
            Ok(TypingOutcome::Finished { generation: 1 }) => {}
            Ok(other) => panic!("expected Finished for generation 1, got {other:?}"),
            Err(error) => panic!("no outcome within 20 s ({error:?}); the worker is stuck"),
        }
        // The firmware types the acknowledged bytes at ~26 ms per character;
        // without this pause the shutdown CLEAR would truncate the sentence.
        std::thread::sleep(Duration::from_secs(2));
        worker.shutdown();
    }
}
