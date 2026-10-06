#[cfg(windows)]
use crate::process::ProcessJob;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    running: bool,
    loading: bool,
    calibrated: bool,
    camera_calibrated: bool,
    calibrating: Option<String>,
    face: bool,
    correcting: bool,
    message: String,
    error: Option<String>,
    preview: Option<String>,
    device: String,
    camera: String,
    fps: f64,
    frame_age_ms: f64,
    frame_age_p95_ms: f64,
    vertical: f64,
    horizontal: f64,
}
struct Shared {
    view: Mutex<View>,
    epoch: AtomicU64,
    app: tauri::AppHandle,
}
impl Shared {
    fn publish(&self) {
        let view = self.view.lock().unwrap().clone();
        let _ = self.app.emit("copilot:gaze", view);
    }
}
struct Worker {
    child: Child,
    #[cfg(windows)]
    _job: ProcessJob,
}
impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(mut input) = self.child.stdin.take() {
            let _ = input.write_all(b"{\"command\":\"stop\"}\n");
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub struct Runtime {
    shared: Arc<Shared>,
    worker: Mutex<Option<Worker>>,
    executable: PathBuf,
    script: Option<PathBuf>,
    models: PathBuf,
}
impl Runtime {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, tauri::Error> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let development = cfg!(debug_assertions) && root.join("camera/gaze_worker.py").is_file();
        let (executable, script, models) = if development {
            (
                root.join(".local/gaze-runtime/Scripts/python.exe"),
                Some(root.join("camera/gaze_worker.py")),
                root.join("models/gaze"),
            )
        } else {
            (
                app.path()
                    .resolve("gaze/gaze-worker.exe", tauri::path::BaseDirectory::Resource)?,
                None,
                app.path()
                    .resolve("models/gaze", tauri::path::BaseDirectory::Resource)?,
            )
        };
        Ok(Self {
            shared: Arc::new(Shared {
                view: Mutex::new(View {
                    message: "Start the camera to preview and calibrate correction.".into(),
                    ..Default::default()
                }),
                epoch: AtomicU64::new(0),
                app: app.clone(),
            }),
            worker: Mutex::new(None),
            executable,
            script,
            models,
        })
    }
    fn command(&self) -> Result<Command, String> {
        if !self.executable.is_file() {
            return Err("Camera runtime is missing from this build".into());
        }
        let mut command = Command::new(&self.executable);
        if let Some(script) = &self.script {
            command.arg(script);
        }
        command
            .arg("--models")
            .arg(&self.models)
            .env("PYTHONUNBUFFERED", "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        Ok(command)
    }
    fn stop(&self) {
        let mut owner = self.worker.lock().unwrap();
        self.shared.epoch.fetch_add(1, Ordering::AcqRel);
        let old = owner.take();
        drop(old);
        *self.shared.view.lock().unwrap() = View {
            message: "Camera stopped. Calibration and preview cleared.".into(),
            ..Default::default()
        };
        self.shared.publish();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    camera: u32,
    device: u32,
    strength: f64,
}

#[tauri::command]
pub fn gaze_snapshot(gaze: State<'_, Runtime>) -> View {
    gaze.shared.view.lock().unwrap().clone()
}

#[tauri::command]
pub async fn gaze_devices(gaze: State<'_, Runtime>) -> Result<Value, String> {
    let mut command = gaze.command()?;
    command
        .arg("--list-devices")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    tokio::task::spawn_blocking(move || {
        let output = command
            .output()
            .map_err(|_| "Cannot inspect local camera devices".to_string())?;
        if !output.status.success() {
            return Err("Camera device inspection failed".into());
        }
        let value: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| "Invalid camera device list".to_string())?;
        if value["event"] != "devices" {
            return Err("Invalid camera device list".into());
        }
        Ok(value)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn gaze_start(gaze: State<'_, Runtime>, settings: Settings) -> Result<(), String> {
    if settings.camera > 64
        || settings.device > 32
        || !settings.strength.is_finite()
        || !(0.0..=15.0).contains(&settings.strength)
    {
        return Err("Choose a valid camera, GPU and correction from 0 to 15 degrees".into());
    }
    let mut owner = gaze.worker.lock().unwrap();
    if let Some(worker) = owner.as_mut() {
        if worker
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Err("Camera is already running".into());
        }
    }
    let old = owner.take();
    drop(old);
    let mut command = gaze.command()?;
    command
        .arg("--camera")
        .arg(settings.camera.to_string())
        .arg("--device")
        .arg(settings.device.to_string())
        .arg("--strength")
        .arg(settings.strength.to_string())
        .arg("--preview")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start the local camera process".to_string())?;
    #[cfg(windows)]
    let job = match ProcessJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or("Camera status channel is unavailable")?;
    let epoch = gaze.shared.epoch.fetch_add(1, Ordering::AcqRel) + 1;
    *gaze.shared.view.lock().unwrap() = View {
        loading: true,
        message: "Opening camera and local models…".into(),
        ..Default::default()
    };
    *owner = Some(Worker {
        child,
        #[cfg(windows)]
        _job: job,
    });
    gaze.shared.publish();
    let shared = gaze.shared.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            if reader
                .read_line(&mut line)
                .ok()
                .is_none_or(|count| count == 0)
            {
                break;
            }
            if shared.epoch.load(Ordering::Acquire) != epoch {
                break;
            }
            if line.len() > 1024 * 1024 {
                break;
            }
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let mut view = shared.view.lock().unwrap();
            if shared.epoch.load(Ordering::Acquire) != epoch {
                break;
            }
            match event["event"].as_str() {
                Some("ready") => {
                    view.running = true;
                    view.loading = false;
                    view.device = event["device"]["name"]
                        .as_str()
                        .unwrap_or("DirectML")
                        .into();
                    view.camera = event["cameraName"].as_str().unwrap_or("Camera").into();
                    view.message =
                        "Look at the camera and calibrate, then calibrate while reading notes."
                            .into();
                }
                Some("state") => {
                    view.face = event["face"].as_bool().unwrap_or(false);
                    view.camera_calibrated = event["cameraCalibrated"].as_bool().unwrap_or(false);
                    view.calibrated = event["calibrated"].as_bool().unwrap_or(false);
                    view.calibrating = event["calibrating"].as_str().map(str::to_string);
                    view.correcting = event["correcting"].as_bool().unwrap_or(false);
                    view.message = event["message"].as_str().unwrap_or("").into();
                    view.fps = event["fps"].as_f64().unwrap_or(0.);
                    view.frame_age_ms = event["frameAgeMs"].as_f64().unwrap_or(0.);
                    view.frame_age_p95_ms = event["frameAgeP95Ms"].as_f64().unwrap_or(0.);
                    view.vertical = event["vertical"].as_f64().unwrap_or(0.);
                    view.horizontal = event["horizontal"].as_f64().unwrap_or(0.);
                }
                Some("preview") => {
                    view.preview = event["image"]
                        .as_str()
                        .filter(|image| image.starts_with("data:image/jpeg;base64,"))
                        .map(str::to_string);
                }
                Some("error") => {
                    view.error = Some(event["message"].as_str().unwrap_or("Camera failed").into());
                }
                Some("stopped") => {
                    view.running = false;
                    view.loading = false;
                    view.preview = None;
                    view.calibrated = false;
                    view.camera_calibrated = false;
                    view.calibrating = None;
                    view.face = false;
                    view.correcting = false;
                }
                _ => {}
            }
            drop(view);
            shared.publish();
        }
        if shared.epoch.load(Ordering::Acquire) == epoch {
            let mut view = shared.view.lock().unwrap();
            if shared.epoch.load(Ordering::Acquire) != epoch {
                return;
            }
            if (view.running || view.loading) && view.error.is_none() {
                view.error = Some("Camera process stopped unexpectedly".into());
            }
            view.running = false;
            view.loading = false;
            view.preview = None;
            view.calibrated = false;
            view.camera_calibrated = false;
            view.calibrating = None;
            view.face = false;
            view.correcting = false;
            drop(view);
            shared.publish();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn gaze_control(
    gaze: State<'_, Runtime>,
    action: String,
    strength: Option<f64>,
    enabled: Option<bool>,
) -> Result<(), String> {
    if !["calibrate_camera", "calibrate_notes", "configure"].contains(&action.as_str()) {
        return Err("Unknown camera control".into());
    }
    if strength.is_some_and(|s| !s.is_finite() || !(0.0..=15.0).contains(&s)) {
        return Err("Correction must be from 0 to 15 degrees".into());
    }
    let mut owner = gaze.worker.lock().unwrap();
    let worker = owner.as_mut().ok_or("Start the camera first")?;
    let mut message = json!({"command":action});
    if let Some(s) = strength {
        message["strength"] = json!(s);
    }
    if let Some(e) = enabled {
        message["enabled"] = json!(e);
    }
    let bytes = format!("{message}\n");
    worker
        .child
        .stdin
        .as_mut()
        .ok_or("Camera control channel closed")?
        .write_all(bytes.as_bytes())
        .map_err(|_| "Camera control channel closed".into())
}

#[tauri::command]
pub async fn gaze_stop(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || app.state::<Runtime>().stop())
        .await
        .map_err(|e| e.to_string())
}
