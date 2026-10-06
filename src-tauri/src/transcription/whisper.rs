use std::sync::Arc;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};
pub fn load(path: &str) -> Result<Arc<WhisperContext>, String> {
    // Upstream debug logs can include recognized tokens. Keep all transcript
    // content out of stdout, stderr and persistent application logs.
    whisper_rs::install_logging_hooks();
    // Search only beside our executable, never the user's current directory.
    // GGML's dispatcher checks both CPU features and operating-system support.
    static BACKENDS: std::sync::Once = std::sync::Once::new();
    BACKENDS.call_once(|| {
        let dir = std::env::current_exe().expect("Executable path");
        let dir =
            std::ffi::CString::new(dir.parent().unwrap().to_string_lossy().as_bytes()).unwrap();
        unsafe {
            whisper_rs::whisper_rs_sys::ggml_backend_load_all_from_path(dir.as_ptr());
        }
    });
    if !std::path::Path::new(path).is_file() {
        return Err("Choose a local whisper.cpp model before starting a meeting".into());
    }
    let mut p = WhisperContextParameters::default();
    p.use_gpu(false);
    WhisperContext::new_with_params(path, p)
        .map(Arc::new)
        .map_err(|e| format!("Could not load local Whisper model: {e}"))
}
pub fn transcribe(state: &mut WhisperState, samples: &[f32]) -> Result<String, String> {
    transcribe_cancellable(state, samples, None)
}
pub fn transcribe_cancellable(
    state: &mut WhisperState,
    samples: &[f32],
    stop: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    transcribe_interruptible(state, samples, stop, None)
}
pub fn transcribe_interruptible(
    state: &mut WhisperState,
    samples: &[f32],
    stop: Option<&std::sync::atomic::AtomicBool>,
    superseded: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    struct AbortFlags<'a> {
        stop: Option<&'a std::sync::atomic::AtomicBool>,
        superseded: Option<&'a std::sync::atomic::AtomicBool>,
    }
    let abort_flags = AbortFlags { stop, superseded };
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    if stop.is_some() || superseded.is_some() {
        unsafe extern "C" fn aborted(data: *mut std::ffi::c_void) -> bool {
            // Both flags and this stack struct live for the entire synchronous
            // Whisper call. No callback pointer survives `state.full`.
            unsafe {
                let flags = &*data.cast::<AbortFlags<'_>>();
                [flags.stop, flags.superseded]
                    .iter()
                    .any(|flag| flag.is_some_and(|f| f.load(std::sync::atomic::Ordering::Acquire)))
            }
        }
        unsafe {
            p.set_abort_callback(Some(aborted));
            p.set_abort_callback_user_data(
                (&abort_flags as *const AbortFlags<'_>).cast_mut().cast(),
            );
        }
    }
    p.set_language(Some("en"));
    p.set_n_threads(
        (std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            / 2)
        .clamp(1, 8) as i32,
    );
    p.set_no_context(true);
    p.set_single_segment(true);
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    state
        .full(p, samples)
        .map_err(|e| format!("Local transcription failed: {e}"))?;
    let text = state
        .as_iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if matches!(
        text.as_str(),
        "[BLANK_AUDIO]" | "[ Silence ]" | "(silence)" | "[Music]" | "[MUSIC]"
    ) {
        Ok(String::new())
    } else {
        Ok(text)
    }
}
