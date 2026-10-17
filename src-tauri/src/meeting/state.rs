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
    pub task: super::task::Task,
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
    pub can_answer_now: bool,
    pub latency: Option<Latency>,
    pub remote_level: f32,
    pub self_level: f32,
    pub project: Option<crate::attachments::project::ProjectInfo>,
    pub attachment_busy: bool,
    pub screenshot: Option<crate::attachments::screenshot::ScreenshotInfo>,
    pub monitor: Option<crate::monitor::service::MonitorStatus>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            task: super::task::Task::default(),
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
            can_answer_now: false,
            latency: None,
            remote_level: 0.,
            self_level: 0.,
            project: None,
            attachment_busy: false,
            screenshot: None,
            monitor: None,
        }
    }
}
#[derive(Default)]
pub struct Engine {
    pub task_started_at: u64,
    pub view: Snapshot,
    pub context: MeetingContext,
    pub detector: QuestionDetector,
    pub project: Option<crate::attachments::project::Project>,
    pub screenshot_data: Option<String>,
    /// Screen-monitor answers are separate from meeting answers and remain RAM-only.
    pub screen_answers: crate::attachments::screen_monitor::AnswerCache,
}
impl Engine {
    pub fn new_task(&mut self, now: u64) {
        self.task_started_at = now;
        self.context.clear();
        self.detector.supersede_remote_before(now);
        self.project = None;
        self.screenshot_data = None;
        self.screen_answers.clear();
        self.view.task = super::task::Task::default();
        self.view.project = None;
        self.view.screenshot = None;
        self.view.attachment_busy = false;
        self.view.questions.clear();
        self.view.question = None;
        self.view.answer.clear();
        self.view.error = None;
        self.view.latency = None;
        self.view.expanded = false;
        self.view.manual = false;
        self.view.can_answer_now = false;
        if let Some(monitor) = self.view.monitor.as_mut() {
            *monitor = crate::monitor::service::MonitorStatus::watching();
        }
        self.view.status = if self.view.active { "listening" } else { "off" }.into();
    }
    pub fn clear_meeting(&mut self) {
        self.project = None;
        let protection = self.view.protection;
        let revision = self.view.revision + 1;
        *self = Self::default();
        self.view.protection = protection;
        self.view.revision = revision;
    }
}

#[cfg(test)]
mod task_tests {
    use super::*;
    #[test]
    fn new_task_drops_old_context_and_attachments_without_stopping_capture() {
        let mut engine = Engine::default();
        engine.view.active = true; engine.view.paused = true; engine.view.protection = true;
        engine.view.remote_level = 0.3; engine.view.manual = true; engine.view.expanded = true;
        engine.view.task.update("problem", "OLD_TASK_PROBLEM".into()).unwrap();
        engine.view.task.update("test_output", "OLD_TEST_FAILURE".into()).unwrap();
        let old_id = engine.view.task.id.clone();
        engine.view.question = Some(CurrentQuestion { id: "old".into(), text: "OLD_QUESTION".into(), detected_at: 1 });
        engine.view.answer = "OLD_ANSWER".into(); engine.view.error = Some("Old error".into());
        engine.view.attachment_busy = true; engine.screenshot_data = Some("old pixels".into());
        engine.context.push(super::super::TranscriptSegment { id: "old-transcript".into(), source: super::super::SpeakerSource::Remote,
            text: "OLD_TASK_CONVERSATION".into(), started_at: 10, ended_at: 20, final_: true });
        engine.context.remember_answer("old", "OLD_QUESTION", "OLD_SUGGESTION");
        engine.new_task(100);
        assert_ne!(engine.view.task.id, old_id);
        assert!(engine.view.task.problem.is_empty() && engine.view.task.test_output.is_none());
        assert!(engine.view.question.is_none() && engine.view.answer.is_empty() && engine.view.error.is_none());
        assert!(engine.screenshot_data.is_none() && engine.project.is_none());
        assert!(engine.view.project.is_none() && engine.view.screenshot.is_none() && !engine.view.attachment_busy);
        assert!(!engine.view.manual && !engine.view.expanded && engine.view.latency.is_none());
        assert!(!engine.context.answer_context("Next task").contains("OLD_"));
        assert!(!engine.detector.remote_source_current(10));
        assert!(engine.view.active && engine.view.paused && engine.view.protection);
        assert_eq!(engine.view.remote_level, 0.3);
        assert_eq!(engine.task_started_at, 100);
    }
}
