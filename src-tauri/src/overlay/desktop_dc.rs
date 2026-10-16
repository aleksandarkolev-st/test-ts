//! Opt-in drawing experiment. This module creates no HWND and offers no capture protection.
//! It uses the real runtime's displayed state; diagnostics deliberately omit displayed text.

use crate::meeting::state::Snapshot;
use serde::Serialize;
use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock},
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{w, BOOL},
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, POINT, RECT},
        Graphics::Gdi::*,
        UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, IsWindowVisible},
    },
};

const FRAME_INTERVAL: Duration = Duration::from_millis(80);
const AUDIT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
struct Region {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    width: i32,
    height: i32,
    #[serde(rename = "coordinateSpace")]
    coordinate_space: &'static str,
}
impl Region {
    fn new(left: i32, top: i32, width: i32, height: i32) -> Self {
        Self {
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height,
            coordinate_space: "physical_desktop_pixels",
        }
    }
    fn rect(self) -> RECT {
        RECT {
            left: self.left,
            top: self.top,
            right: self.right,
            bottom: self.bottom,
        }
    }
}

#[derive(Clone, Default, PartialEq, Eq)]
struct Frame {
    revision: u64,
    status: String,
    active: bool,
    paused: bool,
    manual: bool,
    question: String,
    answer: String,
    error: Option<String>,
}
impl Frame {
    fn from_snapshot(snapshot: &Snapshot) -> Self {
        Self {
            revision: snapshot.revision,
            status: snapshot.status.clone(),
            active: snapshot.active,
            paused: snapshot.paused,
            manual: snapshot.manual,
            question: snapshot
                .question
                .as_ref()
                .map(|q| q.text.clone())
                .unwrap_or_default(),
            answer: snapshot.answer.clone(),
            error: snapshot.error.clone(),
        }
    }
    fn same_pixels(&self, other: &Self) -> bool {
        self.status == other.status
            && self.active == other.active
            && self.paused == other.paused
            && self.manual == other.manual
            && self.question == other.question
            && self.answer == other.answer
            && self.error == other.error
    }
}

struct State {
    frame: Frame,
    region: Region,
    intended_visible: bool,
    stop: bool,
    worker_running: bool,
    generation: u64,
    pixels_generation: u64,
    draw_count: u64,
    last_draw_unix_ms: Option<u64>,
    last_draw_revision: Option<u64>,
    last_state_update_unix_ms: u64,
    cleanup_requests: u64,
    last_cleanup_unix_ms: Option<u64>,
    errors: Vec<String>,
}
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    audit_path: PathBuf,
}
struct Backend {
    shared: Arc<Shared>,
    worker: JoinHandle<()>,
}
static BACKEND: OnceLock<Mutex<Option<Backend>>> = OnceLock::new();

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
fn backend() -> &'static Mutex<Option<Backend>> {
    BACKEND.get_or_init(|| Mutex::new(None))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn push_error(state: &mut State, error: String) {
    if state.errors.last() != Some(&error) {
        if state.errors.len() == 32 {
            state.errors.remove(0);
        }
        state.errors.push(error);
    }
}
fn work_area() -> Result<RECT, String> {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("Desktop DC: monitor work area unavailable".into());
        }
        Ok(info.rcWork)
    }
}
fn bounded_region(area: RECT, left: i32, top: i32, width: i32, height: i32) -> Region {
    let width = width.clamp(1, (area.right - area.left).max(1));
    let height = height.clamp(1, (area.bottom - area.top).max(1));
    Region::new(
        left.clamp(area.left, (area.right - width).max(area.left)),
        top.clamp(area.top, (area.bottom - height).max(area.top)),
        width,
        height,
    )
}
fn default_region() -> Result<Region, String> {
    let area = work_area()?;
    let width = 800.min((area.right - area.left - 48).max(1));
    let height = 400.min((area.bottom - area.top - 48).max(1));
    Ok(bounded_region(
        area,
        area.right - width - 24,
        area.bottom - height - 24,
        width,
        height,
    ))
}
fn mutate(action: impl FnOnce(&mut State)) {
    let shared = lock(backend()).as_ref().map(|b| b.shared.clone());
    if let Some(shared) = shared {
        let mut state = lock(&shared.state);
        action(&mut state);
        state.generation += 1;
        state.last_state_update_unix_ms = now_ms();
        shared.changed.notify_one();
    }
}

/// Starts only a worker thread. A false return explicitly means protection is unavailable.
pub fn create() -> Result<bool, String> {
    let mut slot = lock(backend());
    if slot.is_some() {
        return Ok(false);
    }
    let audit_path = std::env::var_os("COPILOT_DESKTOP_DC_AUDIT_PATH")
        .map(PathBuf::from)
        .unwrap_or(
            std::env::current_exe()
                .map_err(|e| e.to_string())?
                .with_extension("desktop-dc-state.json"),
        );
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            frame: Frame::from_snapshot(&Snapshot::default()),
            region: default_region()?,
            intended_visible: false,
            stop: false,
            worker_running: true,
            generation: 0,
            pixels_generation: 0,
            draw_count: 0,
            last_draw_unix_ms: None,
            last_draw_revision: None,
            last_state_update_unix_ms: now_ms(),
            cleanup_requests: 0,
            last_cleanup_unix_ms: None,
            errors: vec![],
        }),
        changed: Condvar::new(),
        audit_path,
    });
    let worker_state = shared.clone();
    let worker = thread::Builder::new()
        .name("desktop-dc-experiment".into())
        .spawn(move || run(worker_state))
        .map_err(|e| format!("Desktop DC worker: {e}"))?;
    *slot = Some(Backend { shared, worker });
    Ok(false)
}
pub fn update(snapshot: &Snapshot) {
    let frame = Frame::from_snapshot(snapshot);
    mutate(|state| {
        if !state.frame.same_pixels(&frame) {
            state.pixels_generation += 1;
        }
        state.frame = frame;
    });
}
pub fn show() {
    mutate(|state| state.intended_visible = true);
}
pub fn hide() {
    mutate(|state| state.intended_visible = false);
}
pub fn position() -> Result<(), String> {
    let region = default_region()?;
    mutate(|state| {
        state.region = region;
        state.pixels_generation += 1;
    });
    Ok(())
}
pub fn resize(height: f64) -> Result<(), String> {
    if !height.is_finite() {
        return Err("Desktop DC: height must be finite".into());
    }
    let area = work_area()?;
    mutate(|state| {
        let old = state.region;
        let height = height.clamp(100., 700.) as i32;
        state.region = bounded_region(area, old.left, old.bottom - height, old.width, height);
        state.pixels_generation += 1;
    });
    Ok(())
}
pub fn move_by(dx: i32, dy: i32) -> Result<(), String> {
    let area = work_area()?;
    mutate(|state| {
        let old = state.region;
        state.region = bounded_region(
            area,
            old.left.saturating_add(dx),
            old.top.saturating_add(dy),
            old.width,
            old.height,
        );
        state.pixels_generation += 1;
    });
    Ok(())
}
pub fn record_error(error: &str) {
    mutate(|state| push_error(state, error.into()));
}

/// Requests worker cleanup without allowing process shutdown to block indefinitely.
pub fn shutdown() {
    let Some(backend) = lock(backend()).take() else {
        return;
    };
    {
        let mut state = lock(&backend.shared.state);
        state.stop = true;
        state.intended_visible = false;
        state.generation += 1;
        backend.shared.changed.notify_one();
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while !backend.worker.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    if backend.worker.is_finished() {
        let _ = backend.worker.join();
    } else {
        let mut state = lock(&backend.shared.state);
        push_error(
            &mut state,
            "Desktop DC worker exceeded bounded shutdown wait".into(),
        );
        eprintln!("Desktop DC worker exceeded bounded shutdown wait");
    }
}

struct ScreenDc {
    dc: HDC,
    saved: i32,
}
impl ScreenDc {
    fn acquire(region: Region) -> Result<Self, String> {
        unsafe {
            let dc = GetDC(None);
            if dc.is_invalid() {
                return Err("Desktop DC: GetDC(NULL) failed".into());
            }
            let saved = SaveDC(dc);
            if saved == 0 {
                ReleaseDC(None, dc);
                return Err("Desktop DC: SaveDC failed".into());
            }
            if IntersectClipRect(dc, region.left, region.top, region.right, region.bottom).0
                == ERROR
            {
                RestoreDC(dc, saved);
                ReleaseDC(None, dc);
                return Err("Desktop DC: bounded clipping failed".into());
            }
            if SetBkMode(dc, TRANSPARENT) == 0 {
                RestoreDC(dc, saved);
                ReleaseDC(None, dc);
                return Err("Desktop DC: transparent text mode unavailable".into());
            }
            Ok(Self { dc, saved })
        }
    }
}
impl Drop for ScreenDc {
    fn drop(&mut self) {
        unsafe {
            RestoreDC(self.dc, self.saved);
            ReleaseDC(None, self.dc);
        }
    }
}
struct Font(HFONT);
impl Font {
    fn new(height: i32, weight: i32) -> Result<Self, String> {
        let font = unsafe {
            CreateFontW(
                -height,
                0,
                0,
                0,
                weight,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                ANTIALIASED_QUALITY,
                (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
                w!("Segoe UI"),
            )
        };
        if font.is_invalid() {
            Err("Desktop DC: font creation failed".into())
        } else {
            Ok(Self(font))
        }
    }
}
impl Drop for Font {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}

fn draw_text(
    dc: HDC,
    font: &Font,
    color: COLORREF,
    text: &str,
    rect: &mut RECT,
) -> Result<i32, String> {
    let bounded: String = text.chars().take(6000).collect();
    let mut text: Vec<u16> = bounded.encode_utf16().collect();
    if text.is_empty() {
        return Ok(0);
    }
    unsafe {
        let old_font = SelectObject(dc, font.0.into());
        if old_font.is_invalid() {
            return Err("Desktop DC: selecting font failed".into());
        }
        if SetTextColor(dc, color).0 == CLR_INVALID {
            SelectObject(dc, old_font);
            return Err("Desktop DC: setting text color failed".into());
        }
        let height = DrawTextW(
            dc,
            &mut text,
            rect,
            DT_LEFT | DT_TOP | DT_WORDBREAK | DT_NOPREFIX,
        );
        SelectObject(dc, old_font);
        if height == 0 {
            Err("Desktop DC: DrawTextW failed".into())
        } else {
            Ok(height)
        }
    }
}
fn paint(frame: &Frame, region: Region, title_font: &Font, body_font: &Font) -> Result<(), String> {
    let dc = ScreenDc::acquire(region)?;
    let mut line = RECT {
        left: region.left + 8,
        top: region.top + 8,
        right: region.right - 8,
        bottom: region.bottom - 8,
    };
    let status = format!(
        "Meeting Copilot · {}{}",
        if frame.paused {
            "Paused"
        } else {
            &frame.status
        },
        if frame.active {
            " · session active"
        } else {
            " · no active meeting"
        }
    );
    let height = draw_text(dc.dc, title_font, COLORREF(0x00ffff00), &status, &mut line)?;
    line.top += height + 8;
    let body = if !frame.answer.is_empty() {
        format!("{}\n\n{}", frame.question, frame.answer)
    } else if !frame.question.is_empty() {
        format!("{}\n\nWaiting for the answer…", frame.question)
    } else if let Some(error) = &frame.error {
        format!("Needs attention: {error}")
    } else if frame.active {
        "Listening for a question.\nCtrl Shift M pauses or resumes this meeting.".into()
    } else {
        "Ready when you are.\nCtrl Shift F10 starts or stops the meeting using its saved settings."
            .into()
    };
    let help = "\n\nDesktop DC experiment · capture protection unavailable\nCtrl Shift H: hide/show · Ctrl Alt arrows: move\nCtrl Shift F10: start/stop meeting · Ctrl Shift F11: exit\nRead-only output; manual typing is unsupported in this backend.";
    if line.top < line.bottom {
        draw_text(
            dc.dc,
            body_font,
            COLORREF(0x00ffffff),
            &(body + help),
            &mut line,
        )?;
    }
    unsafe {
        let _ = GdiFlush();
    }
    Ok(())
}

/// Ask underlying existing windows to repaint; never paste a saved, stale desktop bitmap.
fn restore_region(region: Region) {
    unsafe extern "system" fn redraw_existing(hwnd: HWND, param: LPARAM) -> BOOL {
        unsafe {
            let region = &*(param.0 as *const RECT);
            let mut rect = RECT::default();
            if IsWindowVisible(hwnd).as_bool()
                && GetWindowRect(hwnd, &mut rect).is_ok()
                && rect.left < region.right
                && rect.right > region.left
                && rect.top < region.bottom
                && rect.bottom > region.top
            {
                let mut top_left = POINT {
                    x: region.left.max(rect.left),
                    y: region.top.max(rect.top),
                };
                let mut bottom_right = POINT {
                    x: region.right.min(rect.right),
                    y: region.bottom.min(rect.bottom),
                };
                if ScreenToClient(hwnd, &mut top_left).as_bool()
                    && ScreenToClient(hwnd, &mut bottom_right).as_bool()
                {
                    let update = RECT {
                        left: top_left.x,
                        top: top_left.y,
                        right: bottom_right.x,
                        bottom: bottom_right.y,
                    };
                    let _ = RedrawWindow(
                        Some(hwnd),
                        Some(&update),
                        None,
                        RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN,
                    );
                }
            }
            BOOL(1)
        }
    }
    unsafe {
        let rect = region.rect();
        let _ = RedrawWindow(
            None,
            Some(&rect),
            None,
            RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN,
        );
        let _ = EnumWindows(Some(redraw_existing), LPARAM(&rect as *const RECT as isize));
    }
}

fn write_audit(shared: &Shared) -> Result<(), String> {
    let state = lock(&shared.state);
    let document = serde_json::json!({
        "schemaVersion": 1, "backend": "desktop_dc_experiment", "processId": std::process::id(),
        "timestampEpochMillis": now_ms(), "workerRunning": state.worker_running,
        "shutdownRequested": state.stop, "intendedVisible": state.intended_visible, "region": state.region,
        "state": { "revision": state.frame.revision, "status": state.frame.status,
            "active": state.frame.active, "paused": state.frame.paused, "manual": state.frame.manual,
            "questionChars": state.frame.question.chars().count(), "answerChars": state.frame.answer.chars().count() },
        "drawCount": state.draw_count, "lastDrawUnixMs": state.last_draw_unix_ms,
        "lastDrawRevision": state.last_draw_revision, "lastStateUpdateUnixMs": state.last_state_update_unix_ms,
        "cleanupRequests": state.cleanup_requests, "lastCleanupUnixMs": state.last_cleanup_unix_ms,
        "errors": state.errors, "createdWindows": 0, "nativeRendererCreatesHwnd": false,
        "protectionSupported": false, "manualEntrySupported": false,
        "scope": "Renderer metadata and successful GDI calls only; physical visibility and capture omission require independent measurement. Framework and setup HWNDs are outside createdWindows."
    });
    drop(state);
    let bytes = serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?;
    if let Some(parent) = shared
        .audit_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = shared
        .audit_path
        .with_extension(format!("tmp-{}", std::process::id()));
    let mut file = File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_data())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, &shared.audit_path).map_err(|e| e.to_string())
}
fn run(shared: Arc<Shared>) {
    let fonts = Font::new(26, FW_SEMIBOLD.0 as i32)
        .and_then(|title| Font::new(23, FW_NORMAL.0 as i32).map(|body| (title, body)));
    let mut painted: Option<(Region, u64)> = None;
    let mut last_audit = Instant::now() - AUDIT_INTERVAL;
    let mut audited_generation = u64::MAX;
    loop {
        let (frame, region, visible, stop, generation, pixels_generation) = {
            let state = lock(&shared.state);
            (
                state.frame.clone(),
                state.region,
                state.intended_visible,
                state.stop,
                state.generation,
                state.pixels_generation,
            )
        };
        if painted.is_some_and(|(old, pixels)| {
            stop || !visible || old != region || pixels != pixels_generation
        }) {
            let (old, _) = painted.take().unwrap();
            restore_region(old);
            let mut state = lock(&shared.state);
            state.cleanup_requests += 1;
            state.last_cleanup_unix_ms = Some(now_ms());
        }
        if stop {
            lock(&shared.state).worker_running = false;
        }
        if !stop && visible {
            let result = match &fonts {
                Ok((title, body)) => paint(&frame, region, title, body),
                Err(error) => Err(error.clone()),
            };
            let mut state = lock(&shared.state);
            match result {
                Ok(()) => {
                    state.draw_count += 1;
                    state.last_draw_unix_ms = Some(now_ms());
                    state.last_draw_revision = Some(frame.revision);
                    painted = Some((region, pixels_generation));
                }
                Err(error) => push_error(&mut state, error),
            }
        }
        if stop || generation != audited_generation || last_audit.elapsed() >= AUDIT_INTERVAL {
            if let Err(error) = write_audit(&shared) {
                let message = format!("Desktop DC audit write: {error}");
                eprintln!("{message}");
                push_error(&mut lock(&shared.state), message);
            }
            audited_generation = generation;
            last_audit = Instant::now();
        }
        if stop {
            break;
        }
        let state = lock(&shared.state);
        if !state.stop {
            drop(
                shared
                    .changed
                    .wait_timeout(state, FRAME_INTERVAL)
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            );
        }
    }
}
