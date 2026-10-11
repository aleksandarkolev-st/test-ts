//! Numeric, monotonic timing only. No prompts, credentials or model text.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Instant};

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    #[serde(default)] pub generation_id:Option<String>,
    #[serde(default)] pub session_id:Option<String>,
    #[serde(default)] pub utterance_id:Option<u64>,
    #[serde(default)] pub utterance_revision:u64,
    #[serde(default)] pub context_version:u64,
    #[serde(default)] pub input_hash:Option<[u8;32]>,
    #[serde(default)] pub transport_written_at:Option<u64>,
    #[serde(default)] pub input_tokens:Option<u64>,
    #[serde(default)] pub output_tokens:Option<u64>,
    #[serde(default)] pub reasoning_tokens:Option<u64>,
    #[serde(default)] pub remote_termination_confirmed:Option<bool>,
    #[serde(default)] pub local_retirement_started_at:Option<u64>,
    #[serde(default)] pub local_retirement_released_at:Option<u64>,
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
    #[serde(default)] pub completed_draft_replacement_count: usize,
    #[serde(default)] pub restart_prompt_chars: Option<usize>,
    #[serde(default)] pub acoustic_refinement_count: usize,
    #[serde(default)] pub eager_final_replacement: bool,
    #[serde(default)] pub confirmed_question_refinements: bool,
    #[serde(default)] pub aged_final_wait: bool,
    #[serde(default)] pub pending_age_at_confirmation_ms: Option<u64>,
    #[serde(default)] pub final_pending_budget_ms: Option<u64>,
    #[serde(default)] pub cleanup_started_at: Option<u64>,
    #[serde(default)] pub interrupt_ack_at: Option<u64>,
    #[serde(default)] pub cleanup_terminal_at: Option<u64>,
    #[serde(default)] pub cleanup_max_queued_events: usize,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub latest_input_reader_received: Option<u64>,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub reader_queue_peak: usize,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub reader_send_count: usize,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub reader_full_queue_count: usize,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub reader_send_total_us: u64,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub reader_send_max_us: u64,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub delta_callback_count: usize,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub delta_callback_total_us: u64,
    #[cfg(all(feature="acceptance",debug_assertions))]
    #[serde(default)] pub delta_callback_max_us: u64,
}
#[derive(Clone, Copy)]
pub enum Stage { StreamEntered, SemaphoreAcquired, WarmThreadTaken, RefillStarted, TurnStartSent, TurnStartAck, FirstAgentDelta, TurnCompleted, QuestionConfirmed, FirstVisible, RefillCompleted }
#[derive(Clone, Debug)]
pub struct Trace { clock: Instant, data: Arc<Mutex<Timeline>>,
    #[cfg(all(feature="acceptance",debug_assertions))]
    expected_input: Arc<Mutex<Option<[u8;32]>>>,
}
impl Trace {
    pub fn frame(&self,session:&str,utterance:Option<u64>,revision:u64,version:u64,generation:&str,key:[u8;32]) {
        let mut data=self.data.lock().unwrap();data.session_id=Some(session.into());data.utterance_id=utterance;data.utterance_revision=revision;data.context_version=version;data.generation_id=Some(generation.into());data.input_hash=Some(key);
    }
    pub fn transport_written(&self) {self.data.lock().unwrap().transport_written_at=Some(self.clock.elapsed().as_millis()as u64);}
    pub fn usage(&self,usage:&serde_json::Value) {
        let mut data=self.data.lock().unwrap();
        data.input_tokens=usage["inputTokens"].as_u64().or(usage["input_tokens"].as_u64());
        data.output_tokens=usage["outputTokens"].as_u64().or(usage["output_tokens"].as_u64());
        data.reasoning_tokens=usage["reasoningOutputTokens"].as_u64().or(usage["output_tokens_details"]["reasoning_tokens"].as_u64());
        if let Some(cached)=usage["cachedInputTokens"].as_u64(){data.cached_input_tokens=Some(cached);}
    }
    pub fn new(clock: Instant, candidate: u64) -> Self {
        Self { clock, data: Arc::new(Mutex::new(Timeline { candidate_detected: Some(candidate), ..Default::default() })),
            #[cfg(all(feature="acceptance",debug_assertions))]
            expected_input: Arc::new(Mutex::new(None)),
        }
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
        if matches!(stage,Stage::TurnCompleted) {*slot=Some(now);t.remote_termination_confirmed=Some(true);} else {slot.get_or_insert(now);}
    }
    pub fn confirmed_at(&self, now: u64) { self.data.lock().unwrap().question_confirmed = Some(now); }
    pub fn prepared_age(&self, age: u64) { self.data.lock().unwrap().prepared_thread_age_ms = Some(age); }
    pub fn refill_thread_created(&self) { self.data.lock().unwrap().refill_threads_created += 1; }
    pub fn refill_failed(&self) { self.data.lock().unwrap().refill_error = true; }
    pub fn cancelled(&self) { let mut data=self.data.lock().unwrap();data.cancelled=true;data.remote_termination_confirmed.get_or_insert(false); }
    pub fn remote_terminal(&self){self.data.lock().unwrap().remote_termination_confirmed=Some(true);}
    pub fn local_retirement_started(&self){let mut data=self.data.lock().unwrap();data.local_retirement_started_at=Some(self.clock.elapsed().as_millis()as u64);data.remote_termination_confirmed.get_or_insert(false);}
    pub fn local_retirement_released(&self){self.data.lock().unwrap().local_retirement_released_at=Some(self.clock.elapsed().as_millis()as u64);}
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
    // Acceptance-only numeric diagnostics. Matching uses the input hash and
    // records reader receipt separately from async consumer processing.
    #[cfg(all(feature="acceptance",debug_assertions))]
    pub fn diagnostic_input_expected(&self,key:[u8;32]) {
        *self.expected_input.lock().unwrap()=Some(key);
        self.data.lock().unwrap().latest_input_reader_received=None;
    }
    #[cfg(all(feature="acceptance",debug_assertions))]
    pub fn diagnostic_input_received(&self,keys:&[[u8;32]]) {
        if self.expected_input.lock().unwrap().is_some_and(|key|keys.contains(&key)) {
            self.data.lock().unwrap().latest_input_reader_received.get_or_insert(self.clock.elapsed().as_millis()as u64);
        }
    }
    #[cfg(all(feature="acceptance",debug_assertions))]
    pub fn diagnostic_reader_send(&self,queued:usize,full:bool,elapsed_us:u64) {
        let mut t=self.data.lock().unwrap();t.reader_queue_peak=t.reader_queue_peak.max(queued);
        t.reader_send_count+=1;t.reader_full_queue_count+=usize::from(full);
        t.reader_send_total_us=t.reader_send_total_us.saturating_add(elapsed_us);
        t.reader_send_max_us=t.reader_send_max_us.max(elapsed_us);
    }
    #[cfg(all(feature="acceptance",debug_assertions))]
    pub fn diagnostic_delta_callback(&self,elapsed_us:u64) {
        let mut t=self.data.lock().unwrap();t.delta_callback_count+=1;
        t.delta_callback_total_us=t.delta_callback_total_us.saturating_add(elapsed_us);
        t.delta_callback_max_us=t.delta_callback_max_us.max(elapsed_us);
    }
    pub fn refinement_restarted(&self) {self.data.lock().unwrap().refinement_restart_count+=1;}
    pub fn completed_draft_replaced(&self) {self.data.lock().unwrap().completed_draft_replacement_count+=1;}
    pub fn acoustic_refined(&self) {self.data.lock().unwrap().acoustic_refinement_count+=1;}
    pub fn eager_final_replacement(&self, enabled:bool) {self.data.lock().unwrap().eager_final_replacement=enabled;}
    pub fn confirmed_question_refinements(&self, enabled:bool) {self.data.lock().unwrap().confirmed_question_refinements=enabled;}
    pub fn aged_final_wait(&self,enabled:bool){self.data.lock().unwrap().aged_final_wait=enabled;}
    pub fn pending_at_confirmation(&self,age:Option<u64>,budget:u64){let mut t=self.data.lock().unwrap();t.pending_age_at_confirmation_ms=age;t.final_pending_budget_ms=Some(budget);}
    pub fn cleanup_started(&self,queued:usize) {let mut t=self.data.lock().unwrap();t.cleanup_started_at=Some(self.clock.elapsed().as_millis()as u64);t.interrupt_ack_at=None;t.cleanup_terminal_at=None;t.cleanup_max_queued_events=queued;}
    pub fn cleanup_queue_depth(&self,queued:usize) {let mut t=self.data.lock().unwrap();t.cleanup_max_queued_events=t.cleanup_max_queued_events.max(queued);}
    pub fn interrupt_ack(&self) {self.data.lock().unwrap().interrupt_ack_at=Some(self.clock.elapsed().as_millis()as u64);}
    pub fn cleanup_terminal(&self) {let mut data=self.data.lock().unwrap();data.cleanup_terminal_at=Some(self.clock.elapsed().as_millis()as u64);data.remote_termination_confirmed=Some(true);}
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
