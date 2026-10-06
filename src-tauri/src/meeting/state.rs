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
    pub speech_stopped_at: u64,
    pub transcript_final_at: u64,
    pub question_confirmed_at: u64,
    pub request_sent_at: u64,
    pub first_token_at: Option<u64>,
    pub completed_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
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
