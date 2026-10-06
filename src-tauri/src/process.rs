//! Own a sidecar's lifetime even if the desktop app exits unexpectedly.
#[cfg(windows)]
pub(crate) struct ProcessJob(usize);
#[cfg(windows)]
impl ProcessJob {
    pub(crate) fn attach(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::*,
        };
        unsafe {
            let job =
                CreateJobObjectW(None, None).map_err(|_| "Cannot create local process job")?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let result = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
            .and_then(|_| AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())));
            if result.is_err() {
                let _ = CloseHandle(job);
                return Err("Cannot contain the local process lifetime".into());
            }
            Ok(Self(job.0 as usize))
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.0 as *mut _,
            ));
        }
    }
}
