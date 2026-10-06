// A single process owns token rotation and the local host registration.
// Presence of a named mutex is sufficient; no thread needs to wait on it.
#[cfg(windows)]
pub struct InstanceLock(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for InstanceLock {}
#[cfg(windows)]
unsafe impl Sync for InstanceLock {}
#[cfg(windows)]
impl InstanceLock {
    pub fn acquire(scope: &str) -> Result<Option<Self>, String> {
        use sha2::{Digest, Sha256};
        use windows::{
            core::PCWSTR,
            Win32::{Foundation::*, System::Threading::CreateMutexW},
        };
        let digest = Sha256::digest(scope.as_bytes());
        let key = format!("Local\\MeetingCopilot-{:x}", digest);
        let wide: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let handle = CreateMutexW(None, false, PCWSTR(wide.as_ptr()))
                .map_err(|_| "Could not protect the credential session".to_string())?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(handle);
                Ok(None)
            } else {
                Ok(Some(Self(handle)))
            }
        }
    }
}
#[cfg(windows)]
impl Drop for InstanceLock {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn excludes_a_second_process_owner_and_releases_on_exit() {
        let scope = uuid::Uuid::new_v4().to_string();
        let first = super::InstanceLock::acquire(&scope).unwrap().unwrap();
        assert!(super::InstanceLock::acquire(&scope).unwrap().is_none());
        drop(first);
        assert!(super::InstanceLock::acquire(&scope).unwrap().is_some());
    }
}
