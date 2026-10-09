use super::{context::MeetingContext, questions::QuestionDetector};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentQuestion {
    pub id: String,
    pub text: String,
    pub detected_at: u64,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Latency {
    #[serde(default)]
    pub response_revision: u64,
    #[serde(default)]
    pub pipeline: crate::openai::timing::Timeline,
    pub remote_speech_started_at: Option<u64>,
    pub first_remote_partial_at: Option<u64>,
    pub first_credible_candidate_at: Option<u64>,
    #[serde(default)]
    pub remote_partial_updates: usize,
    pub speech_stopped_at: u64,
    pub transcript_final_at: u64,
    pub question_confirmed_at: u64,
    pub request_sent_at: u64,
    pub first_token_at: Option<u64>,
    #[serde(default)]
    pub first_word_at: Option<u64>,
    pub completed_at: Option<u64>,
}
impl Latency {
    /// Arrival of the first character of an answer word, without waiting for
    /// its completion or a sentence. Protocol framing is removed upstream.
    pub fn observe_answer_delta(&mut self,delta:&str,now:u64) {
        if !delta.is_empty(){self.first_token_at.get_or_insert(now);}
        if delta.chars().any(char::is_alphanumeric){self.first_word_at.get_or_insert(now);}
    }
}
#[cfg(test)] mod latency_tests {
    use super::Latency;
    #[test]
    fn first_word_starts_before_word_or_sentence_completion_and_skips_formatting() {
        let mut l=Latency::default();l.observe_answer_delta("",1);
        assert!(l.first_token_at.is_none());
        l.observe_answer_delta("**",2);assert_eq!(l.first_token_at,Some(2));assert!(l.first_word_at.is_none());
        l.observe_answer_delta("A",3);assert_eq!(l.first_word_at,Some(3));
        l.observe_answer_delta("t 64 KiB",20);assert_eq!(l.first_word_at,Some(3));
        for word in ["4","Δ","是"]{let mut l=Latency::default();l.observe_answer_delta(word,5);assert_eq!(l.first_word_at,Some(5));}
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub questions: Vec<super::scheduler::Row>,
    pub revision: u64,
    pub active: bool,
    pub paused: bool,
    pub status: String,
    pub question: Option<CurrentQuestion>,
    pub answer: String,
    pub error: Option<String>,
    pub protection: bool,
    pub expanded: bool,
    pub manual: bool,
    pub latency: Option<Latency>,
    pub remote_level: f32,
    pub self_level: f32,
    pub project: Option<crate::attachments::project::ProjectInfo>,
    pub attachment_busy: bool,
    pub screenshot: Option<crate::attachments::screenshot::ScreenshotInfo>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            questions: Vec::new(),
            revision: 0,
            active: false,
            paused: false,
            status: "off".into(),
            question: None,
            answer: String::new(),
            error: None,
            protection: false,
            expanded: false,
            manual: false,
            latency: None,
            remote_level: 0.,
            self_level: 0.,
            project: None,
            attachment_busy: false,
            screenshot: None,
        }
    }
}
#[derive(Default)]
pub struct Engine {
    pub view: Snapshot,
    pub context: MeetingContext,
    pub detector: QuestionDetector,
    pub project: Option<crate::attachments::project::Project>,
    pub screenshot_data: Option<String>,
}
impl Engine {
    pub fn clear_meeting(&mut self) {
        self.project = None;
        let protection = self.view.protection;
        let revision = self.view.revision + 1;
        *self = Self::default();
        self.view.protection = protection;
        self.view.revision = revision;
    }
}
