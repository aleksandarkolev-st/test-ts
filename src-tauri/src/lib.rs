pub mod audio;
pub mod attachments;
pub mod meeting;
pub mod openai;
pub mod overlay;
pub mod storage;
pub mod transcription;
mod process;
mod gaze;

pub fn run() {
    runtime::run();
}
mod runtime;
