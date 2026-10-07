pub mod context;
pub mod questions;
pub mod state;
pub mod scheduler;

use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpeakerSource {
    Remote,
    #[serde(rename = "self")]
    Self_,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub source: SpeakerSource,
    pub text: String,
    pub started_at: u64,
    pub ended_at: u64,
    #[serde(rename = "final")]
    pub final_: bool,
}

#[derive(Clone, Debug)]
pub enum InputEvent {
    SpeechStarted(SpeakerSource, u64),
    SpeechEnded(SpeakerSource, u64),
    Transcript(TranscriptSegment),
    Manual(String),
    Dismiss,
    Pause(bool),
    Stop,
    Failure(String),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusEvent {
    pub name: String,
    pub payload: serde_json::Value,
}
