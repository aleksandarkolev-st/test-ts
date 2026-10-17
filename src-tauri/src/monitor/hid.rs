//! USB HID client for the QMK RAW HID typing bridge (see [`super::protocol`]).
//!
//! The bridge is identified by a PING/PONG handshake, not by device name: every
//! candidate interface on vendor usage page `0xFF60` / usage `0x61` is opened
//! and only the one running firmware version [`protocol::FIRMWARE_VERSION`]
//! answers. The connection is refused per interface when the firmware does not
//! reply, so VIA-only keyboards are skipped without typing anything.
//!
//! Typing is deliberately paced by the firmware and acknowledged per chunk; the
//! host never synthesizes keystrokes through SendInput. If the bridge is gone,
//! every operation fails and the caller must refuse to type.
use serde::Serialize;

use crate::monitor::protocol::NackCode;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BridgeError {
    Enumerate(String),
    Open(String),
    NoFirmware,
    Incompatible(u8),
    Lost,
    Timeout,
    Rejected(NackCode),
    Text(String),
    Io(String),
    Unsupported,
}
impl BridgeError {
    pub fn message(&self) -> String {
        match self {
            Self::Enumerate(m) => format!("Could not enumerate HID devices: {m}"),
            Self::Open(m) => format!("Could not open HID device: {m}"),
            Self::NoFirmware => {
                "No keyboard running the screen-typing firmware is connected".into()
            }
            Self::Incompatible(version) => format!(
                "The connected keyboard runs incompatible firmware (version {version}, expected {})",
                crate::monitor::protocol::FIRMWARE_VERSION
            ),
            Self::Lost => "The keyboard bridge disconnected".into(),
            Self::Timeout => "The keyboard bridge did not acknowledge the request".into(),
            Self::Rejected(code) => code.description().into(),
            Self::Text(m) => m.clone(),
            Self::Io(m) => format!("Keyboard bridge I/O failed: {m}"),
            Self::Unsupported => "The keyboard bridge is only supported on Windows".into(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyboardInfo {
    pub product: String,
    pub vendor_id: u16,
    pub product_id: u16,
}

/// Live bridge state for the settings UI and snapshot. `detail` is a
/// human-readable explanation when the bridge is not connected.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub connected: bool,
    pub product: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub detail: String,
}

/// Connects to the first RAW HID interface whose firmware answers PING and
/// reports no connection otherwise. The probe never types; it only handshakes
/// and disconnects, so it is safe to call while the monitor is disabled.
pub fn probe() -> BridgeStatus {
    match imp::connect() {
        Ok(bridge) => {
            let info = bridge.info();
            BridgeStatus {
                connected: true,
                product: info.product.clone(),
                vendor_id: info.vendor_id,
                product_id: info.product_id,
                detail: "QMK screen-typing firmware ready".into(),
            }
        }
        Err(error) => BridgeStatus {
            detail: error.message(),
            ..BridgeStatus::default()
        },
    }
}

#[cfg(windows)]
mod imp {
    use super::{BridgeError, KeyboardInfo};
    use crate::monitor::protocol::{
        self, clear_report, config_report, ping_report, Inbound, NackCode, TypingTimings,
        FIRMWARE_VERSION, REPORT_SIZE,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::Duration;
    use windows::core::PCWSTR;
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
        SetupDiGetDeviceInterfaceDetailW, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT,
        SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W,
    };
    use windows::Win32::Devices::HumanInterfaceDevice::{
        HidD_FreePreparsedData, HidD_GetAttributes, HidD_GetHidGuid, HidD_GetPreparsedData,
        HidD_GetProductString, HidP_GetCaps, HIDD_ATTRIBUTES, HIDP_CAPS, HIDP_STATUS_SUCCESS,
        PHIDP_PREPARSED_DATA,
    };
    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    use windows::Win32::System::IO::CancelIoEx;

    const USAGE_PAGE_RAW_HID: u16 = 0xFF60;
    const USAGE_RAW_HID: u16 = 0x61;
    const IO_TIMEOUT: Duration = Duration::from_millis(150);
    const IO_ATTEMPTS: usize = 3;
    const QUEUE_RETRY_DELAY: Duration = Duration::from_millis(50);

    /// A process-owned HID file handle shared by the writer and the reader
    /// thread. Win32 file handles are usable from any thread; the wrapper only
    /// exists because raw pointers are not `Send` on their own.
    #[derive(Clone, Copy)]
    struct SendHandle(HANDLE);
    unsafe impl Send for SendHandle {}
    unsafe impl Sync for SendHandle {}

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum WriteMode {
        /// Report ID byte prepended; canonical for Windows HID (33 bytes).
        Prefixed,
        /// Payload only (32 bytes), for drivers reporting 32-byte output.
        Raw,
    }

    struct RawDevice {
        handle: SendHandle,
        in_len: usize,
        out_len: usize,
        info: KeyboardInfo,
    }

    pub struct KeyboardBridge {
        handle: SendHandle,
        reader: Option<JoinHandle<()>>,
        alive: Arc<AtomicBool>,
        rx: Receiver<Inbound>,
        info: KeyboardInfo,
        write_mode: WriteMode,
    }
    impl KeyboardBridge {
        pub fn info(&self) -> &KeyboardInfo {
            &self.info
        }
        pub fn is_alive(&self) -> bool {
            self.alive.load(Ordering::Acquire)
        }
        /// Opens a candidate interface, then PINGs it. A reply with the frozen
        /// firmware version completes the handshake.
        pub fn ping(&mut self) -> Result<(), BridgeError> {
            for _ in 0..IO_ATTEMPTS {
                self.drain();
                self.write(&ping_report())?;
                match self.wait(IO_TIMEOUT) {
                    Some(Inbound::Pong { version, .. }) if version == FIRMWARE_VERSION => {
                        return Ok(())
                    }
                    Some(Inbound::Pong { version, .. }) => {
                        return Err(BridgeError::Incompatible(version))
                    }
                    _ => {}
                }
            }
            Err(BridgeError::NoFirmware)
        }
        pub fn configure(&mut self, timings: TypingTimings) -> Result<(), BridgeError> {
            if let Err(message) = timings.validate() {
                return Err(BridgeError::Io(message.into()));
            }
            let report = config_report(timings);
            for _ in 0..IO_ATTEMPTS {
                self.drain();
                self.write(&report)?;
                match self.wait(IO_TIMEOUT) {
                    Some(Inbound::ConfigAck) => return Ok(()),
                    Some(Inbound::Nack { code, .. }) => return Err(BridgeError::Rejected(code)),
                    _ => {}
                }
            }
            Err(BridgeError::Timeout)
        }
        /// Sends `text` as acknowledged 29-byte chunks. The firmware paces the
        /// actual keystrokes; a chunk is only considered sent once the firmware
        /// acknowledged it, so a lost acknowledgement can duplicate a chunk but
        /// never silently drops the answer.
        pub fn send_text(&mut self, text: &str) -> Result<(), BridgeError> {
            self.send_text_checked(text, || false).map(|_| ())
        }
        /// Like [`KeyboardBridge::send_text`], but checks `should_abort` between
        /// chunks and retries. Returns `Ok(false)` without sending the remaining
        /// chunks once abandoned; the caller is responsible for issuing CLEAR.
        pub fn send_text_checked(
            &mut self,
            text: &str,
            should_abort: impl Fn() -> bool,
        ) -> Result<bool, BridgeError> {
            if !self.is_alive() {
                return Err(BridgeError::Lost);
            }
            let normalized = protocol::normalize_for_typing(text);
            let reports = protocol::text_reports(&normalized)
                .map_err(|error| BridgeError::Text(error.message()))?;
            for report in reports {
                if should_abort() {
                    return Ok(false);
                }
                let mut last = BridgeError::Timeout;
                let mut acknowledged = false;
                for _ in 0..IO_ATTEMPTS {
                    if should_abort() {
                        return Ok(false);
                    }
                    self.drain();
                    self.write(&report)?;
                    match self.wait(IO_TIMEOUT) {
                        Some(Inbound::Pong { .. }) => {
                            acknowledged = true;
                            break;
                        }
                        Some(Inbound::Nack {
                            code: NackCode::QueueFull,
                            ..
                        }) => {
                            last = BridgeError::Rejected(NackCode::QueueFull);
                            std::thread::sleep(QUEUE_RETRY_DELAY);
                        }
                        Some(Inbound::Nack { code, .. }) => {
                            return Err(BridgeError::Rejected(code))
                        }
                        _ => {}
                    }
                }
                if !acknowledged {
                    return Err(if self.is_alive() {
                        last
                    } else {
                        BridgeError::Lost
                    });
                }
            }
            Ok(true)
        }
        /// Best-effort kill switch: asks the firmware to drop everything that
        /// is still queued. No acknowledgement is expected.
        pub fn clear(&mut self) -> Result<(), BridgeError> {
            self.write(&clear_report())
        }
        fn write(&mut self, report: &[u8; REPORT_SIZE]) -> Result<(), BridgeError> {
            match self.try_write(report) {
                Ok(()) => Ok(()),
                Err(first) => {
                    self.write_mode = match self.write_mode {
                        WriteMode::Prefixed => WriteMode::Raw,
                        WriteMode::Raw => WriteMode::Prefixed,
                    };
                    self.try_write(report).map_err(|_| first)
                }
            }
        }
        fn try_write(&self, report: &[u8; REPORT_SIZE]) -> Result<(), BridgeError> {
            let mut prefixed = [0u8; REPORT_SIZE + 1];
            let buffer: &[u8] = match self.write_mode {
                WriteMode::Prefixed => {
                    prefixed[1..].copy_from_slice(report);
                    &prefixed
                }
                WriteMode::Raw => report,
            };
            unsafe { WriteFile(self.handle.0, Some(buffer), None, None) }
                .map_err(|error| BridgeError::Io(error.message()))
        }
        fn wait(&self, timeout: Duration) -> Option<Inbound> {
            self.rx.recv_timeout(timeout).ok()
        }
        fn drain(&self) {
            while self.rx.try_recv().is_ok() {}
        }
        fn shutdown(&mut self) {
            let Some(reader) = self.reader.take() else {
                return;
            };
            let cancelled = unsafe { CancelIoEx(self.handle.0, None) }.is_ok();
            if cancelled {
                let _ = reader.join();
            }
            let _ = unsafe { CloseHandle(self.handle.0) };
        }
    }
    impl Drop for KeyboardBridge {
        fn drop(&mut self) {
            self.shutdown();
        }
    }

    pub fn connect() -> Result<KeyboardBridge, BridgeError> {
        let mut last = None;
        for path in candidate_paths()? {
            let device = match open_candidate(&path) {
                Some(device) => device,
                None => continue,
            };
            let (tx, rx) = mpsc::channel();
            let alive = Arc::new(AtomicBool::new(true));
            let handle = device.handle;
            let reader = std::thread::Builder::new()
                .name("keyboard-bridge-reader".into())
                .spawn({
                    let alive = alive.clone();
                    move || reader_loop(handle, device.in_len, tx, alive)
                })
                .map_err(|error| BridgeError::Io(error.to_string()))?;
            let mut bridge = KeyboardBridge {
                handle,
                reader: Some(reader),
                alive,
                rx,
                info: device.info,
                write_mode: if device.out_len == REPORT_SIZE {
                    WriteMode::Raw
                } else {
                    WriteMode::Prefixed
                },
            };
            match bridge.ping() {
                Ok(()) => {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "monitor: keyboard bridge connected to {} (in {}, out {})",
                        if bridge.info.product.is_empty() {
                            "unknown HID device"
                        } else {
                            &bridge.info.product
                        },
                        device.in_len,
                        device.out_len
                    );
                    return Ok(bridge);
                }
                Err(error) => last = Some(error),
            }
        }
        Err(last.unwrap_or(BridgeError::NoFirmware))
    }

    fn reader_loop(handle: SendHandle, in_len: usize, tx: Sender<Inbound>, alive: Arc<AtomicBool>) {
        let mut buffer = vec![0u8; in_len];
        loop {
            let mut read = 0u32;
            if unsafe { ReadFile(handle.0, Some(&mut buffer), Some(&mut read), None) }.is_err() {
                break;
            }
            let count = read as usize;
            if count == 0 {
                // A zero-length read means the device disappeared.
                break;
            }
            // Windows may deliver the payload with or without a report ID byte.
            let payload = if count > REPORT_SIZE {
                &buffer[count - REPORT_SIZE..count]
            } else {
                &buffer[..count]
            };
            if let Ok(Some(message)) = protocol::parse_reply(payload) {
                if tx.send(message).is_err() {
                    break;
                }
            }
        }
        alive.store(false, Ordering::Release);
    }

    /// Lists every HID interface path; usage filtering happens in
    /// [`open_candidate`] because usage pages live in the report descriptor.
    fn candidate_paths() -> Result<Vec<String>, BridgeError> {
        unsafe {
            let hid_guid = HidD_GetHidGuid();
            let devices = SetupDiGetClassDevsW(
                Some(&hid_guid),
                PCWSTR::null(),
                None,
                DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
            )
            .map_err(|error| BridgeError::Enumerate(error.message()))?;
            let mut paths = Vec::new();
            let mut index = 0u32;
            loop {
                let mut interface = SP_DEVICE_INTERFACE_DATA {
                    cbSize: std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32,
                    ..Default::default()
                };
                if SetupDiEnumDeviceInterfaces(devices, None, &hid_guid, index, &mut interface)
                    .is_err()
                {
                    break;
                }
                index += 1;
                let mut required = 0u32;
                let _ = SetupDiGetDeviceInterfaceDetailW(
                    devices,
                    &interface,
                    None,
                    0,
                    Some(&mut required),
                    None,
                );
                if required == 0 {
                    continue;
                }
                // `u64` storage keeps the struct pointer aligned.
                let mut storage = vec![0u64; (required as usize).div_ceil(8)];
                let detail = storage.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
                std::ptr::addr_of_mut!((*detail).cbSize)
                    .write(std::mem::size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32);
                if SetupDiGetDeviceInterfaceDetailW(
                    devices,
                    &interface,
                    Some(detail),
                    required,
                    None,
                    None,
                )
                .is_err()
                {
                    continue;
                }
                let start = std::ptr::addr_of!((*detail).DevicePath) as *const u16;
                let max_chars = (required as usize).saturating_sub(4) / 2;
                let mut len = 0usize;
                while len < max_chars && *start.add(len) != 0 {
                    len += 1;
                }
                paths.push(String::from_utf16_lossy(std::slice::from_raw_parts(
                    start, len,
                )));
            }
            let _ = SetupDiDestroyDeviceInfoList(devices);
            Ok(paths)
        }
    }

    fn open_candidate(path: &str) -> Option<RawDevice> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateFileW(
                PCWSTR::from_raw(wide.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .ok()?;
        let handle = SendHandle(handle);
        match inspect(handle) {
            Some((in_len, out_len, info)) => Some(RawDevice {
                handle,
                in_len,
                out_len,
                info,
            }),
            None => {
                let _ = unsafe { CloseHandle(handle.0) };
                None
            }
        }
    }

    /// Accepts only the RAW HID collection shape the firmware exposes.
    fn inspect(handle: SendHandle) -> Option<(usize, usize, KeyboardInfo)> {
        unsafe {
            let mut preparsed = PHIDP_PREPARSED_DATA(0);
            if !HidD_GetPreparsedData(handle.0, &mut preparsed) {
                return None;
            }
            let mut caps: HIDP_CAPS = std::mem::zeroed();
            let status = HidP_GetCaps(preparsed, &mut caps);
            let _ = HidD_FreePreparsedData(preparsed);
            if status != HIDP_STATUS_SUCCESS
                || caps.UsagePage != USAGE_PAGE_RAW_HID
                || caps.Usage != USAGE_RAW_HID
            {
                return None;
            }
            let in_len = caps.InputReportByteLength as usize;
            let out_len = caps.OutputReportByteLength as usize;
            if !(REPORT_SIZE..=REPORT_SIZE + 1).contains(&in_len)
                || !(REPORT_SIZE..=REPORT_SIZE + 1).contains(&out_len)
            {
                return None;
            }
            let mut attributes = HIDD_ATTRIBUTES {
                Size: std::mem::size_of::<HIDD_ATTRIBUTES>() as u32,
                ..Default::default()
            };
            let attributes_ok = HidD_GetAttributes(handle.0, &mut attributes);
            let mut product_buffer = [0u16; 128];
            let product = if HidD_GetProductString(
                handle.0,
                product_buffer.as_mut_ptr() as *mut std::ffi::c_void,
                (product_buffer.len() * 2) as u32,
            ) {
                let len = product_buffer
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(product_buffer.len());
                String::from_utf16_lossy(&product_buffer[..len])
            } else {
                String::new()
            };
            let (vendor_id, product_id) = if attributes_ok {
                (attributes.VendorID, attributes.ProductID)
            } else {
                (0, 0)
            };
            Some((
                in_len,
                out_len,
                KeyboardInfo {
                    product,
                    vendor_id,
                    product_id,
                },
            ))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{BridgeError, KeyboardInfo};
    use crate::monitor::protocol::TypingTimings;

    pub struct KeyboardBridge {
        info: KeyboardInfo,
    }
    impl KeyboardBridge {
        pub fn info(&self) -> &KeyboardInfo {
            &self.info
        }
        pub fn is_alive(&self) -> bool {
            false
        }
        pub fn ping(&mut self) -> Result<(), BridgeError> {
            Err(BridgeError::Unsupported)
        }
        pub fn configure(&mut self, _timings: TypingTimings) -> Result<(), BridgeError> {
            Err(BridgeError::Unsupported)
        }
        pub fn send_text(&mut self, _text: &str) -> Result<(), BridgeError> {
            Err(BridgeError::Unsupported)
        }
        pub fn send_text_checked(
            &mut self,
            _text: &str,
            _should_abort: impl Fn() -> bool,
        ) -> Result<bool, BridgeError> {
            Err(BridgeError::Unsupported)
        }
        pub fn clear(&mut self) -> Result<(), BridgeError> {
            Err(BridgeError::Unsupported)
        }
    }
    pub fn connect() -> Result<KeyboardBridge, BridgeError> {
        Err(BridgeError::Unsupported)
    }
}

pub use imp::{connect, KeyboardBridge};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_errors_are_human_readable() {
        assert!(BridgeError::NoFirmware.message().contains("firmware"));
        assert!(BridgeError::Lost.message().contains("disconnected"));
        assert!(BridgeError::Incompatible(2)
            .message()
            .contains("version 2"));
        assert!(BridgeError::Rejected(NackCode::QueueFull)
            .message()
            .contains("full"));
        assert!(BridgeError::Text("bad text".into())
            .message()
            .contains("bad text"));
    }

    #[test]
    fn disconnected_status_defaults_to_not_connected() {
        let status = BridgeStatus::default();
        assert!(!status.connected);
        assert!(status.product.is_empty());
    }
}
