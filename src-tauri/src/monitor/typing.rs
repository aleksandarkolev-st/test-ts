//! Typing worker: a dedicated OS thread owns the keyboard bridge so a slow,
//! stuck, or retrying HID write can never block the meeting actor. The worker
//! connects lazily on the first typing request (so a keyboard plugged in later
//! still works), configures the firmware pace once per connection, and honors
//! an abort flag between chunks.
//!
//! If the bridge cannot be reached, the worker reports a failure and nothing is
//! typed — there is no SendInput fallback. Aborting also issues CLEAR so no
//! queued keystrokes remain in the firmware.
use crate::monitor::foreground::Foreground;
use crate::monitor::hid::{KeyboardBridge, SendOutcome};
use crate::monitor::protocol::{HumanSpec, TypingTimings};
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
        /// `Some` spreads the answer over a human performance budget.
        human: Option<HumanSpec>,
        /// The window the dispatch gate approved; typing stops when it is no
        /// longer foreground.
        target: Option<Foreground>,
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
    /// Stopped before the end; `started` is true once at least one byte had
    /// been accepted by the firmware, so a partial answer is never retyped.
    Aborted { generation: u64, started: bool },
    Failed { generation: u64, error: String },
}

pub struct Worker {
    commands: Sender<TypingCommand>,
    abort: Arc<AtomicBool>,
}
impl Worker {
    /// Queues `text` for typing. `human` turns the send into a paced
    /// performance; `target` is the window the gate approved, re-checked while
    /// chunks are in flight. Returns false when the worker has stopped.
    pub fn type_text(
        &self,
        text: String,
        timings: TypingTimings,
        generation: u64,
        human: Option<HumanSpec>,
        target: Option<Foreground>,
    ) -> bool {
        // The abort flag is intentionally left as it is: a superseding dispatch
        // sets it to cancel the send that is still in flight, and the worker
        // resets it when it starts this command.
        self.commands
            .send(TypingCommand::Type {
                text,
                timings,
                generation,
                human,
                target,
            })
            .is_ok()
    }
    /// Fast abort: the flag is checked between chunks by the worker in flight,
    /// and the command guarantees a CLEAR even for an idle worker.
    pub fn abort(&self) {
        self.abort.store(true, Ordering::Release);
        let _ = self.commands.send(TypingCommand::Abort);
    }
    /// Ends the worker after a best-effort CLEAR. The abort flag stops a send
    /// that is still in flight (a human performance can run for minutes), then
    /// the queued command clears the firmware. The thread is detached.
    pub fn shutdown(self) {
        self.abort.store(true, Ordering::Release);
        let _ = self.commands.send(TypingCommand::Shutdown);
    }
}

/// The bridge surface the worker needs, kept behind a trait so the command
/// loop is testable without HID hardware.
pub trait TypingBackend: Send {
    fn configure(&mut self, timings: TypingTimings) -> Result<(), String>;
    /// Sends one answer; `Err` is fatal, otherwise the send either completed
    /// or was asked to stop.
    fn send_text(
        &mut self,
        text: &str,
        human: Option<HumanSpec>,
        target: Option<&Foreground>,
        abort: &AtomicBool,
    ) -> Result<SendOutcome, String>;
    fn clear(&mut self);
    fn is_alive(&self) -> bool;
}
impl TypingBackend for KeyboardBridge {
    fn configure(&mut self, timings: TypingTimings) -> Result<(), String> {
        KeyboardBridge::configure(self, timings).map_err(|error| error.message())
    }
    fn send_text(
        &mut self,
        text: &str,
        human: Option<HumanSpec>,
        target: Option<&Foreground>,
        abort: &AtomicBool,
    ) -> Result<SendOutcome, String> {
        let target = target.cloned();
        let should_abort =
            move || abort.load(Ordering::Acquire) || !focus_still_matches(target.as_ref());
        match human {
            Some(spec) => KeyboardBridge::send_text_human(self, text, spec, should_abort),
            None => KeyboardBridge::send_text_checked(self, text, should_abort),
        }
        .map_err(|error| error.message())
    }
    fn clear(&mut self) {
        let _ = KeyboardBridge::clear(self);
    }
    fn is_alive(&self) -> bool {
        KeyboardBridge::is_alive(self)
    }
}

/// True while the foreground window still matches the typing target given by
/// the dispatch gate. With no target the answer types unchecked; the monitor
/// flow always passes one, so focus that drifts mid-send aborts instead of
/// typing into whatever window came forward.
fn focus_still_matches(target: Option<&Foreground>) -> bool {
    let Some(target) = target else {
        return true;
    };
    matches!(
        crate::monitor::foreground::current(),
        Some(foreground)
            if foreground.window == target.window && foreground.executable == target.executable
    )
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
                human,
                target,
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
                worker_trace!(
                    "sending {} chars{}",
                    text.chars().count(),
                    if human.is_some() {
                        " as a human performance"
                    } else {
                        ""
                    }
                );
                match bridge.send_text(&text, human, target.as_ref(), &abort) {
                    Ok(SendOutcome::Completed) => {
                        worker_trace!("send finished");
                        report(TypingOutcome::Finished { generation });
                    }
                    Ok(SendOutcome::Aborted { sent_bytes }) => {
                        worker_trace!("send aborted after {sent_bytes} bytes");
                        bridge.clear();
                        report(TypingOutcome::Aborted {
                            generation,
                            started: sent_bytes > 0,
                        });
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
        fn send_text(
            &mut self,
            text: &str,
            human: Option<HumanSpec>,
            _target: Option<&Foreground>,
            abort: &AtomicBool,
        ) -> Result<SendOutcome, String> {
            if self.wait_for_abort {
                for _ in 0..500 {
                    if abort.load(Ordering::Acquire) {
                        return Ok(SendOutcome::Aborted { sent_bytes: 0 });
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            match human {
                Some(spec) => self
                    .log
                    .lock()
                    .unwrap()
                    .push(format!("send {text} human={}ms", spec.target_ms)),
                None => self.log.lock().unwrap().push(format!("send {text}")),
            }
            Ok(SendOutcome::Completed)
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
        assert!(worker.type_text("hello".into(), TypingTimings::default(), 1, None, None));
        assert!(worker.type_text("again".into(), TypingTimings::default(), 2, None, None));
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
        assert!(worker.type_text("long answer".into(), TypingTimings::default(), 7, None, None));
        std::thread::sleep(Duration::from_millis(40));
        worker.abort();
        assert_eq!(
            outcomes.recv_timeout(Duration::from_secs(5)).unwrap(),
            TypingOutcome::Aborted {
                generation: 7,
                started: false
            }
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
        assert!(worker.type_text("hello".into(), TypingTimings::default(), 3, None, None));
        assert_eq!(
            outcomes.recv_timeout(Duration::from_secs(5)).unwrap(),
            TypingOutcome::Failed {
                generation: 3,
                error: "No keyboard firmware connected".into()
            }
        );
        worker.shutdown();
    }

    #[test]
    fn human_spec_reaches_the_backend() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (worker, outcomes) = worker(log.clone(), false);
        let spec = HumanSpec {
            target_ms: 2_000,
            per_byte_ms: 26,
            seed: 1,
        };
        assert!(worker.type_text(
            "hello".into(),
            TypingTimings::default(),
            4,
            Some(spec),
            None
        ));
        assert_eq!(
            outcomes.recv_timeout(Duration::from_secs(5)).unwrap(),
            TypingOutcome::Finished { generation: 4 }
        );
        worker.shutdown();
        assert!(log
            .lock()
            .unwrap()
            .contains(&"send hello human=2000ms".into()));
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
        assert!(worker.type_text("abc 123".into(), TypingTimings::default(), 1, None, None));
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

    /// One-off hardware validation with a full LeetCode answer: types a Two Sum
    /// solution into the focused editor and watches the compensation plan
    /// (auto-indent, auto-closing brackets, Backspace/Delete) edit a real
    /// Monaco. The worker aborts if the foreground window stops being the
    /// probe, so a stray focus change cannot leak keystrokes. Run only with
    /// the Monaco probe window focused:
    ///
    /// `cargo test --lib -- --ignored --nocapture hardware_smoke_two_sum`
    #[test]
    #[ignore = "types on the real keyboard; requires the flashed GMMK 2 and the Monaco probe focused"]
    fn hardware_smoke_two_sum_on_the_monaco_probe() {
        const SAMPLE: &str = "#include <vector>\n#include <unordered_map>\n\nclass Solution {\npublic:\n    std::vector<int> twoSum(std::vector<int>& nums, int target) {\n        std::unordered_map<int, int> seen;\n        for (int i = 0; i < (int)nums.size(); i++) {\n            int need = target - nums[i];\n            if (seen.count(need)) {\n                return {seen[need], i};\n            }\n            seen[nums[i]] = i;\n        }\n        return {};\n    }\n};\n";
        let target = Foreground {
            window: 723854,
            executable: "firefox.exe".into(),
        };
        let (report, outcomes) = mpsc::channel();
        let worker = spawn(move |outcome| {
            let _ = report.send(outcome);
        });
        assert!(worker.type_text(
            SAMPLE.into(),
            TypingTimings::default(),
            1,
            None,
            Some(target)
        ));
        match outcomes.recv_timeout(Duration::from_secs(30)) {
            Ok(TypingOutcome::Finished { generation: 1 }) => {}
            Ok(other) => panic!("expected Finished for generation 1, got {other:?}"),
            Err(error) => panic!("no outcome within 30 s ({error:?}); the worker is stuck"),
        }
        // The firmware types the acknowledged bytes at ~26 ms per character;
        // without this pause the shutdown CLEAR would truncate the answer.
        std::thread::sleep(Duration::from_millis(SAMPLE.len() as u64 * 26 + 5_000));
        worker.shutdown();
    }

    /// Hardware validation of the human pacing: the same Two Sum answer spread
    /// over a two-minute budget through the real keyboard, with the same focus
    /// guard as the fast run.
    #[test]
    #[ignore = "types on the real keyboard; requires the flashed GMMK 2 and the Monaco probe focused"]
    fn hardware_smoke_two_sum_as_a_human() {
        const SAMPLE: &str = "#include <vector>\n#include <unordered_map>\n\nclass Solution {\npublic:\n    std::vector<int> twoSum(std::vector<int>& nums, int target) {\n        std::unordered_map<int, int> seen;\n        for (int i = 0; i < (int)nums.size(); i++) {\n            int need = target - nums[i];\n            if (seen.count(need)) {\n                return {seen[need], i};\n            }\n            seen[nums[i]] = i;\n        }\n        return {};\n    }\n};\n";
        let target = Foreground {
            window: 723854,
            executable: "firefox.exe".into(),
        };
        let (report, outcomes) = mpsc::channel();
        let worker = spawn(move |outcome| {
            let _ = report.send(outcome);
        });
        let spec = HumanSpec {
            target_ms: 120_000,
            per_byte_ms: 26,
            seed: 7,
        };
        assert!(worker.type_text(
            SAMPLE.into(),
            TypingTimings::default(),
            2,
            Some(spec),
            Some(target)
        ));
        match outcomes.recv_timeout(Duration::from_secs(240)) {
            Ok(TypingOutcome::Finished { generation: 2 }) => {}
            Ok(other) => panic!("expected Finished for generation 2, got {other:?}"),
            Err(error) => panic!("no outcome within 240 s ({error:?}); the worker is stuck"),
        }
        std::thread::sleep(Duration::from_secs(4));
        worker.shutdown();
    }
}
