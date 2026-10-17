//! Isolated primitives for opt-in screen monitoring and guarded answer insertion.
//! The monitor never routes captures through the meeting screenshot action.
use std::collections::HashMap;
use std::time::Duration;

pub const MIN_INTERVAL: Duration = Duration::from_secs(2);
pub const MAX_INTERVAL: Duration = Duration::from_secs(300);
pub const DEFAULT_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MonitorConfig {
    pub enabled: bool,
    pub interval: Duration,
    /// Executable basenames explicitly allowed by the user. Empty means no targets.
    pub authorized_applications: Vec<String>,
}
impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval: Duration::from_secs(10),
            authorized_applications: Vec::new(),
        }
    }
}
impl MonitorConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(MIN_INTERVAL..=MAX_INTERVAL).contains(&self.interval) {
            return Err("Screenshot interval must be between 2 and 300 seconds");
        }
        if self.authorized_applications.len() > 64
            || self
                .authorized_applications
                .iter()
                .any(|s| s.is_empty() || s.len() > 260 || s.contains(['/', '\\', ':']))
        {
            return Err("Authorized applications must be executable basenames");
        }
        Ok(())
    }
    pub fn permits(&self, executable: &str) -> bool {
        self.enabled
            && self
                .authorized_applications
                .iter()
                .any(|name| name.eq_ignore_ascii_case(executable))
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

/// Suppresses repeated question text across changed frames until explicitly reset.
#[derive(Default)]
pub struct QuestionDeduper {
    seen: std::collections::HashSet<String>,
}
impl QuestionDeduper {
    pub fn first_seen(&mut self, question: &str) -> bool {
        let key = normalize_question(question);
        !key.is_empty() && self.seen.insert(key)
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

/// One-shot insertion authorization. Reusing an authorization cannot type twice.
#[derive(Default)]
pub struct InsertionGuard {
    consumed: std::collections::HashSet<u64>,
}
impl InsertionGuard {
    pub fn authorize_once(
        &mut self,
        answer: &CachedAnswer,
        field: &FieldObservation,
        current_generation: u64,
        now_ms: u64,
    ) -> bool {
        field_is_eligible(answer, field, current_generation, now_ms)
            && self.consumed.insert(answer.generation_id)
    }
    pub fn reset(&mut self) {
        self.consumed.clear();
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
        assert!(guard.authorize_once(&a, &f, 8, 1));
        assert!(!guard.authorize_once(&a, &f, 8, 1));
    }
    #[test]
    fn only_authorized_applications_are_permitted() {
        let c = MonitorConfig {
            enabled: true,
            interval: Duration::from_secs(10),
            authorized_applications: vec!["notepad.exe".into()],
        };
        assert!(c.permits("NOTEPAD.EXE"));
        assert!(!c.permits("chrome.exe"));
    }
}
