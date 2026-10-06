use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
pub fn create(app: &tauri::AppHandle) -> Result<bool, String> {
    let window = WebviewWindowBuilder::new(
        app,
        "overlay",
        WebviewUrl::App("index.html?view=overlay".into()),
    )
    .title("Meeting Copilot Overlay")
    .inner_size(520., 140.)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    let protection = super::capture_protection::protect(&window);
    position(app)?;
    set_manual(app, false);
    Ok(protection)
}
pub fn position(app: &tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("overlay")
        .ok_or("Overlay window missing")?;
    #[cfg(windows)]
    unsafe {
        use windows::Win32::{Foundation::HWND, Graphics::Gdi::*};
        let hwnd = HWND(w.hwnd().map_err(|e| e.to_string())?.0);
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let size = w.outer_size().map_err(|e| e.to_string())?;
            w.set_position(tauri::PhysicalPosition::new(
                info.rcWork.right - size.width as i32 - 24,
                info.rcWork.bottom - size.height as i32 - 24,
            ))
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn show(app: &tauri::AppHandle, hidden: &AtomicBool) {
    if hidden.load(Ordering::Acquire) {
        return;
    }
    if let Some(w) = app.get_webview_window("overlay") {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
            if let Ok(raw) = w.hwnd() {
                let hwnd = HWND(raw.0);
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
        #[cfg(not(windows))]
        let _ = w.show();
    }
}
pub fn hide(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
            if let Ok(raw) = w.hwnd() {
                let _ = ShowWindow(HWND(raw.0), SW_HIDE);
            }
        }
        #[cfg(not(windows))]
        let _ = w.hide();
    }
}
pub fn toggle(app: &tauri::AppHandle, hidden: &AtomicBool) {
    let hiding = !hidden.load(Ordering::Acquire);
    hidden.store(hiding, Ordering::Release);
    if hiding {
        hide(app)
    } else {
        show(app, hidden)
    }
}
pub fn set_manual(app: &tauri::AppHandle, manual: bool) {
    if let Some(w) = app.get_webview_window("overlay") {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
            if let Ok(raw) = w.hwnd() {
                let hwnd = HWND(raw.0);
                let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let new = if manual {
                    style & !(WS_EX_NOACTIVATE.0 as isize)
                } else {
                    style | WS_EX_NOACTIVATE.0 as isize
                };
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
            }
        }
        if manual {
            let _ = w.set_focus();
        }
    }
}
pub fn resize(app: &tauri::AppHandle, height: f64) -> Result<(), String> {
    let w = app.get_webview_window("overlay").ok_or("Overlay missing")?;
    let height = height.clamp(100., 700.);
    let old = w.outer_size().map_err(|e| e.to_string())?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    w.set_size(tauri::LogicalSize::new(520., height))
        .map_err(|e| e.to_string())?;
    let new = w.outer_size().map_err(|e| e.to_string())?;
    w.set_position(tauri::PhysicalPosition::new(
        pos.x,
        (pos.y + old.height as i32 - new.height as i32).max(0),
    ))
    .map_err(|e| e.to_string())
}
