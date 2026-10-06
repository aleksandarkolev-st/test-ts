#[cfg(windows)]
pub fn protect(window: &tauri::WebviewWindow) -> bool {
    unsafe {
        use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
        let Ok(raw) = window.hwnd() else { return false };
        let hwnd = HWND(raw.0);
        let mut affinity = 0;
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).is_ok()
            && GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok()
            && affinity == WDA_EXCLUDEFROMCAPTURE.0
    }
}
#[cfg(not(windows))]
pub fn protect(_: &tauri::WebviewWindow) -> bool {
    false
}
