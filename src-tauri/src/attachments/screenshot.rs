use base64::Engine;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotInfo { pub width: u32, pub height: u32, pub captured_at: u64 }
pub struct Screenshot { pub info: ScreenshotInfo, pub data_url: String }
/// A periodic screen-monitor frame. `rgb` is the exact pixel data that
/// `data_url` encodes, so change detection hashes pixels rather than encoder
/// framing.
pub struct MonitorFrame { pub info: ScreenshotInfo, pub rgb: Vec<u8>, pub data_url: String }

fn rgb_from_bgra(bgra: &[u8]) -> Vec<u8> {
    bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect()
}
fn encode_rgb(width: u32, height: u32, rgb: &[u8]) -> Result<(ScreenshotInfo, String), String> {
    if width == 0 || height == 0 || width as u64 * height as u64 > 64_000_000 || rgb.len() as u64 != width as u64 * height as u64 * 3 {
        return Err("Unsupported screen size".into());
    }
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|_| "Could not encode screenshot")?;
        writer.write_image_data(rgb).map_err(|_| "Could not encode screenshot")?;
    }
    if bytes.len() > 14 * 1024 * 1024 { return Err("Screenshot exceeds the image input size limit".into()); }
    let captured_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    Ok((ScreenshotInfo { width, height, captured_at }, format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
}
fn encode(width: u32, height: u32, bgra: &[u8]) -> Result<Screenshot, String> {
    if width == 0 || height == 0 || width as u64 * height as u64 > 64_000_000 || bgra.len() as u64 != width as u64 * height as u64 * 4 {
        return Err("Unsupported screen size".into());
    }
    let (info, data_url) = encode_rgb(width, height, &rgb_from_bgra(bgra))?;
    Ok(Screenshot { info, data_url })
}
/// Target size for a downscaled capture. Never upscales; keeps the aspect
/// ratio with rounding to the nearest row and at least one pixel of height.
fn scaled_dimensions(width: u32, height: u32, max_width: u32) -> (u32, u32) {
    if max_width == 0 || width <= max_width { return (width, height); }
    let height = ((height as u64 * max_width as u64 + width as u64 / 2) / width as u64).max(1) as u32;
    (max_width, height)
}

#[cfg(windows)]
pub fn capture() -> Result<Screenshot, String> {
    capture_window(None)
}
#[cfg(windows)]
pub fn capture_window(source_window: Option<usize>) -> Result<Screenshot, String> {
    let (width, height, pixels) = capture_bgra(source_window, None)?;
    encode(width, height, &pixels)
}
/// Periodic screen-monitor capture. The frame is downscaled through GDI's
/// halftone stretch to `max_width` before the pixels are read, which keeps the
/// PNG small and preserves legibility better than nearest-neighbor scaling.
#[cfg(windows)]
pub fn capture_monitor_frame(source_window: Option<usize>, max_width: u32) -> Result<MonitorFrame, String> {
    let (width, height, pixels) = capture_bgra(source_window, Some(max_width))?;
    let rgb = rgb_from_bgra(&pixels);
    let (info, data_url) = encode_rgb(width, height, &rgb)?;
    Ok(MonitorFrame { info, rgb, data_url })
}
/// Capture the monitor that contains `source_window`, or the monitor under the
/// pointer when it is `None`. `max_width` downscales the result.
#[cfg(windows)]
fn capture_bgra(source_window: Option<usize>, max_width: Option<u32>) -> Result<(u32, u32, Vec<u8>), String> {
    use windows::Win32::{Foundation::POINT, Graphics::Gdi::*, UI::WindowsAndMessaging::GetCursorPos};
    unsafe {
        let mut point = POINT::default();
        GetCursorPos(&mut point).map_err(|_| "Could not find the current screen")?;
        let monitor = if let Some(raw)=source_window {
            let hwnd=windows::Win32::Foundation::HWND(raw as *mut _);
            if !windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(hwnd)).as_bool(){return Err("The context window has closed; capture again".into());}
            MonitorFromWindow(hwnd,MONITOR_DEFAULTTONEAREST)
        }else{MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST)};
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() { return Err("Could not find the current screen".into()); }
        let rect = info.rcMonitor;
        let width = rect.right - rect.left; let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 || width as u64 * height as u64 > 64_000_000 { return Err("Unsupported screen size".into()); }
        let (target_width, target_height) = match max_width {
            Some(max_width) => scaled_dimensions(width as u32, height as u32, max_width),
            None => (width as u32, height as u32),
        };
        struct Surface { screen: HDC, memory: HDC, bitmap: HBITMAP, previous: HGDIOBJ }
        impl Drop for Surface {
            fn drop(&mut self) { unsafe {
                if !self.previous.0.is_null() { let _ = SelectObject(self.memory, self.previous); }
                let _ = DeleteDC(self.memory); let _ = DeleteObject(HGDIOBJ(self.bitmap.0)); ReleaseDC(None, self.screen);
            } }
        }
        let screen = GetDC(None);
        if screen.0.is_null() { return Err("Could not access the screen".into()); }
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, target_width as i32, target_height as i32);
        let mut surface = Surface { screen, memory, bitmap, previous: HGDIOBJ::default() };
        if memory.0.is_null() || bitmap.0.is_null() { return Err("Could not allocate screenshot surface".into()); }
        surface.previous = SelectObject(memory, HGDIOBJ(bitmap.0));
        let copied = if (target_width, target_height) == (width as u32, height as u32) {
            BitBlt(memory, 0, 0, width, height, Some(screen), rect.left, rect.top, SRCCOPY | CAPTUREBLT)
        } else {
            SetStretchBltMode(memory, HALFTONE);
            let _ = SetBrushOrgEx(memory, 0, 0, None);
            StretchBlt(memory, 0, 0, target_width as i32, target_height as i32, Some(screen), rect.left, rect.top, width, height, SRCCOPY | CAPTUREBLT).ok()
        };
        // GetDIBits requires the bitmap to be deselected from its DC.
        SelectObject(memory, surface.previous);
        surface.previous = HGDIOBJ::default();
        copied.map_err(|_| "Screen capture failed")?;
        let mut pixels = vec![0u8; target_width as usize * target_height as usize * 4];
        let mut dib = BITMAPINFO { bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: target_width as i32, biHeight: -(target_height as i32),
            biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default()
        }, ..Default::default() };
        if GetDIBits(screen, bitmap, 0, target_height, Some(pixels.as_mut_ptr().cast()), &mut dib, DIB_RGB_COLORS) != target_height as i32 { return Err("Could not read the complete screenshot".into()); }
        drop(surface);
        Ok((target_width, target_height, pixels))
    }
}
#[cfg(not(windows))]
pub fn capture() -> Result<Screenshot, String> { Err("Windows required".into()) }
#[cfg(not(windows))]
pub fn capture_window(_:Option<usize>)->Result<Screenshot,String>{capture()}
#[cfg(not(windows))]
pub fn capture_monitor_frame(_:Option<usize>,_:u32)->Result<MonitorFrame,String>{Err("Windows required".into())}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_top_down_bgra_as_lossless_rgb_png() {
        let shot = encode(2, 1, &[0, 0, 255, 0, 255, 0, 0, 0]).unwrap();
        assert!(shot.info.captured_at > 0);
        let bytes = base64::engine::general_purpose::STANDARD.decode(shot.data_url.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().unwrap();
        let mut decoded = vec![0; reader.output_buffer_size()]; reader.next_frame(&mut decoded).unwrap();
        assert_eq!(decoded, [255, 0, 0, 0, 0, 255]);
        assert!(encode(2, 2, &[0; 4]).is_err());
    }
    #[test]
    fn downscaled_capture_dimensions_keep_aspect_ratio_and_never_upscale() {
        assert_eq!(scaled_dimensions(2560, 1440, 1440), (1440, 810));
        assert_eq!(scaled_dimensions(1920, 1080, 1440), (1440, 810));
        assert_eq!(scaled_dimensions(800, 600, 1440), (800, 600));
        assert_eq!(scaled_dimensions(1000, 1, 997), (997, 1));
        assert_eq!(scaled_dimensions(1000, 1000, 0), (1000, 1000));
    }
    #[test]
    fn monitor_frames_keep_hashable_pixels_next_to_the_encoded_image() {
        let (info, data_url) = encode_rgb(2, 1, &[1, 2, 3, 4, 5, 6]).unwrap();
        assert_eq!((info.width, info.height), (2, 1));
        assert!(data_url.starts_with("data:image/png;base64,"));
        assert!(encode_rgb(2, 1, &[1, 2, 3]).is_err());
    }
}
