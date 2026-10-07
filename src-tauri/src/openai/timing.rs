//! Numeric, monotonic timing only. No prompts, credentials or model text.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Instant};

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub candidate_detected: Option<u64>,
    pub codex_stream_entered: Option<u64>,
    pub semaphore_acquired: Option<u64>,
    pub warm_thread_taken: Option<u64>,
    pub prepared_thread_age_ms: Option<u64>,
    pub refill_started: Option<u64>,
    pub turn_start_sent: Option<u64>,
    pub turn_start_ack: Option<u64>,
    pub first_agent_delta: Option<u64>,
    pub turn_completed: Option<u64>,
    pub question_confirmed: Option<u64>,
    pub first_visible: Option<u64>,
    pub refill_completed: Option<u64>,
    pub refill_threads_created: usize,
    pub refill_error: bool,
    pub cancelled: bool,
    #[serde(default)] pub steering_count: usize,
    #[serde(default)] pub followup_count: usize,
    #[serde(default)] pub prompt_chars: usize,
    #[serde(default)] pub refinement_chars: usize,
    #[serde(default)] pub retained_first_delta: Option<u64>,
}
#[derive(Clone, Copy)]
pub enum Stage { StreamEntered, SemaphoreAcquired, WarmThreadTaken, RefillStarted, TurnStartSent, TurnStartAck, FirstAgentDelta, TurnCompleted, QuestionConfirmed, FirstVisible, RefillCompleted }
#[derive(Clone, Debug)]
pub struct Trace { clock: Instant, data: Arc<Mutex<Timeline>> }
impl Trace {
    pub fn new(clock: Instant, candidate: u64) -> Self {
        Self { clock, data: Arc::new(Mutex::new(Timeline { candidate_detected: Some(candidate), ..Default::default() })) }
    }
    pub fn mark(&self, stage: Stage) {
        let now = self.clock.elapsed().as_millis() as u64;
        let mut t = self.data.lock().unwrap();
        let slot = match stage {
            Stage::StreamEntered => &mut t.codex_stream_entered,
            Stage::SemaphoreAcquired => &mut t.semaphore_acquired,
            Stage::WarmThreadTaken => &mut t.warm_thread_taken,
            Stage::RefillStarted => &mut t.refill_started,
            Stage::TurnStartSent => &mut t.turn_start_sent,
            Stage::TurnStartAck => &mut t.turn_start_ack,
            Stage::FirstAgentDelta => &mut t.first_agent_delta,
            Stage::TurnCompleted => &mut t.turn_completed,
            Stage::QuestionConfirmed => &mut t.question_confirmed,
            Stage::FirstVisible => &mut t.first_visible,
            Stage::RefillCompleted => &mut t.refill_completed,
        };
        if matches!(stage,Stage::TurnCompleted) {*slot=Some(now);} else {slot.get_or_insert(now);}
    }
    pub fn confirmed_at(&self, now: u64) { self.data.lock().unwrap().question_confirmed = Some(now); }
    pub fn prepared_age(&self, age: u64) { self.data.lock().unwrap().prepared_thread_age_ms = Some(age); }
    pub fn refill_thread_created(&self) { self.data.lock().unwrap().refill_threads_created += 1; }
    pub fn refill_failed(&self) { self.data.lock().unwrap().refill_error = true; }
    pub fn cancelled(&self) { self.data.lock().unwrap().cancelled = true; }
    pub fn steered(&self) { self.data.lock().unwrap().steering_count += 1; }
    pub fn followup(&self) { self.data.lock().unwrap().followup_count += 1; }
    pub fn prompt_chars(&self, count:usize) { self.data.lock().unwrap().prompt_chars=count; }
    pub fn refinement_chars(&self, count:usize) { self.data.lock().unwrap().refinement_chars+=count; }
    pub fn retained_delta_at(&self, now:u64) { self.data.lock().unwrap().retained_first_delta=Some(now); }
    pub fn snapshot(&self) -> Timeline { self.data.lock().unwrap().clone() }
}
pub type Registry = Arc<Mutex<HashMap<String, Trace>>>;
pub fn register(registry: &Registry, id: String, trace: Trace) {
    let mut entries = registry.lock().unwrap();
    // Retain recent attempts for diagnostics without accumulating meeting data.
    if entries.len() >= 256 {
        let oldest = entries.iter().min_by_key(|(_,t)|t.snapshot().candidate_detected).map(|(id,_)|id.clone());
        if let Some(id) = oldest { entries.remove(&id); }
    }
    entries.insert(id, trace);
}
