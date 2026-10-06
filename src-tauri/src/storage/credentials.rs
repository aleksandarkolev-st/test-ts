// Windows generic credentials have a 2560 byte blob limit. Versioned chunks
// make the final manifest write the commit point; failed updates leave the
// previously committed credentials readable.
#[cfg(windows)]
mod native {
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{Foundation::ERROR_NOT_FOUND, Security::Credentials::*},
    };
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    pub fn read(key: &str) -> Result<Option<Vec<u8>>, String> {
        unsafe {
            let key = wide(key);
            let mut ptr = std::ptr::null_mut();
            match CredReadW(PCWSTR(key.as_ptr()), CRED_TYPE_GENERIC, None, &mut ptr) {
                Ok(()) => {
                    let data = if (*ptr).CredentialBlobSize == 0 {
                        Vec::new()
                    } else {
                        std::slice::from_raw_parts(
                            (*ptr).CredentialBlob,
                            (*ptr).CredentialBlobSize as usize,
                        )
                        .to_vec()
                    };
                    CredFree(ptr.cast());
                    Ok(Some(data))
                }
                Err(e) if e.code() == windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0) => {
                    Ok(None)
                }
                Err(_) => Err("Windows Credential Manager could not read credentials".into()),
            }
        }
    }
    pub fn write(key: &str, data: &[u8]) -> Result<(), String> {
        unsafe {
            let mut key = wide(key);
            let mut user = wide("Meeting Copilot");
            let mut blob = data.to_vec();
            let cred = CREDENTIALW {
                Type: CRED_TYPE_GENERIC,
                TargetName: PWSTR(key.as_mut_ptr()),
                CredentialBlobSize: blob.len() as u32,
                CredentialBlob: blob.as_mut_ptr(),
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                UserName: PWSTR(user.as_mut_ptr()),
                ..Default::default()
            };
            CredWriteW(&cred, 0)
                .map_err(|_| "Windows Credential Manager could not save credentials".into())
        }
    }
    pub fn delete(key: &str) {
        unsafe {
            let key = wide(key);
            let _ = CredDeleteW(PCWSTR(key.as_ptr()), CRED_TYPE_GENERIC, None);
        }
    }
}
#[cfg(not(windows))]
mod native {
    pub fn read(_: &str) -> Result<Option<Vec<u8>>, String> {
        Err("Windows required".into())
    }
    pub fn write(_: &str, _: &[u8]) -> Result<(), String> {
        Err("Windows required".into())
    }
    pub fn delete(_: &str) {}
}
const ROOT: &str = "local.meeting.copilot/oauth";
#[derive(serde::Serialize, serde::Deserialize)]
struct Manifest {
    version: String,
    chunks: usize,
}
fn manifest(root: &str) -> Result<Option<Manifest>, String> {
    native::read(root)?
        .map(|b| serde_json::from_slice(&b).map_err(|_| "Credential manifest is damaged".into()))
        .transpose()
}
pub fn load() -> Result<Option<String>, String> {
    load_from(ROOT)
}
fn load_from(root: &str) -> Result<Option<String>, String> {
    let Some(m) = manifest(root)? else {
        return Ok(None);
    };
    if m.chunks > 128 {
        return Err("Credential manifest exceeds limit".into());
    }
    let mut bytes = vec![];
    for i in 0..m.chunks {
        bytes.extend(
            native::read(&format!("{root}/{}/{i}", m.version))?
                .ok_or("Credential chunk is missing")?,
        );
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Credentials are damaged".into())
}
pub fn save(value: &str) -> Result<(), String> {
    save_to(ROOT, value)
}
fn save_to(root: &str, value: &str) -> Result<(), String> {
    if value.len() > 128 * 2400 {
        return Err("Too many saved accounts".into());
    }
    let old = manifest(root)?;
    let version = uuid::Uuid::new_v4().to_string();
    let chunks: Vec<_> = value.as_bytes().chunks(2400).collect();
    for (i, chunk) in chunks.iter().enumerate() {
        if let Err(e) = native::write(&format!("{root}/{version}/{i}"), chunk) {
            for j in 0..=i {
                native::delete(&format!("{root}/{version}/{j}"));
            }
            return Err(e);
        }
    }
    let m = Manifest {
        version,
        chunks: chunks.len(),
    };
    if let Err(error) = native::write(root, &serde_json::to_vec(&m).map_err(|e| e.to_string())?) {
        for i in 0..m.chunks {
            native::delete(&format!("{root}/{}/{i}", m.version));
        }
        return Err(error);
    }
    if let Some(old) = old {
        for i in 0..old.chunks {
            native::delete(&format!("{root}/{}/{i}", old.version));
        }
    }
    Ok(())
}
pub fn clear() -> Result<(), String> {
    clear_from(ROOT)
}
fn clear_from(root: &str) -> Result<(), String> {
    if let Some(m) = manifest(root)? {
        native::delete(root);
        for i in 0..m.chunks {
            native::delete(&format!("{root}/{}/{i}", m.version));
        }
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    fn fixture() -> String {
        "synthetic credential fixture — not an access token 🗝️".repeat(200)
    }
    #[test]
    #[ignore = "Writes isolated synthetic credentials to Windows Credential Manager"]
    fn credential_manager_survives_process_restart_and_rotates_chunks() {
        let root = format!("local.meeting.copilot/test/{}", uuid::Uuid::new_v4());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = clear_from(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        assert!(load_from(&root).unwrap().is_none());
        save_to(&root, &fixture()).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "storage::credentials::tests::credential_manager_child",
                "--ignored",
            ])
            .env("COPILOT_CREDENTIAL_TEST_ROOT", &root)
            .status()
            .unwrap();
        assert!(status.success());
        save_to(&root, "rotated synthetic credential").unwrap();
        assert_eq!(
            load_from(&root).unwrap().as_deref(),
            Some("rotated synthetic credential")
        );
        clear_from(&root).unwrap();
        assert!(load_from(&root).unwrap().is_none());
    }
    #[test]
    #[ignore = "Child process for the isolated credential restart test"]
    fn credential_manager_child() {
        let Ok(root) = std::env::var("COPILOT_CREDENTIAL_TEST_ROOT") else {
            return;
        };
        assert!(root.starts_with("local.meeting.copilot/test/"));
        assert_eq!(load_from(&root).unwrap().unwrap(), fixture());
    }
}
