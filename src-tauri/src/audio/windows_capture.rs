use super::*;
use windows::{
    core::PCWSTR,
    Win32::{
        Media::{
            Audio::*, KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM,
            Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
        },
        System::{Com::*, Power::{SetThreadExecutionState, EXECUTION_STATE, ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED}},
    },
};
struct Com;
// This guard lives on the capture thread: Windows execution requirements are
// thread-local, so restoring them from an async task's thread would leak them.
struct CaptureWake(EXECUTION_STATE);
impl CaptureWake {
    fn enter() -> Self { Self(unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) }) }
}
impl Drop for CaptureWake {
    fn drop(&mut self) { if self.0.0 != 0 { unsafe { SetThreadExecutionState(self.0); } } }
}
#[cfg(test)]
mod power_tests {
    use super::*;
    #[test]
    fn capture_wake_request_is_released_on_its_own_thread() {
        std::thread::spawn(|| unsafe {
            let previous=SetThreadExecutionState(ES_CONTINUOUS);
            assert_ne!(previous.0,0);
            let required=ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED;
            {
                let guard=CaptureWake::enter();assert_ne!(guard.0.0,0);
                let held=SetThreadExecutionState(required);
                assert_eq!(held.0&required.0,required.0);
            }
            let released=SetThreadExecutionState(ES_CONTINUOUS);
            assert_eq!(released.0,ES_CONTINUOUS.0);
            SetThreadExecutionState(previous);
        }).join().unwrap();
    }
}
impl Com {
    fn enter() -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| e.to_string())?;
        }
        Ok(Self)
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
unsafe fn device_id(device: &IMMDevice) -> Result<String, String> {
    let p = device.GetId().map_err(|e| e.to_string())?;
    let s = p.to_string().map_err(|e| e.to_string());
    CoTaskMemFree(Some(p.0.cast()));
    s
}
pub fn devices() -> Result<Vec<AudioDevice>, String> {
    let _com = Com::enter()?;
    unsafe {
        let e: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let mut result = vec![];
        for (flow, source) in [
            (eRender, SpeakerSource::Remote),
            (eCapture, SpeakerSource::Self_),
        ] {
            let default = e
                .GetDefaultAudioEndpoint(flow, eConsole)
                .ok()
                .and_then(|d| device_id(&d).ok());
            let list = e
                .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
                .map_err(|e| e.to_string())?;
            for i in 0..list.GetCount().map_err(|e| e.to_string())? {
                let device = list.Item(i).map_err(|e| e.to_string())?;
                let id = device_id(&device)?;
                let store = device
                    .OpenPropertyStore(STGM_READ)
                    .map_err(|e| e.to_string())?;
                let key = windows::Win32::Foundation::PROPERTYKEY {
                    fmtid: windows::core::GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
                    pid: 14,
                };
                let mut value = store.GetValue(&key).map_err(|e| e.to_string())?;
                let name =
                    windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc(
                        &value,
                    )
                    .ok()
                    .map(|p| {
                        let s = p.to_string().unwrap_or_else(|_| id.clone());
                        CoTaskMemFree(Some(p.0.cast()));
                        s
                    })
                    .unwrap_or_else(|| id.clone());
                let _ =
                    windows::Win32::System::Com::StructuredStorage::PropVariantClear(&mut value);
                result.push(AudioDevice {
                    default: default.as_ref() == Some(&id),
                    id,
                    name,
                    source,
                });
            }
        }
        Ok(result)
    }
}
pub fn capture(
    id: &str,
    source: SpeakerSource,
    clock: Instant,
    stop: &AtomicBool,
    tx: &mpsc::Sender<AudioFrame>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let _com = Com::enter()?;
    unsafe {
        let init = (|| -> Result<_, String> {
            let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| e.to_string())?;
            let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
            let device = e
                .GetDevice(PCWSTR(wide.as_ptr()))
                .map_err(|e| e.to_string())?;
            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| e.to_string())?;
            let format = client.GetMixFormat().map_err(|e| e.to_string())?;
            let rate = (*format).nSamplesPerSec;
            let channels = (*format).nChannels as usize;
            let bits = (*format).wBitsPerSample;
            let tag = (*format).wFormatTag;
            let sub = if tag == 0xfffe {
                Some((*(format as *const WAVEFORMATEXTENSIBLE)).SubFormat)
            } else {
                None
            };
            let float = tag == 3 || sub == Some(KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
            let pcm = tag == 1 || sub == Some(KSDATAFORMAT_SUBTYPE_PCM);
            if channels == 0
                || rate == 0
                || !(float && bits == 32 || pcm && [16, 24, 32].contains(&bits))
            {
                CoTaskMemFree(Some(format.cast()));
                return Err("Unsupported WASAPI mix format".into());
            }
            let flags = if source == SpeakerSource::Remote {
                AUDCLNT_STREAMFLAGS_LOOPBACK
            } else {
                0
            };
            let initialized =
                client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1_000_000, 0, format, None);
            CoTaskMemFree(Some(format.cast()));
            initialized.map_err(|e| e.to_string())?;
            let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
            client.Start().map_err(|e| e.to_string())?;
            Ok((client, capture, rate, channels, bits, float))
        })();
        let (client, capture, rate, channels, bits, float) = match init {
            Ok(v) => {
                let _ = ready.send(Ok(()));
                v
            }
            Err(e) => {
                let _ = ready.send(Err(e.clone()));
                return Err(e);
            }
        };
        let _wake = (source == SpeakerSource::Remote).then(CaptureWake::enter);
        let mut resampler = resampler::Resampler::new(rate);
        let mut last = clock.elapsed().as_millis() as u64;
        let mut sample_time = last as f64;
        let result = (|| -> Result<(), String> {
            while !stop.load(Ordering::Acquire) {
                let mut had = false;
                while capture
                    .GetNextPacketSize()
                    .map_err(|e| format!("Audio device disconnected: {e}"))?
                    > 0
                {
                    had = true;
                    let mut ptr = std::ptr::null_mut();
                    let mut frames = 0;
                    let mut flags = 0;
                    capture
                        .GetBuffer(&mut ptr, &mut frames, &mut flags, None, None)
                        .map_err(|e| e.to_string())?;
                    let count = frames as usize * channels;
                    let samples = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                        vec![0.; count]
                    } else {
                        let bytes = std::slice::from_raw_parts(ptr, count * (bits as usize / 8));
                        bytes
                            .chunks_exact(bits as usize / 8)
                            .map(|b| {
                                if float {
                                    f32::from_le_bytes(b.try_into().unwrap())
                                } else {
                                    match bits {
                                        16 => {
                                            i16::from_le_bytes(b.try_into().unwrap()) as f32
                                                / 32768.
                                        }
                                        24 => {
                                            let n = ((b[0] as i32)
                                                | ((b[1] as i32) << 8)
                                                | ((b[2] as i32) << 16))
                                                << 8;
                                            n as f32 / 2147483648.
                                        }
                                        _ => {
                                            i32::from_le_bytes(b.try_into().unwrap()) as f32
                                                / 2147483648.
                                        }
                                    }
                                }
                            })
                            .map(|x| if x.is_finite() { x.clamp(-1., 1.) } else { 0. })
                            .collect()
                    };
                    capture.ReleaseBuffer(frames).map_err(|e| e.to_string())?;
                    let now = clock.elapsed().as_millis() as u64;
                    if now.saturating_sub(last) > 100 {
                        sample_time =
                            now.saturating_sub((frames as u64 * 1000) / rate as u64) as f64;
                    }
                    last = now;
                    let start = sample_time as u64;
                    sample_time += frames as f64 * 1000. / rate as f64;
                    let mono = resampler::downmix(&samples, channels);
                    let normalized = resampler.process(&mono);
                    tx.try_send(AudioFrame {
                        source,
                        samples: normalized,
                        timestamp_ms: start,
                    })
                    .map_err(|_| {
                        "Audio processing could not keep up; restart the meeting".to_string()
                    })?;
                }
                let now = clock.elapsed().as_millis() as u64;
                // Loopback stops delivering packets when the output is silent.
                // Feed local silence to let the VAD finish the final utterance.
                if !had && now.saturating_sub(last) >= 30 {
                    let elapsed = now.saturating_sub(last).min(100);
                    tx.try_send(AudioFrame {
                        source,
                        samples: vec![0.; elapsed as usize * 16],
                        timestamp_ms: last,
                    })
                    .map_err(|_| "Audio processing queue is full".to_string())?;
                    last = now;
                    sample_time = now as f64;
                }
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
            Ok(())
        })();
        let _ = client.Stop();
        result
    }
}
