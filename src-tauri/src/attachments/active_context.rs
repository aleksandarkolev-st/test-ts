//! Local inspection only. The caller must explicitly request an attachment.
use serde::Serialize;
use std::{path::PathBuf, sync::atomic::{AtomicUsize, Ordering}};
static LAST_EXTERNAL: AtomicUsize = AtomicUsize::new(0);
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveContext {
    pub title: String,
    pub kind: String,
    pub project_path: Option<String>,
    pub source_window: usize,
}
// Remember a window handle locally, never text, screenshots, or file contents.
#[cfg(windows)]
pub fn observe_foreground() {
    use windows::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let hwnd = GetForegroundWindow(); let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if !hwnd.0.is_null() && pid != 0 && pid != std::process::id() {
            LAST_EXTERNAL.store(hwnd.0 as usize, Ordering::Release);
        }
    }
}
#[cfg(not(windows))]
pub fn observe_foreground() {}
fn existing_directory(value: &str) -> Option<PathBuf> {
    let value = value.trim().trim_start_matches("Address: ").trim_start_matches("Location: ");
    let path = if value.starts_with("file:") { url::Url::parse(value).ok()?.to_file_path().ok()? } else {
        // Never interpret an arbitrary window label or relative path as a project.
        if !(value.as_bytes().get(1)==Some(&b':') || value.starts_with("\\\\")) { return None; }
        PathBuf::from(value)
    };
    let canonical = path.canonicalize().ok()?;
    canonical.is_dir().then_some(canonical)
}
fn workspace_label_matches(title: &str, name: &str) -> bool {
    // VS Code uses `file - workspace - Visual Studio Code` (or an en dash).
    title.split(['—','–']).flat_map(|s|s.split(" - ")).any(|part|part.trim()==name)
}
fn vscode_workspaces(title: &str) -> Vec<PathBuf> {
    let mut candidates=vec![];
    let Some(appdata)=std::env::var_os("APPDATA") else{return candidates};
    for product in ["Code", "Code - Insiders", "VSCodium"] {
        let root=PathBuf::from(&appdata).join(product).join("User/workspaceStorage");
        let Ok(entries)=std::fs::read_dir(root) else{continue};
        for entry in entries.flatten().take(4000) {
            let Ok(bytes)=std::fs::read(entry.path().join("workspace.json")) else{continue};
            if bytes.len()>64*1024 {continue;}
            let Ok(data)=serde_json::from_slice::<serde_json::Value>(&bytes) else{continue};
            if let Some(folder)=data.get("folder").and_then(|s|s.as_str()).and_then(existing_directory) {
                if folder.file_name().is_some_and(|n|workspace_label_matches(title,&n.to_string_lossy())) {candidates.push(folder);}
            }
        }
    }
    candidates.sort();candidates.dedup();candidates
}
#[cfg(windows)]
pub fn detect() -> Result<ActiveContext,String> {
    use windows::Win32::{Foundation::HWND, System::Com::*, UI::{Accessibility::*,WindowsAndMessaging::*}};
    observe_foreground();
    let source_window=LAST_EXTERNAL.load(Ordering::Acquire);
    if source_window==0 {return Err("Focus VS Code, an Explorer folder, or a browser IDE, then press Ctrl Shift P".into());}
    unsafe {
        let hwnd=HWND(source_window as *mut _);
        if !IsWindow(Some(hwnd)).as_bool(){return Err("The previous context window has closed; focus the project and retry".into());}
        let mut buf=[0u16;4096];let length=GetWindowTextW(hwnd,&mut buf);
        let title=String::from_utf16_lossy(&buf[..length.max(0) as usize]);
        let lower=title.to_lowercase();
        let vscode=lower.contains("visual studio code")||lower.contains("vscodium");
        let browser=lower.contains("edge")||lower.contains("chrome")||lower.contains("firefox");
        let mut candidates=if vscode{vscode_workspaces(&title)}else{vec![]};
        if let Some(path)=existing_directory(&title){candidates.push(path);}
        // UIA is inspected on the explicit handoff, never on the idle timer.
        let initialized=CoInitializeEx(None,COINIT_MULTITHREADED).is_ok();
        {
            // Explorer's breadcrumb control may hide its actual path from UIA.
            // Query the shell view associated with this precise window instead.
            use windows::core::Interface;
            use windows::Win32::{UI::Shell::{IShellWindows,IWebBrowserApp,ShellWindows},System::Variant::VARIANT};
            if let Ok(shell)=CoCreateInstance::<_,IShellWindows>(&ShellWindows,None,CLSCTX_LOCAL_SERVER) {
                for index in 0..shell.Count().unwrap_or(0).min(256) {
                    let view=shell.Item(&VARIANT::from(index)).and_then(|item|item.cast::<IWebBrowserApp>());
                    if let Ok(view)=view {
                        if view.HWND().is_ok_and(|handle|handle.0 as usize==source_window) {
                            if let Ok(location)=view.LocationURL(){if let Some(path)=existing_directory(&location.to_string()){candidates.push(path);}}
                        }
                    }
                }
            }
            let inspected=(||->windows::core::Result<()>{
                let automation:IUIAutomation=CoCreateInstance(&CUIAutomation,None,CLSCTX_INPROC_SERVER)?;
                let root=automation.ElementFromHandle(hwnd)?;
                let nodes=root.FindAll(TreeScope_Descendants,&automation.CreateTrueCondition()?)?;
                for index in 0..nodes.Length()?.min(1500){
                    let node=nodes.GetElement(index)?;
                    let name=node.CurrentName().unwrap_or_default().to_string();
                    // Only navigation/address controls may identify an Explorer folder.
                    // Do not mistake an editor's text or a browser page body for a path.
                    if name.starts_with("Address:")||name.starts_with("Location:") {
                        if let Some(path)=existing_directory(&name){candidates.push(path);}
                    }
                    if !browser && (name.to_lowercase().contains("address")||name.to_lowercase().contains("location")) {
                        if let Ok(pattern)=node.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId){
                            if let Ok(value)=pattern.CurrentValue(){if let Some(path)=existing_directory(&value.to_string()){candidates.push(path);}}
                        }
                    }
                }
                Ok(())
            })();
            let _=inspected; // Inaccessible surfaces can still be sent as screenshots.
        }
        if initialized {CoUninitialize();}
        candidates.sort();candidates.dedup();
        if candidates.len()>1{return Err("Several project folders match this window. Choose the project folder explicitly".into());}
        Ok(ActiveContext{title,kind:if vscode{"vscode"}else if browser{"browser"}else if !candidates.is_empty(){"folder"}else{"window"}.into(),project_path:candidates.pop().map(|p|p.to_string_lossy().into_owned()),source_window})
    }
}
#[cfg(not(windows))]
pub fn detect()->Result<ActiveContext,String>{Err("Active context detection requires Windows".into())}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn workspace_names_are_exact_segments(){
        assert!(workspace_label_matches("index.ts - test-ts - Visual Studio Code","test-ts"));
        assert!(workspace_label_matches("test-ts — Visual Studio Code","test-ts"));
        assert!(!workspace_label_matches("other-test-ts - Visual Studio Code","test-ts"));
    }
    #[test]fn relative_labels_and_urls_are_not_local_folders(){
        assert!(existing_directory("src").is_none());assert!(existing_directory("https://example.com/ide").is_none());
    }
}
