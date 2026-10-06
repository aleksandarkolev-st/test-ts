use base64::Engine;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotInfo { pub width: u32, pub height: u32 }
pub struct Screenshot { pub info: ScreenshotInfo, pub data_url: String }

fn encode(width: u32, height: u32, bgra: &[u8]) -> Result<Screenshot, String> {
    if width == 0 || height == 0 || width as u64 * height as u64 > 64_000_000 || bgra.len() as u64 != width as u64 * height as u64 * 4 {
        return Err("Unsupported screen size".into());
    }
    let rgb: Vec<u8> = bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
    let mut bytes = vec![];
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|_| "Could not encode screenshot")?;
        writer.write_image_data(&rgb).map_err(|_| "Could not encode screenshot")?;
    }
    if bytes.len() > 14 * 1024 * 1024 { return Err("Screenshot exceeds the image input size limit".into()); }
    Ok(Screenshot { info: ScreenshotInfo { width, height }, data_url: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)) })
}

#[cfg(windows)]
pub fn capture() -> Result<Screenshot, String> {
    use windows::Win32::{Foundation::POINT, Graphics::Gdi::*, UI::WindowsAndMessaging::GetCursorPos};
    unsafe {
        let mut point = POINT::default();
        GetCursorPos(&mut point).map_err(|_| "Could not find the current screen")?;
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() { return Err("Could not find the current screen".into()); }
        let rect = info.rcMonitor;
        let width = rect.right - rect.left; let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 || width as u64 * height as u64 > 64_000_000 { return Err("Unsupported screen size".into()); }
        struct Surface { screen: HDC, memory: HDC, bitmap: HBITMAP }
        impl Drop for Surface {
            fn drop(&mut self) { unsafe { let _ = DeleteDC(self.memory); let _ = DeleteObject(HGDIOBJ(self.bitmap.0)); ReleaseDC(None, self.screen); } }
        }
        let screen = GetDC(None);
        if screen.0.is_null() { return Err("Could not access the screen".into()); }
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let surface = Surface { screen, memory, bitmap };
        if memory.0.is_null() || bitmap.0.is_null() { return Err("Could not allocate screenshot surface".into()); }
        let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
        let copied = BitBlt(memory, 0, 0, width, height, Some(screen), rect.left, rect.top, SRCCOPY | CAPTUREBLT);
        // GetDIBits requires the bitmap to be deselected from its DC.
        SelectObject(memory, previous);
        copied.map_err(|_| "Screen capture failed")?;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let mut dib = BITMAPINFO { bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: width, biHeight: -height,
            biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default()
        }, ..Default::default() };
        if GetDIBits(screen, bitmap, 0, height as u32, Some(pixels.as_mut_ptr().cast()), &mut dib, DIB_RGB_COLORS) != height { return Err("Could not read the complete screenshot".into()); }
        drop(surface);
        encode(width as u32, height as u32, &pixels)
    }
}
#[cfg(not(windows))]
pub fn capture() -> Result<Screenshot, String> { Err("Windows required".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_top_down_bgra_as_lossless_rgb_png() {
        let shot = encode(2, 1, &[0, 0, 255, 0, 255, 0, 0, 0]).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(shot.data_url.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().unwrap();
        let mut decoded = vec![0; reader.output_buffer_size()]; reader.next_frame(&mut decoded).unwrap();
        assert_eq!(decoded, [255, 0, 0, 0, 0, 255]);
        assert!(encode(2, 2, &[0; 4]).is_err());
    }
}
