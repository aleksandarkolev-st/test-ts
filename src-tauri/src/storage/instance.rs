// A single process owns token rotation and the local host registration.
// Presence of a named mutex is sufficient; no thread needs to wait on it.
#[cfg(windows)]
pub struct InstanceLock {
    mutex: windows::Win32::Foundation::HANDLE,
    activation: windows::Win32::Foundation::HANDLE,
}
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
            Win32::{Foundation::*, System::Threading::{CreateMutexW, CreateEventW, SetEvent}},
        };
        let digest = Sha256::digest(scope.as_bytes());
        let key = format!("Local\\MeetingCopilot-{:x}", digest);
        let wide: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
        let activation_name: Vec<u16> = format!("{key}-activate").encode_utf16().chain(Some(0)).collect();
        unsafe {
            let activation = CreateEventW(None, false, false, PCWSTR(activation_name.as_ptr()))
                .map_err(|_| "Could not create the window activation event".to_string())?;
            let handle = CreateMutexW(None, false, PCWSTR(wide.as_ptr()))
                .map_err(|_| { let _ = CloseHandle(activation); "Could not protect the credential session".to_string() })?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let requested = SetEvent(activation);
                let _ = CloseHandle(activation);
                let _ = CloseHandle(handle);
                requested.map_err(|_| "Could not request the existing setup window".to_string())?;
                Ok(None)
            } else {
                Ok(Some(Self { mutex: handle, activation }))
            }
        }
    }
    pub fn take_activation_request(&self) -> bool {
        unsafe {
            windows::Win32::System::Threading::WaitForSingleObject(self.activation, 0)
                == windows::Win32::Foundation::WAIT_OBJECT_0
        }
    }
}
#[cfg(windows)]
impl Drop for InstanceLock {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.activation);
            let _ = windows::Win32::Foundation::CloseHandle(self.mutex);
        }
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn excludes_a_second_process_owner_and_releases_on_exit() {
        let scope = uuid::Uuid::new_v4().to_string();
        let first = super::InstanceLock::acquire(&scope).unwrap().unwrap();
        assert!(!first.take_activation_request());
        assert!(super::InstanceLock::acquire(&scope).unwrap().is_none());
        assert!(first.take_activation_request());
        assert!(!first.take_activation_request());
        drop(first);
        assert!(super::InstanceLock::acquire(&scope).unwrap().is_some());
    }
}
