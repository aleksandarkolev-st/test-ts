#[cfg(windows)]
pub fn choose(owner: usize) -> Result<Option<String>, String> {
    use windows::Win32::{Foundation::HWND, System::Com::*, UI::Shell::*};
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().map_err(|e| e.to_string())?;
        struct Com;
        impl Drop for Com { fn drop(&mut self) { unsafe { CoUninitialize() } } }
        let _com = Com;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        dialog.SetOptions(dialog.GetOptions().map_err(|e| e.to_string())? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST).map_err(|e| e.to_string())?;
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
            if error.code().0 as u32 == 0x800704c7 { return Ok(None); }
            return Err("Could not open the project folder picker".into());
        }
        let path = dialog.GetResult().and_then(|item| item.GetDisplayName(SIGDN_FILESYSPATH)).map_err(|e| e.to_string())?;
        let text = path.to_string().map_err(|e| e.to_string());
        CoTaskMemFree(Some(path.0 as *const _));
        text.map(Some)
    }
}
#[cfg(not(windows))]
pub fn choose(_: usize) -> Result<Option<String>, String> { Err("Windows required".into()) }
