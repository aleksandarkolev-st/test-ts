use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
pub fn show_main(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Setup window missing")?;
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE},
        };
        let hwnd = HWND(window.hwnd().map_err(|error| error.to_string())?.0);
        // Restore without activating; raise() performs the foreground grab.
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())
    }
}
/// Brings the setup window to the front and gives it focus. Used when the user
/// explicitly asks for it (Ctrl+Shift+F9 or launching a second instance), where
/// stealing focus is the expected outcome.
pub fn raise_main(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Setup window missing")?;
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{
                SetForegroundWindow, SetWindowPos, ShowWindow, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE,
                SWP_SHOWWINDOW, SW_RESTORE,
            },
        };
        let hwnd = HWND(window.hwnd().map_err(|error| error.to_string())?.0);
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
            let _ = SetForegroundWindow(hwnd);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())
    }
}
pub fn toggle_main(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Setup window missing")?;
    let visible = window.is_visible().map_err(|error| error.to_string())?;
    let minimized = window.is_minimized().map_err(|error| error.to_string())?;
    if visible && !minimized {
        window.hide().map_err(|error| error.to_string())
    } else {
        raise_main(app)
    }
}
pub fn create(app: &tauri::AppHandle) -> Result<bool, String> {
    let window = WebviewWindowBuilder::new(
        app,
        "overlay",
        WebviewUrl::App("index.html?view=overlay".into()),
    )
    .title("wavesSvc64")
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
    set_manual(app, false);
    let protection = super::capture_protection::protect(&window);
    position(app)?;
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
    if hidden.load(Ordering::Acquire) || CAPTURE_SUSPENSIONS.load(Ordering::Acquire) > 0 {
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
                // Keep a top-level HWND for display affinity while excluding it from Alt+Tab.
                let style = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
                    | WS_EX_TOOLWINDOW.0 as isize)
                    & !(WS_EX_APPWINDOW.0 as isize);
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
fn bounded_position(x:i32,y:i32,width:i32,height:i32,left:i32,top:i32,right:i32,bottom:i32)->(i32,i32){
    (x.clamp(left,(right-width).max(left)),y.clamp(top,(bottom-height).max(top)))
}
/// Move setup when it has focus, otherwise move the interview overlay.
pub fn move_by(app:&tauri::AppHandle,dx:i32,dy:i32)->Result<(),String>{
    let main=app.get_webview_window("main").ok_or("Main window missing")?;
    let w=if main.is_focused().unwrap_or(false){main}else{app.get_webview_window("overlay").ok_or("Overlay missing")?};
    let pos=w.outer_position().map_err(|e|e.to_string())?;
    let size=w.outer_size().map_err(|e|e.to_string())?;
    let scale=w.scale_factor().unwrap_or(1.);
    let mut x=pos.x+(dx as f64*scale).round()as i32;let mut y=pos.y+(dy as f64*scale).round()as i32;
    #[cfg(windows)]unsafe{
        use windows::Win32::{Foundation::HWND,Graphics::Gdi::*};
        let monitor=MonitorFromWindow(HWND(w.hwnd().map_err(|e|e.to_string())?.0),MONITOR_DEFAULTTONEAREST);
        let mut info=MONITORINFO{cbSize:std::mem::size_of::<MONITORINFO>()as u32,..Default::default()};
        if !GetMonitorInfoW(monitor,&mut info).as_bool(){return Err("Could not inspect the window monitor".into());}
        (x,y)=bounded_position(x,y,size.width as i32,size.height as i32,info.rcWork.left,info.rcWork.top,info.rcWork.right,info.rcWork.bottom);
    }
    w.set_position(tauri::PhysicalPosition::new(x,y)).map_err(|e|e.to_string())
}
#[cfg(test)]mod movement_tests{
    use super::bounded_position;
    #[test]fn clamps_to_work_area_including_negative_monitor_coordinates(){
        assert_eq!(bounded_position(-2000,900,520,140,-1920,0,0,1040),(-1920,900));
        assert_eq!(bounded_position(0,2000,520,140,-1920,0,0,1040),(-520,900));
        assert_eq!(bounded_position(40,-80,2000,2000,0,0,1920,1080),(0,0));
    }
}
