//! Opt-in actual-app experiment. The normal WebView overlay remains in window.rs.
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use super::desktop_dc;

static CAPTURE_SUSPENSIONS: AtomicUsize = AtomicUsize::new(0);
pub struct CaptureSuspension;
impl Drop for CaptureSuspension {
    fn drop(&mut self) { CAPTURE_SUSPENSIONS.fetch_sub(1, Ordering::AcqRel); }
}
pub fn suspend_for_capture(app: &tauri::AppHandle) -> CaptureSuspension {
    CAPTURE_SUSPENSIONS.fetch_add(1, Ordering::AcqRel);
    hide(app);
    CaptureSuspension
}
pub fn create(_: &tauri::AppHandle) -> Result<bool, String> { desktop_dc::create() }
pub fn position(_: &tauri::AppHandle) -> Result<(), String> { desktop_dc::position() }
pub fn show(_: &tauri::AppHandle, hidden: &AtomicBool) {
    if !hidden.load(Ordering::Acquire) && CAPTURE_SUSPENSIONS.load(Ordering::Acquire) == 0 {
        desktop_dc::show();
    }
}
pub fn hide(_: &tauri::AppHandle) { desktop_dc::hide(); }
pub fn toggle(app: &tauri::AppHandle, hidden: &AtomicBool) {
    let hiding = !hidden.load(Ordering::Acquire);
    hidden.store(hiding, Ordering::Release);
    if hiding { hide(app); } else { show(app, hidden); }
}
pub fn set_manual(_: &tauri::AppHandle, manual: bool) {
    if manual { desktop_dc::record_error("Manual text entry is unavailable in the desktop-DC experiment"); }
}
pub fn resize(_: &tauri::AppHandle, height: f64) -> Result<(), String> { desktop_dc::resize(height) }
pub fn move_by(_: &tauri::AppHandle, dx: i32, dy: i32) -> Result<(), String> { desktop_dc::move_by(dx, dy) }
pub fn show_main(_: &tauri::AppHandle) -> Result<(), String> {
    Err("The desktop-DC experiment does not create a setup window".into())
}
pub fn toggle_main(app: &tauri::AppHandle) -> Result<(), String> { show_main(app) }
