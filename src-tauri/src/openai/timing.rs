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
    pub backend: Option<String>,
    pub model_request_sent: Option<u64>,
    pub response_created: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub actual_service_tier: Option<String>,
    pub response_count: usize,
    pub steering_count: usize,
    pub warm_state_used: bool,

    #[serde(default)] pub followup_count: usize,
    #[serde(default)] pub prompt_chars: usize,
    #[serde(default)] pub refinement_chars: usize,
    #[serde(default)] pub retained_first_delta: Option<u64>,
    #[serde(default)] pub latest_input_sent: Option<u64>,
    #[serde(default)] pub latest_input_ack: Option<u64>,
    #[serde(default)] pub latest_input_consumed: Option<u64>,
    #[serde(default)] pub refinement_restart_count: usize,
    #[serde(default)] pub restart_prompt_chars: Option<usize>,
    #[serde(default)] pub acoustic_refinement_count: usize,
    #[serde(default)] pub eager_final_replacement: bool,
    #[serde(default)] pub confirmed_question_refinements: bool,
    #[serde(default)] pub cleanup_started_at: Option<u64>,
    #[serde(default)] pub interrupt_ack_at: Option<u64>,
    #[serde(default)] pub cleanup_terminal_at: Option<u64>,
    #[serde(default)] pub cleanup_max_queued_events: usize,
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
    pub fn restart_prompt_chars(&self,count:usize) {self.data.lock().unwrap().restart_prompt_chars=Some(count);}
    pub fn refinement_chars(&self, count:usize) { self.data.lock().unwrap().refinement_chars+=count; }
    pub fn retained_delta_at(&self, now:u64) { self.data.lock().unwrap().retained_first_delta=Some(now); }
    pub fn reset_answer(&self) {let mut data=self.data.lock().unwrap();data.retained_first_delta=None;data.first_visible=None;}
    pub fn input_sent(&self) {let mut data=self.data.lock().unwrap();data.latest_input_sent=Some(self.clock.elapsed().as_millis()as u64);data.latest_input_ack=None;data.latest_input_consumed=None;}
    pub fn input_ack(&self) {self.data.lock().unwrap().latest_input_ack=Some(self.clock.elapsed().as_millis()as u64);}
    pub fn input_consumed(&self) {self.data.lock().unwrap().latest_input_consumed=Some(self.clock.elapsed().as_millis()as u64);}
    pub fn refinement_restarted(&self) {self.data.lock().unwrap().refinement_restart_count+=1;}
    pub fn acoustic_refined(&self) {self.data.lock().unwrap().acoustic_refinement_count+=1;}
    pub fn eager_final_replacement(&self, enabled:bool) {self.data.lock().unwrap().eager_final_replacement=enabled;}
    pub fn confirmed_question_refinements(&self, enabled:bool) {self.data.lock().unwrap().confirmed_question_refinements=enabled;}
    pub fn cleanup_started(&self,queued:usize) {let mut t=self.data.lock().unwrap();t.cleanup_started_at=Some(self.clock.elapsed().as_millis()as u64);t.interrupt_ack_at=None;t.cleanup_terminal_at=None;t.cleanup_max_queued_events=queued;}
    pub fn cleanup_queue_depth(&self,queued:usize) {let mut t=self.data.lock().unwrap();t.cleanup_max_queued_events=t.cleanup_max_queued_events.max(queued);}
    pub fn interrupt_ack(&self) {self.data.lock().unwrap().interrupt_ack_at=Some(self.clock.elapsed().as_millis()as u64);}
    pub fn cleanup_terminal(&self) {self.data.lock().unwrap().cleanup_terminal_at=Some(self.clock.elapsed().as_millis()as u64);}
    pub fn snapshot(&self) -> Timeline { self.data.lock().unwrap().clone() }
    pub fn backend(&self, backend: &str) { self.data.lock().unwrap().backend = Some(backend.into()); }
    pub fn request_sent(&self) { self.data.lock().unwrap().model_request_sent.get_or_insert(self.clock.elapsed().as_millis() as u64); }
    pub fn created(&self) { let mut t=self.data.lock().unwrap(); t.response_created.get_or_insert(self.clock.elapsed().as_millis() as u64); t.response_count+=1; }
    pub fn warmed(&self) { self.data.lock().unwrap().warm_state_used=true; }
    pub fn response_metadata(&self, response: &serde_json::Value) {
        let mut t=self.data.lock().unwrap();
        if let Some(tier)=response["service_tier"].as_str() { t.actual_service_tier=Some(tier.into()); }
        if let Some(tokens)=response["usage"]["input_tokens_details"]["cached_tokens"].as_u64() {
            t.cached_input_tokens=Some(t.cached_input_tokens.unwrap_or(0)+tokens);
        }
    }
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
