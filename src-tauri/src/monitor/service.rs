//! Opt-in screen-monitor service: polls the foreground application on a fixed
//! interval, captures the monitor that is in front of the user (pausing while
//! the Copilot's own window is frontmost), gates repeated pixels through the
//! SHA-256 [`ChangeGate`], and asks the vision model to analyze each changed
//! frame. Results are delivered to the meeting actor as [`MonitorUpdate`]s; the
//! actor owns question deduplication, answer generation, and the visible
//! [`MonitorStatus`].
//!
//! The service never types and never touches the meeting screenshot action. It
//! stops when its [`CancellationToken`] fires, which the actor does on pause,
//! failure, and stop.
use crate::attachments::screen_monitor::{ChangeGate, MonitorConfig};
use crate::attachments::screenshot::capture_monitor_frame;
use crate::monitor::foreground;
use crate::monitor::vision::{self, Analysis};
use crate::openai::{auth::Auth, client::Client, prompts};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Frames are downscaled to this width before analysis: enough to read a
/// question, small enough for a per-interval vision request.
pub const CAPTURE_WIDTH: u32 = 1440;

/// Snapshot-visible state of the running monitor. `warning` explains the last
/// skipped interval or failure; it is cleared by the next healthy capture.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStatus {
    pub state: String,
    pub question: Option<String>,
    pub answer_cached: bool,
    pub focus: bool,
    pub typed: bool,
    pub warning: Option<String>,
    pub window: Option<usize>,
    pub executable: Option<String>,
    pub updated_at: u64,
    pub analyzed_frames: u64,
    pub solutions: u64,
}
impl MonitorStatus {
    pub fn watching() -> Self {
        Self {
            state: "watching".into(),
            question: None,
            answer_cached: false,
            focus: false,
            typed: false,
            warning: None,
            window: None,
            executable: None,
            updated_at: 0,
            analyzed_frames: 0,
            solutions: 0,
        }
    }
}

/// Messages from the monitor service to the meeting actor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MonitorUpdate {
    /// The interval produced no capture: nothing to watch, or the Copilot's own
    /// window is in front.
    Skipped { reason: String },
    /// A frame of the screen in front was captured. `changed` is false
    /// when the pixels match the previous frame and no analysis follows.
    Captured {
        window: usize,
        executable: String,
        changed: bool,
    },
    /// A changed frame was analyzed. `image` is the same PNG data URL that was
    /// sent to the analysis model, kept for solution generation.
    Analysis {
        window: usize,
        executable: String,
        image: String,
        analysis: Analysis,
    },
    /// The interval failed; the service keeps running and retries next time.
    Failed { error: String },
}

/// Starts the monitor loop for one meeting. The loop waits one interval before
/// the first capture so the user can switch to the target application.
pub fn spawn(
    client: Client,
    auth: Arc<Auth>,
    model: String,
    config: MonitorConfig,
    cancel: CancellationToken,
    updates: mpsc::Sender<MonitorUpdate>,
) {
    tauri::async_runtime::spawn(async move {
        let mut gate = ChangeGate::default();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(config.interval) => {}
            }
            if cancel.is_cancelled() {
                break;
            }
            let target = match foreground::current() {
                Some(target) => target,
                None => {
                    if !skip(&updates, "No other window is in the foreground").await {
                        break;
                    }
                    continue;
                }
            };
            let window = target.window;
            let executable = target.executable;
            let frame = match tokio::task::spawn_blocking(move || {
                capture_monitor_frame(Some(window), CAPTURE_WIDTH)
            })
            .await
            {
                Ok(Ok(frame)) => frame,
                Ok(Err(error)) => {
                    if !fail(&updates, error).await {
                        break;
                    }
                    continue;
                }
                Err(_) => {
                    if !fail(&updates, "Screen capture panicked".into()).await {
                        break;
                    }
                    continue;
                }
            };
            let changed = gate.changed(&frame.rgb);
            if updates
                .send(MonitorUpdate::Captured {
                    window,
                    executable: executable.clone(),
                    changed,
                })
                .await
                .is_err()
            {
                break;
            }
            if !changed || cancel.is_cancelled() {
                continue;
            }
            let token = match token(&auth, &client, &cancel).await {
                Ok(token) => token,
                Err(error) => {
                    if !fail(&updates, error).await {
                        break;
                    }
                    continue;
                }
            };
            let analyzed = client
                .text_with_image(
                    &token,
                    &model,
                    prompts::MONITOR_ANALYSIS,
                    "Analyze this screenshot.",
                    Some(&frame.data_url),
                    cancel.clone(),
                )
                .await;
            let analysis = match analyzed {
                Ok(raw) => match vision::parse_analysis(&raw) {
                    Ok(analysis) => analysis,
                    Err(error) => {
                        if !fail(&updates, error).await {
                            break;
                        }
                        continue;
                    }
                },
                Err(error) => {
                    if cancel.is_cancelled() {
                        break;
                    }
                    if !fail(&updates, error).await {
                        break;
                    }
                    continue;
                }
            };
            if updates
                .send(MonitorUpdate::Analysis {
                    window,
                    executable,
                    image: frame.data_url,
                    analysis,
                })
                .await
                .is_err()
            {
                break;
            }
        }
    });
}

/// Returns false when the actor stopped listening and the service should end.
async fn skip(updates: &mpsc::Sender<MonitorUpdate>, reason: &str) -> bool {
    updates
        .send(MonitorUpdate::Skipped {
            reason: reason.into(),
        })
        .await
        .is_ok()
}
async fn fail(updates: &mpsc::Sender<MonitorUpdate>, error: String) -> bool {
    if error == "cancelled" {
        return true;
    }
    updates.send(MonitorUpdate::Failed { error }).await.is_ok()
}

/// Mirrors the actor's token rule: Codex needs no bearer token.
async fn token(auth: &Arc<Auth>, client: &Client, cancel: &CancellationToken) -> Result<String, String> {
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    if !client.requires_token() {
        return Ok(String::new());
    }
    tokio::select! {
        _ = cancel.cancelled() => Err("cancelled".into()),
        token = auth.token() => token,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_defaults_to_an_idle_watching_state_with_camel_case_fields() {
        let status = MonitorStatus::watching();
        assert_eq!(status.state, "watching");
        assert!(status.question.is_none() && status.warning.is_none());
        assert!(!status.answer_cached && !status.focus && !status.typed);
        assert_eq!((status.analyzed_frames, status.solutions), (0, 0));
        let json = serde_json::to_value(&status).unwrap();
        assert!(json.get("answerCached").is_some());
        assert!(json.get("updatedAt").is_some());
        assert!(json.get("analyzedFrames").is_some());
    }

    #[test]
    fn skipped_updates_carry_a_reason() {
        let update = MonitorUpdate::Skipped {
            reason: "notepad.exe is not authorized".into(),
        };
        assert!(matches!(update, MonitorUpdate::Skipped { reason } if reason.contains("notepad")));
    }
}
