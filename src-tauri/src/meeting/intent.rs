//! Optional learned speculation gate. Never blocks finalized requests.
//! Classifier inputs are coalesced in a watch channel, not queued per frame.
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Existing,
    FinalOnly,
    Learned,
}
impl Mode {
    pub fn configured() -> Self {
        // Acceptance experiments stay out of release until held-out and audio
        // evidence support activation. No semantic hardcoded fallback is used.
        if !cfg!(debug_assertions) {
            return Self::Existing;
        }
        match std::env::var("COPILOT_INTENT_MODE").as_deref() {
            Ok("early") => Self::Learned,
            Ok("final") => Self::FinalOnly,
            _ => Self::Existing,
        }
    }
}
/// Experimental control policy, never a semantic phrase or domain rule.
/// Invalid configuration disables early sending; final inference still runs.
pub fn ready_threshold() -> Option<f64> {
    if !cfg!(debug_assertions) {return Some(0.9);}
    match std::env::var("COPILOT_INTENT_READY_THRESHOLD") {
        Err(std::env::VarError::NotPresent)=>Some(0.9),
        Ok(value)=>value.parse::<f64>().ok().filter(|value|value.is_finite()&&(0.0..=1.0).contains(value)),
        _=>None,
    }
}
/// Suppression requires separate precision evidence. Readiness improvements
/// alone must not silently discard finalized requests.
pub fn background_enabled()->bool {
    cfg!(debug_assertions)&&std::env::var("COPILOT_INTENT_BACKGROUND_IGNORE").as_deref()==Ok("1")
}
pub fn settled_update_enabled()->bool {
    cfg!(all(feature="acceptance",debug_assertions))&&std::env::var("COPILOT_SETTLED_UPDATE").as_deref()==Ok("1")
}
pub fn quiet_priority_enabled()->bool {
    cfg!(all(feature="acceptance",debug_assertions))&&std::env::var("COPILOT_INTENT_QUIET_PRIORITY").as_deref()==Ok("1")
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Input {
    pub id: u64,
    pub floor: u64,
    pub text: String,
    pub context: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Scores {
    pub request: f64,
    pub ready: f64,
    pub background: Option<f64>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prediction {
    pub id: u64,
    #[serde(default)]
    pub abstained: bool,
    pub scores: Option<Scores>,
    pub elapsed_ms: Option<f64>,
}
#[derive(Default)]
pub struct Gate {
    latest: Option<Input>,
    sequence: u64,
    changed_at: u64,
    sent_at: Option<u64>,
    sent_id: Option<u64>,
    prediction: Option<Prediction>,
    spent_floor: Option<u64>,
    spent_stop: Option<(u64,u64)>,
    quiet_priority_spent: bool,
    last_submission_prioritized: bool,
}
impl Gate {
    pub fn matches(&self, floor: u64, text: &str, context: &str) -> bool {
        self.latest.as_ref().is_some_and(|input| {
            input.floor == floor && input.text == text && input.context == context
        })
    }
    pub fn observe(&mut self, floor: u64, text: String, context: String, now: u64) {
        if self.latest.as_ref().is_some_and(|input| {
            input.floor == floor && input.text == text && input.context == context
        }) {
            return;
        }
        self.sequence += 1;
        self.latest = Some(Input {
            id: self.sequence,
            floor,
            text,
            context,
        });
        self.changed_at = now;
        self.prediction = None;
    }
    pub fn invalidate(&mut self) {
        self.sequence += 1;
        self.latest = None;
        self.prediction = None;
        self.quiet_priority_spent = false;
    }
    pub fn request(&mut self, now: u64) -> Option<Input> {
        self.request_with_quiet(now,false,false)
    }
    /// One stable-text cadence bypass per acoustic pause, not per ASR update.
    /// Only classification is expedited; early generation still needs an exact
    /// accepted prediction, stability, silence and the ordinary readiness gate.
    pub fn request_with_quiet(&mut self,now:u64,quiet:bool,priority_enabled:bool)->Option<Input> {
        if !quiet {self.quiet_priority_spent=false;}
        let input = self.latest.as_ref()?;
        if self.sent_id == Some(input.id) {return None;}
        let before_cadence=self.sent_at.is_some_and(|at|now.saturating_sub(at)<250);
        let prioritized=before_cadence&&priority_enabled&&quiet&&!self.quiet_priority_spent
            &&now.saturating_sub(self.changed_at)>=100;
        if before_cadence&&!prioritized{return None;}
        if prioritized {self.quiet_priority_spent=true;}
        self.last_submission_prioritized=prioritized;
        self.sent_id = Some(input.id);
        self.sent_at = Some(now);
        Some(input.clone())
    }
    pub fn last_submission_prioritized(&self)->bool {self.last_submission_prioritized}
    pub fn accept(&mut self, prediction: Prediction) -> bool {
        if self
            .latest
            .as_ref()
            .is_none_or(|input| input.id != prediction.id)
        {
            return false;
        }
        self.prediction = Some(prediction);
        true
    }
    /// Use an already available, exact-input prediction. Unknown or changed
    /// final text falls through to Luna immediately, without a classifier wait.
    pub fn background(&self, floor: u64, text: &str, context: &str, threshold: f64) -> bool {
        if !self.matches(floor, text, context)
            || !threshold.is_finite()
            || !(0.0..=1.0).contains(&threshold)
        {
            return false;
        }
        let Some(prediction) = self.prediction.as_ref() else {
            return false;
        };
        if prediction.abstained
            || self
                .latest
                .as_ref()
                .is_none_or(|input| input.id != prediction.id)
        {
            return false;
        }
        let Some(scores) = prediction.scores.as_ref() else {
            return false;
        };
        scores.background.is_some_and(|background| {
            background.is_finite() && background >= threshold && background <= 1.
        }) && scores.request.is_finite()
            && (0.0..=1. - threshold + 1e-6).contains(&scores.request)
            && scores.ready.is_finite()
            && (0.0..=1. - threshold + 1e-6).contains(&scores.ready)
    }
    pub fn early(
        &mut self,
        now: u64,
        quiet: bool,
        self_speaking: bool,
        threshold: f64,
    ) -> Option<Input> {
        let input=self.ready_input(now,quiet,self_speaking,threshold)?;
        if self.spent_floor==Some(input.floor){return None;}
        self.spent_floor=Some(input.floor);
        Some(input)
    }
    /// An exact available prediction may also authorize a coalesced update to
    /// existing work. It never authorizes another speculative job on this floor.
    pub fn ready_input(&self,now:u64,quiet:bool,self_speaking:bool,threshold:f64)->Option<Input> {
        let input = self.latest.as_ref()?;
        if !quiet
            || self_speaking
            || now.saturating_sub(self.changed_at) < 100
        {
            return None;
        }
        let prediction = self.prediction.as_ref()?;
        let scores = prediction.scores.as_ref()?;
        if prediction.abstained
            || prediction.id != input.id
            || !threshold.is_finite()
            || !(0.0..=1.0).contains(&threshold)
            || !scores.request.is_finite()
            || !scores.ready.is_finite()
            || scores.request < threshold
            || scores.ready < threshold
            || scores.request > 1.0
            || scores.ready > 1.0
        {
            return None;
        }
        Some(input.clone())
    }
    /// Availability only: this is not an intent or completeness prediction.
    /// Used solely to update existing hidden work after acoustic speech end.
    pub fn settled_input(&self,now:u64,stopped:u64,quiet:bool,self_speaking:bool)->Option<Input> {
        let input=self.latest.as_ref()?;
        if !quiet||self_speaking||input.floor>stopped||now<stopped
            ||now.saturating_sub(self.changed_at)<100||self.spent_stop==Some((input.floor,stopped)){return None;}
        Some(input.clone())
    }
    pub fn mark_settled_update(&mut self,floor:u64,stopped:u64){self.spent_stop=Some((floor,stopped));}
}

struct Worker {
    child: Child,
    #[cfg(windows)]
    _job: crate::process::ProcessJob,
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub struct Classifier {
    input: tokio::sync::watch::Sender<Option<Input>>,
    result: mpsc::Receiver<Prediction>,
    stop: Arc<AtomicBool>,
    status: mpsc::Receiver<&'static str>,
}
fn selected_profile(root:&std::path::Path,override_path:Option<std::ffi::OsString>)->Result<std::path::PathBuf,&'static str> {
    let models=root.join(".local/intent-encoder").canonicalize().map_err(|_|"invalid_profile")?;
    let selected=override_path.map(|path|root.join(path)).unwrap_or_else(||models.join("profile.json"));
    let selected=selected.canonicalize().map_err(|_|"invalid_profile")?;
    if !selected.starts_with(&models)||!selected.is_file(){return Err("invalid_profile");}
    Ok(selected)
}
impl Classifier {
    pub fn start() -> Self {
        let (input, mut pending) = tokio::sync::watch::channel::<Option<Input>>(None);
        let (output, result) = mpsc::sync_channel(4);
        let (status_tx, status) = mpsc::sync_channel(4);
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = stop.clone();
        std::thread::spawn(move || {
            let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
            // Isolated acceptance probes may choose a verified profile without
            // replacing the user's default file. Release always uses the default.
            let override_path=if cfg!(all(feature="acceptance",debug_assertions)) {
                std::env::var_os("COPILOT_INTENT_PROFILE")
            }else{None};
            let profile=match selected_profile(&root,override_path) {
                Ok(profile)=>profile,
                Err(error)=>{let _=status_tx.try_send(error);return;}
            };
            let mut command = Command::new(root.join(".local/gaze-runtime/Scripts/python.exe"));
            command
                .arg(root.join("scripts/intent-encoder-worker.py"))
                .arg("--models")
                .arg(root.join(".local/intent-encoder"))
                .arg("--profile")
                .arg(profile)
                .env("PYTHONPATH", root.join(".local/intent-deps"))
                .env("PYTHONUNBUFFERED", "1")
                .env("PYTHONUTF8", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let Ok(mut child) = command.spawn() else {
                let _ = status_tx.try_send("runtime_start_failed");
                return;
            };
            #[cfg(windows)]
            let job = match crate::process::ProcessJob::attach(&child) {
                Ok(job) => job,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            };
            let Some(stdout) = child.stdout.take() else {
                let _ = child.kill();
                let _ = child.wait();
                return;
            };
            let mut worker = Worker {
                child,
                #[cfg(windows)]
                _job: job,
            };
            let (lines, reader) = mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let mut stream = BufReader::new(stdout);
                loop {
                    let mut line = String::new();
                    match stream.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        _ => {}
                    }
                    if line.len() > 64000 {
                        break;
                    }
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                        break;
                    };
                    if lines.send(value).is_err() {
                        break;
                    }
                }
            });
            let receive = |timeout: Duration| {
                let started = std::time::Instant::now();
                while started.elapsed() < timeout && !cancelled.load(Ordering::Acquire) {
                    match reader.recv_timeout(Duration::from_millis(20)) {
                        Ok(value) => return Some(value),
                        Err(mpsc::RecvTimeoutError::Disconnected) => return None,
                        _ => {}
                    }
                }
                None
            };
            if !receive(Duration::from_secs(5)).is_some_and(|value| value["event"] == "ready") {
                let _ = status_tx.try_send("startup_failed");
                return;
            }
            let _ = status_tx.try_send("ready");
            while !cancelled.load(Ordering::Acquire) {
                if pending.has_changed().unwrap_or(false) {
                    let request = pending.borrow_and_update().clone();
                    if let Some(request) = request {
                        let Ok(mut data) = serde_json::to_vec(&request) else {
                            return;
                        };
                        data.push(b'\n');
                        if worker
                            .child
                            .stdin
                            .as_mut()
                            .is_none_or(|stdin| stdin.write_all(&data).is_err())
                        {
                            return;
                        }
                        // A slow/broken classifier cannot postpone final inference.
                        let Some(value) = receive(Duration::from_millis(250)) else {
                            if !cancelled.load(Ordering::Acquire) {
                                let _ = status_tx.try_send(
                                    if worker.child.try_wait().ok().flatten().is_some() {
                                        "worker_exited"
                                    } else {
                                        "classification_timeout"
                                    },
                                );
                            }
                            return;
                        };
                        let Ok(prediction) = serde_json::from_value(value) else {
                            let _ = status_tx.try_send("invalid_prediction");
                            return;
                        };
                        let _ = output.try_send(prediction);
                    }
                } else {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        });
        Self {
            input,
            result,
            stop,
            status,
        }
    }
    pub fn submit(&self, input: Input) {
        self.input.send_replace(Some(input));
    }
    pub fn prediction(&self) -> Option<Prediction> {
        self.result.try_recv().ok()
    }
    pub fn status(&self) -> Option<&'static str> {
        self.status.try_recv().ok()
    }
}
impl Drop for Classifier {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn isolated_profile_selection_rejects_missing_and_escaped_paths() {
        let root=std::env::temp_dir().join(format!("copilot-profile-{}",uuid::Uuid::new_v4()));
        let models=root.join(".local/intent-encoder");
        std::fs::create_dir_all(models.join("candidate")).unwrap();
        std::fs::write(models.join("profile.json"),"{}").unwrap();
        std::fs::write(models.join("candidate/profile.json"),"{}").unwrap();
        std::fs::write(root.join("outside.json"),"{}").unwrap();
        assert_eq!(selected_profile(&root,None).unwrap(),models.join("profile.json").canonicalize().unwrap());
        assert_eq!(selected_profile(&root,Some(".local/intent-encoder/candidate/profile.json".into())).unwrap(),models.join("candidate/profile.json").canonicalize().unwrap());
        assert!(selected_profile(&root,Some("outside.json".into())).is_err());
        assert!(selected_profile(&root,Some(".local/intent-encoder/missing.json".into())).is_err());
        assert!(selected_profile(&root,Some(".local/intent-encoder/candidate".into())).is_err());
        // Verify the resolved deletion target is the unique test-owned child.
        let resolved=root.canonicalize().unwrap();
        let temp=std::env::temp_dir().canonicalize().unwrap();
        assert_eq!(resolved.parent(),Some(temp.as_path()));
        assert_eq!(resolved.file_name(),root.file_name());
        assert!(resolved.file_name().unwrap().to_string_lossy().starts_with("copilot-profile-"));
        std::fs::remove_dir_all(resolved).unwrap();
    }
    #[test]
    fn acoustic_end_updates_existing_hidden_work_once_without_an_intent_prediction() {
        use crate::meeting::scheduler::Scheduler;
        let mut gate=Gate::default();let mut scheduler=Scheduler::default();scheduler.semantic_intent=true;
        let id=scheduler.propose("Initial request".into(),25,25,25);
        scheduler.next(25);let job=scheduler.find_mut(&id).unwrap();job.steer_supported=true;
        job.latency.remote_speech_started_at=Some(20);job.buffer="Old hidden answer".into();job.latency.first_word_at=Some(30);
        gate.observe(20,"Complete changed request".into(),"Earlier reference".into(),100);
        assert!(gate.settled_input(150,90,true,false).is_none());
        assert!(gate.settled_input(200,90,false,false).is_none());
        assert!(gate.settled_input(200,90,true,true).is_none());
        let input=gate.settled_input(200,90,true,false).unwrap();
        assert_eq!(scheduler.update_speculative_question(input.floor,input.text),Some(id.clone()));
        gate.mark_settled_update(input.floor,90);
        assert_eq!(scheduler.jobs.len(),1);assert_eq!(scheduler.active(),1);
        assert!(scheduler.visible().is_none());assert!(scheduler.jobs[0].buffer.is_empty());
        gate.observe(20,"Later final correction".into(),"Earlier reference".into(),260);
        assert!(gate.settled_input(400,90,true,false).is_none());
        assert!(gate.settled_input(400,410,true,false).is_none());
        assert!(gate.settled_input(500,410,true,false).is_some());
        let final_id=scheduler.confirm("Later final correction".into(),500,410,490);
        assert_ne!(final_id,id);assert!(scheduler.find_mut(&id).unwrap().cancel.is_cancelled());
        let final_job=scheduler.find_mut(&final_id).unwrap();
        assert_eq!(final_job.question.text,"Later final correction");assert!(!final_job.cancel.is_cancelled());
        assert!(scheduler.update_speculative_question(20,"Unconfirmed stale text".into()).is_none());
        gate.invalidate();assert!(gate.settled_input(600,410,true,false).is_none());
        gate.observe(700,"Next floor".into(),String::new(),700);
        assert!(gate.settled_input(800,410,true,false).is_none());
    }
    use super::*;
    fn prediction(id: u64) -> Prediction {
        Prediction {
            id,
            abstained: false,
            scores: Some(Scores {
                request: 0.99,
                ready: 0.99,
                background: Some(0.01),
            }),
            elapsed_ms: Some(1.),
        }
    }
    #[test]
    fn changed_text_is_classified_at_most_every_250_ms() {
        let mut gate = Gate::default();
        gate.observe(1, "first".into(), "".into(), 0);
        assert!(gate.request(0).is_some());
        for now in 1..250 {
            gate.observe(1, now.to_string(), "".into(), now);
            assert!(gate.request(now).is_none());
        }
        assert_eq!(gate.request(250).unwrap().text, "249");
        assert!(gate.request(500).is_none());
    }
    #[test]
    fn quiet_priority_is_stable_once_per_pause_and_does_not_authorize_generation() {
        let mut gate=Gate::default();
        gate.observe(1,"initial".into(),"".into(),0);
        let initial=gate.request_with_quiet(0,false,true).unwrap();
        gate.observe(1,"changed".into(),"".into(),100);
        assert!(gate.request_with_quiet(199,true,true).is_none());
        let fast=gate.request_with_quiet(200,true,true).unwrap();
        assert!(gate.last_submission_prioritized());
        assert!(!gate.accept(prediction(initial.id)));
        assert!(gate.early(200,true,false,0.95).is_none());
        assert!(gate.accept(prediction(fast.id)));
        assert!(gate.early(200,false,false,0.95).is_none());
        assert!(gate.early(200,true,true,0.95).is_none());
        assert_eq!(gate.early(200,true,false,0.95).unwrap().id,fast.id);
        assert!(gate.request_with_quiet(220,true,true).is_none());
        gate.observe(1,"later condition".into(),"".into(),210);
        assert!(gate.request_with_quiet(310,true,true).is_none());
        assert!(gate.request_with_quiet(450,true,true).is_some());
        assert!(!gate.last_submission_prioritized());
        // The pause remains spent after an ordinary due submission.
        gate.observe(1,"still changing".into(),"".into(),460);
        assert!(gate.request_with_quiet(560,true,true).is_none());
        // Renewed speech rearms the classification budget, not the job budget.
        assert!(gate.request_with_quiet(570,false,true).is_none());
        assert!(gate.request_with_quiet(580,true,true).is_some());
        assert!(gate.last_submission_prioritized());
        assert!(gate.early(580,true,false,0.95).is_none());
    }
    #[test]
    fn disabled_quiet_priority_keeps_cadence_and_invalidation_discards_old_results() {
        let mut gate=Gate::default();
        gate.observe(1,"initial".into(),"".into(),0);
        gate.request_with_quiet(0,false,true).unwrap();
        gate.observe(1,"stable".into(),"".into(),100);
        assert!(gate.request_with_quiet(200,true,false).is_none());
        let sent=gate.request_with_quiet(200,true,true).unwrap();
        gate.invalidate();
        gate.observe(2,"new turn".into(),"changed reference".into(),300);
        assert!(!gate.accept(prediction(sent.id)));
        let latest=gate.request_with_quiet(400,true,true).unwrap();
        assert_ne!(latest.id,sent.id);
        assert!(gate.last_submission_prioritized());
        assert!(gate.ready_input(400,true,false,0.95).is_none());
    }
    #[test]
    fn stale_predictions_and_changed_conditions_cannot_start() {
        let mut gate = Gate::default();
        gate.observe(1, "request".into(), "".into(), 0);
        let old = gate.request(0).unwrap();
        gate.observe(1, "request plus condition".into(), "".into(), 100);
        assert!(!gate.accept(prediction(old.id)));
        assert!(gate.early(300, true, false, 0.9).is_none());
        let latest = gate.request(300).unwrap();
        assert!(gate.accept(prediction(latest.id)));
        assert!(gate.early(300, false, false, 0.9).is_none());
        assert!(gate.early(300, true, true, 0.9).is_none());
        assert_eq!(
            gate.early(300, true, false, 0.9).unwrap().text,
            "request plus condition"
        );
        assert!(gate.early(600, true, false, 0.9).is_none());
    }
    #[test]
    fn resumed_or_cleared_floor_invalidates_even_identical_text() {
        let mut gate = Gate::default();
        gate.observe(1, "same".into(), "".into(), 0);
        let request = gate.request(0).unwrap();
        gate.invalidate();
        gate.observe(1, "same".into(), "".into(), 50);
        assert!(!gate.accept(prediction(request.id)));
    }
    #[test]
    fn changing_reference_context_rejects_the_old_prediction_and_spent_floor_stays_spent() {
        let mut gate = Gate::default();
        gate.observe(1, "Explain that".into(), "first reference".into(), 0);
        let first = gate.request(0).unwrap();
        gate.observe(1, "Explain that".into(), "corrected reference".into(), 50);
        assert!(!gate.accept(prediction(first.id)));
        let latest = gate.request(250).unwrap();
        gate.accept(prediction(latest.id));
        assert!(gate.early(250, true, false, 0.9).is_some());
        gate.observe(
            1,
            "Explain that more".into(),
            "corrected reference".into(),
            300,
        );
        let next=gate.request(600).unwrap();
        assert!(gate.ready_input(600,true,false,0.9).is_none());
        gate.accept(prediction(next.id));
        assert_eq!(gate.ready_input(600,true,false,0.9).unwrap().text,"Explain that more");
        assert!(gate.early(600,true,false,0.9).is_none());
    }
    #[test]
    fn only_an_exact_existing_background_prediction_can_skip_final_inference() {
        let mut gate = Gate::default();
        gate.observe(1, "A statement".into(), "reference".into(), 0);
        let id = gate.request(0).unwrap().id;
        assert!(!gate.background(1, "A statement", "reference", 0.95));
        gate.accept(Prediction {
            id,
            abstained: false,
            scores: Some(Scores {
                request: 0.01,
                ready: 0.001,
                background: Some(0.99),
            }),
            elapsed_ms: Some(1.),
        });
        assert!(gate.background(1, "A statement", "reference", 0.95));
        for (floor, text, context) in [
            (2, "A statement", "reference"),
            (1, "A statement with a request", "reference"),
            (1, "A statement", "corrected reference"),
        ] {
            assert!(!gate.background(floor, text, context, 0.95));
        }
        let mut abstained = prediction(id);
        abstained.abstained = true;
        gate.accept(abstained);
        assert!(!gate.background(1, "A statement", "reference", 0.95));
    }
    #[test]
    fn abstention_and_invalid_scores_fail_closed_for_speculation() {
        let mut gate = Gate::default();
        gate.observe(1, "text".into(), "".into(), 0);
        let id = gate.request(0).unwrap().id;
        for scores in [
            None,
            Some(Scores {
                request: f64::NAN,
                ready: 1.,
                background: None,
            }),
            Some(Scores {
                request: 1.,
                ready: 0.1,
                background: None,
            }),
        ] {
            gate.accept(Prediction {
                id,
                abstained: false,
                scores,
                elapsed_ms: None,
            });
            assert!(gate.early(300, true, false, 0.9).is_none());
        }
        let mut result = prediction(id);
        result.abstained = true;
        gate.accept(result);
        assert!(gate.early(300, true, false, 0.9).is_none());
    }
}
