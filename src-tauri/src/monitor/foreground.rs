//! Foreground window identity for the screen monitor. Only the executable
//! basename and the window handle leave this module; no titles, paths, or
//! process contents are retained.
//!
//! The Copilot's own windows are never a target: when the app itself is in the
//! foreground, `current()` reports nothing so the monitor skips the interval.

/// The window that currently has focus and the basename of its process image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Foreground {
    pub window: usize,
    pub executable: String,
}

/// Lowercased executable basename of a process image path, as reported in
/// [`Foreground::executable`].
pub fn executable_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

#[cfg(windows)]
pub fn current() -> Option<Foreground> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut image = [0u16; 32768];
        let mut length = image.len() as u32;
        let queried = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(image.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        queried.ok()?;
        let executable = executable_name(&String::from_utf16_lossy(&image[..length as usize]));
        if executable.is_empty() {
            return None;
        }
        Some(Foreground {
            window: hwnd.0 as usize,
            executable,
        })
    }
}

#[cfg(not(windows))]
pub fn current() -> Option<Foreground> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_names_are_lowercased_basenames() {
        assert_eq!(executable_name("C:\\Program Files\\Notepad++\\NOTEPAD++.EXE"), "notepad++.exe");
        assert_eq!(executable_name("notepad.exe"), "notepad.exe");
        assert_eq!(executable_name("C:\\Windows\\explorer.exe"), "explorer.exe");
        assert_eq!(executable_name(""), "");
    }
}
