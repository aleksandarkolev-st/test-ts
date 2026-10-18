//! Isolated primitives for opt-in screen monitoring and guarded answer insertion.
//! The monitor never routes captures through the meeting screenshot action.
use std::collections::HashMap;
use std::time::Duration;

use crate::monitor::typing::TypingOutcome;

pub const MIN_INTERVAL: Duration = Duration::from_secs(2);
pub const MAX_INTERVAL: Duration = Duration::from_secs(300);
pub const DEFAULT_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MonitorConfig {
    pub enabled: bool,
    pub interval: Duration,
}
impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval: Duration::from_secs(10),
        }
    }
}
impl MonitorConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(MIN_INTERVAL..=MAX_INTERVAL).contains(&self.interval) {
            return Err("Screenshot interval must be between 2 and 300 seconds");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedAnswer {
    pub question: String,
    pub answer: String,
    pub source_window: usize,
    pub generation_id: u64,
    pub expires_at_ms: u64,
}
#[derive(Default)]
pub struct AnswerCache {
    latest_generation: u64,
    entries: HashMap<String, CachedAnswer>,
}
impl AnswerCache {
    pub fn next_generation(&mut self) -> u64 {
        self.latest_generation = self.latest_generation.wrapping_add(1).max(1);
        self.latest_generation
    }
    pub fn latest_generation(&self) -> u64 {
        self.latest_generation
    }
    pub fn insert(
        &mut self,
        question: &str,
        answer: &str,
        source_window: usize,
        generation_id: u64,
        now_ms: u64,
        ttl: Duration,
    ) -> bool {
        if generation_id != self.latest_generation
            || question.trim().is_empty()
            || answer.trim().is_empty()
        {
            return false;
        }
        let key = normalize_question(question);
        if self
            .entries
            .get(&key)
            .is_some_and(|e| e.generation_id > generation_id)
        {
            return false;
        }
        self.entries.insert(
            key,
            CachedAnswer {
                question: question.trim().into(),
                answer: answer.trim().into(),
                source_window,
                generation_id,
                expires_at_ms: now_ms.saturating_add(ttl.as_millis() as u64),
            },
        );
        true
    }
    pub fn get(&mut self, question: &str, now_ms: u64) -> Option<&CachedAnswer> {
        self.entries.retain(|_, e| e.expires_at_ms > now_ms);
        self.entries.get(&normalize_question(question))
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.latest_generation = self.latest_generation.wrapping_add(1);
    }
    pub fn len(&mut self, now_ms: u64) -> usize {
        self.entries.retain(|_, e| e.expires_at_ms > now_ms);
        self.entries.len()
    }
}
fn normalize_question(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn question_words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_lowercase())
        .collect()
}
fn word_pairs(words: &[String]) -> std::collections::HashSet<(String, String)> {
    words
        .windows(2)
        .map(|pair| (pair[0].clone(), pair[1].clone()))
        .collect()
}
/// Two extractions describe the same problem when they share enough consecutive
/// word pairs relative to the shorter one. Different sentences or truncations of
/// one problem statement still match (they share its distinctive phrases), while
/// unrelated statements do not.
fn same_problem(a: &[String], b: &[String]) -> bool {
    if a == b {
        return true;
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if short.len() < 4 {
        return false;
    }
    let short_pairs = word_pairs(short);
    if short_pairs.is_empty() {
        return false;
    }
    let long_pairs = word_pairs(long);
    let shared = short_pairs.intersection(&long_pairs).count();
    shared * 100 >= short_pairs.len() * 35
}

/// SHA-256 change gate over encoded screen bytes. Repeated frames do not trigger AI work.
#[derive(Default)]
pub struct ChangeGate {
    previous: Option<[u8; 32]>,
}
impl ChangeGate {
    pub fn changed(&mut self, bytes: &[u8]) -> bool {
        use sha2::{Digest, Sha256};
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        if self.previous == Some(digest) {
            false
        } else {
            self.previous = Some(digest);
            true
        }
    }
    pub fn reset(&mut self) {
        self.previous = None;
    }
}

/// Suppresses repeated questions and different excerpts of the same problem
/// across changed frames until explicitly reset. Vision extractions of one
/// problem statement vary between frames (a sentence here, a truncated phrase
/// there); matching them by word pairs prevents re-solving and re-typing the
/// same problem over and over.
#[derive(Default)]
pub struct QuestionDeduper {
    seen: Vec<Vec<String>>,
}
impl QuestionDeduper {
    /// Bounded so a long meeting cannot grow without limit.
    const MAX_SEEN: usize = 64;
    pub fn first_seen(&mut self, question: &str) -> bool {
        let words = question_words(question);
        if words.is_empty() {
            return false;
        }
        if self.seen.iter().any(|seen| same_problem(seen, &words)) {
            return false;
        }
        self.seen.push(words);
        if self.seen.len() > Self::MAX_SEEN {
            self.seen.remove(0);
        }
        true
    }
    pub fn reset(&mut self) {
        self.seen.clear();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldObservation {
    pub source_window: usize,
    pub foreground_window: usize,
    pub focused: bool,
    pub editable: bool,
    pub password: bool,
    pub generation_id: u64,
}
/// An answer is eligible for insertion only after fresh UIA evidence confirms that
/// the exact source window is foreground and focus is in a non-password edit field.
pub fn field_is_eligible(
    answer: &CachedAnswer,
    field: &FieldObservation,
    current_generation: u64,
    now_ms: u64,
) -> bool {
    answer.expires_at_ms > now_ms
        && answer.generation_id == current_generation
        && field.generation_id == current_generation
        && answer.source_window == field.source_window
        && field.source_window == field.foreground_window
        && field.focused
        && field.editable
        && !field.password
}

/// How long a dispatched attempt blocks a new one while its outcome is still
/// expected, for fast typing. The worker reports exactly one outcome per
/// attempt (Finished, Aborted, or Failed), so this only guards a worker that
/// died without reporting; once it elapses the attempt is presumed lost and
/// becomes retryable. A human performance instead passes its own budget as the
/// lock window, because minutes of typing are still "in flight".
pub const RETRY_AFTER_MS: u64 = 30_000;

/// One insertion attempt per screen-answer generation. A completed typing is
/// final, and so is an abort that had already typed something (a partial
/// answer must never be retyped on top of itself); a failure or an abort
/// before the first byte stays retryable, so the user can click the field
/// again instead of being locked out by a consumed authorization. In-flight
/// attempts block duplicates until their outcome or, for a silently stuck
/// worker, until the dispatch's lock window has passed.
#[derive(Default)]
pub struct InsertionGuard {
    attempts: HashMap<u64, TypingAttempt>,
}
#[derive(Clone, Copy, Debug)]
struct TypingAttempt {
    dispatched_at_ms: u64,
    in_flight: bool,
    finalized: bool,
}
impl InsertionGuard {
    pub fn authorize_once(
        &mut self,
        answer: &CachedAnswer,
        field: &FieldObservation,
        current_generation: u64,
        now_ms: u64,
        stuck_after_ms: u64,
    ) -> bool {
        if !field_is_eligible(answer, field, current_generation, now_ms) {
            return false;
        }
        let generation = answer.generation_id;
        let allowed = match self.attempts.get(&generation) {
            Some(attempt) if attempt.finalized => false,
            Some(attempt)
                if attempt.in_flight
                    && now_ms.saturating_sub(attempt.dispatched_at_ms) < stuck_after_ms =>
            {
                false
            }
            _ => true,
        };
        if allowed {
            self.attempts.insert(
                generation,
                TypingAttempt {
                    dispatched_at_ms: now_ms,
                    in_flight: true,
                    finalized: false,
                },
            );
        }
        allowed
    }
    /// Applies the typing worker's outcome to the dispatched attempt it answers.
    pub fn observe_outcome(&mut self, generation: u64, outcome: &TypingOutcome) {
        if let Some(attempt) = self.attempts.get_mut(&generation) {
            attempt.in_flight = false;
            attempt.finalized = matches!(outcome, TypingOutcome::Finished { .. })
                || matches!(outcome, TypingOutcome::Aborted { started: true, .. });
        }
    }
    /// The generation whose send is still running, if any. A dispatch for a
    /// different generation aborts it instead of queueing behind a performance
    /// that can run for many minutes.
    pub fn in_flight_generation(&self) -> Option<u64> {
        self.attempts
            .iter()
            .find_map(|(generation, attempt)| attempt.in_flight.then_some(*generation))
    }
    pub fn reset(&mut self) {
        self.attempts.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_screenshots_are_gated() {
        let mut g = ChangeGate::default();
        assert!(g.changed(b"frame a"));
        assert!(!g.changed(b"frame a"));
        assert!(g.changed(b"frame b"));
    }
    #[test]
    fn duplicate_questions_are_ignored_until_monitor_resets() {
        let mut d = QuestionDeduper::default();
        assert!(d.first_seen("What is Rust?"));
        assert!(!d.first_seen(" what  is rust? "));
        d.reset();
        assert!(d.first_seen("What is Rust?"));
    }
    #[test]
    fn repeated_questions_are_deduplicated_and_answers_expire() {
        let mut c = AnswerCache::default();
        let id = c.next_generation();
        assert!(c.insert(
            "What is Rust?",
            "A language.",
            7,
            id,
            100,
            Duration::from_millis(20)
        ));
        assert_eq!(c.len(119), 1);
        assert_eq!(
            c.get(" what  is rust? ", 119).unwrap().answer,
            "A language."
        );
        assert!(c.get("What is Rust?", 120).is_none());
        assert_eq!(c.len(120), 0);
    }
    #[test]
    fn latest_generation_is_readable_without_advancing_it() {
        let mut c = AnswerCache::default();
        assert_eq!(c.latest_generation(), 0);
        let id = c.next_generation();
        assert_eq!(c.latest_generation(), id);
    }
    #[test]
    fn stale_answers_and_cancelled_generations_cannot_be_saved() {
        let mut c = AnswerCache::default();
        let old = c.next_generation();
        let new = c.next_generation();
        assert!(!c.insert("Q", "old", 1, old, 1, DEFAULT_TTL));
        assert!(c.insert("Q", "new", 1, new, 1, DEFAULT_TTL));
        c.clear();
        assert!(c.get("Q", 2).is_none());
    }
    fn answer() -> CachedAnswer {
        CachedAnswer {
            question: "Q".into(),
            answer: "A".into(),
            source_window: 4,
            generation_id: 8,
            expires_at_ms: 100,
        }
    }
    fn field() -> FieldObservation {
        FieldObservation {
            source_window: 4,
            foreground_window: 4,
            focused: true,
            editable: true,
            password: false,
            generation_id: 8,
        }
    }
    #[test]
    fn focus_switching_and_wrong_fields_are_rejected() {
        let a = answer();
        let mut f = field();
        assert!(field_is_eligible(&a, &f, 8, 1));
        f.foreground_window = 9;
        assert!(!field_is_eligible(&a, &f, 8, 1));
        f = field();
        f.source_window = 9;
        assert!(!field_is_eligible(&a, &f, 8, 1));
        f = field();
        f.focused = false;
        assert!(!field_is_eligible(&a, &f, 8, 1));
    }
    #[test]
    fn noneditable_and_password_fields_are_rejected() {
        let a = answer();
        let mut f = field();
        f.password = true;
        assert!(!field_is_eligible(&a, &f, 8, 1));
        f = field();
        f.editable = false;
        assert!(!field_is_eligible(&a, &f, 8, 1));
    }
    #[test]
    fn expiration_and_cancellation_reject_insertion() {
        let a = answer();
        let f = field();
        assert!(!field_is_eligible(&a, &f, 9, 1));
        assert!(!field_is_eligible(&a, &f, 8, 100));
    }
    #[test]
    fn duplicate_insertions_are_rejected() {
        let a = answer();
        let f = field();
        let mut guard = InsertionGuard::default();
        assert!(guard.authorize_once(&a, &f, 8, 1, RETRY_AFTER_MS));
        assert!(!guard.authorize_once(&a, &f, 8, 1, RETRY_AFTER_MS));
    }
    #[test]
    fn failed_attempts_become_retryable_while_finished_ones_stay_final() {
        let a = answer();
        let f = field();
        let mut guard = InsertionGuard::default();
        assert!(guard.authorize_once(&a, &f, 8, 1, RETRY_AFTER_MS));
        guard.observe_outcome(
            8,
            &TypingOutcome::Failed {
                generation: 8,
                error: "no keyboard".into(),
            },
        );
        assert!(guard.authorize_once(&a, &f, 8, 2, RETRY_AFTER_MS));
        guard.observe_outcome(8, &TypingOutcome::Finished { generation: 8 });
        assert!(!guard.authorize_once(&a, &f, 8, 3, RETRY_AFTER_MS));
    }
    #[test]
    fn silent_in_flight_attempts_unlock_after_the_retry_window() {
        let mut a = answer();
        a.expires_at_ms = u64::MAX;
        let f = field();
        let mut guard = InsertionGuard::default();
        assert!(guard.authorize_once(&a, &f, 8, 1, RETRY_AFTER_MS));
        assert!(!guard.authorize_once(&a, &f, 8, 2, RETRY_AFTER_MS));
        assert!(guard.authorize_once(&a, &f, 8, 1 + RETRY_AFTER_MS + 1, RETRY_AFTER_MS));
    }
    #[test]
    fn aborts_that_already_typed_stay_final() {
        let a = answer();
        let f = field();
        let mut guard = InsertionGuard::default();
        assert!(guard.authorize_once(&a, &f, 8, 1, RETRY_AFTER_MS));
        guard.observe_outcome(
            8,
            &TypingOutcome::Aborted {
                generation: 8,
                started: true,
            },
        );
        assert!(!guard.authorize_once(&a, &f, 8, 2, RETRY_AFTER_MS));
    }
    #[test]
    fn aborts_before_the_first_byte_stay_retryable() {
        let a = answer();
        let f = field();
        let mut guard = InsertionGuard::default();
        assert!(guard.authorize_once(&a, &f, 8, 1, RETRY_AFTER_MS));
        guard.observe_outcome(
            8,
            &TypingOutcome::Aborted {
                generation: 8,
                started: false,
            },
        );
        assert!(guard.authorize_once(&a, &f, 8, 2, RETRY_AFTER_MS));
    }
    #[test]
    fn a_human_performance_locks_its_generation_for_its_budget() {
        let mut a = answer();
        a.expires_at_ms = u64::MAX;
        let f = field();
        let mut guard = InsertionGuard::default();
        let budget = 30 * 60_000u64;
        let lock = budget + 60_000;
        assert!(guard.authorize_once(&a, &f, 8, 1, lock));
        assert!(!guard.authorize_once(&a, &f, 8, 1 + budget, lock));
        assert!(guard.authorize_once(&a, &f, 8, 1 + lock + 1, lock));
    }
    #[test]
    fn in_flight_generation_tracks_the_running_send() {
        let a = answer();
        let f = field();
        let mut guard = InsertionGuard::default();
        assert_eq!(guard.in_flight_generation(), None);
        assert!(guard.authorize_once(&a, &f, 8, 1, RETRY_AFTER_MS));
        assert_eq!(guard.in_flight_generation(), Some(8));
        guard.observe_outcome(8, &TypingOutcome::Finished { generation: 8 });
        assert_eq!(guard.in_flight_generation(), None);
    }
    #[test]
    fn question_excerpts_of_one_problem_are_deduplicated() {
        let mut deduper = QuestionDeduper::default();
        assert!(deduper.first_seen("Return the running sum of nums."));
        assert!(!deduper.first_seen(
            "Given an array nums. We define a running sum of an array as runningSum[i] = sum("
        ));
        assert!(!deduper.first_seen("Return the running sum of nums."));
        assert!(deduper.first_seen(
            "Given an array nums of size n, return the majority element."
        ));
    }
    #[test]
    fn monitor_intervals_are_range_checked() {
        let mut c = MonitorConfig {
            enabled: true,
            interval: Duration::from_secs(10),
        };
        assert!(c.validate().is_ok());
        c.interval = Duration::from_secs(1);
        assert!(c.validate().is_err());
        c.interval = Duration::from_secs(301);
        assert!(c.validate().is_err());
    }
}
