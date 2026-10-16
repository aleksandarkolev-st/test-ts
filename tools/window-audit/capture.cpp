#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "capture.hpp"
#include <dwmapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <thread>

namespace wa {
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
namespace {
void check(HRESULT hr) { winrt::check_hresult(hr); }
void validate_region(RECT region, UINT width, UINT height) {
    if (region.left < 0 || region.top < 0 || region.right <= region.left || region.bottom <= region.top ||
        region.right > static_cast<LONG>(width) || region.bottom > static_cast<LONG>(height))
        throw std::runtime_error("Sample region is outside the captured image");
}
struct GdiBitmap {
    HDC screen = nullptr, memory = nullptr;
    HBITMAP bitmap = nullptr;
    HGDIOBJ old = nullptr;
    void* pixels = nullptr;
    int width, height;
    GdiBitmap(int w, int h) : width(w), height(h) {
        if (w <= 0 || h <= 0 || w > 8192 || h > 8192 || int64_t(w) * h > 32000000)
            throw std::runtime_error("Bitmap size outside diagnostic bounds");
        screen = GetDC(nullptr); memory = CreateCompatibleDC(screen);
        BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = w; info.bmiHeader.biHeight = -h; info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
        bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
        if (!screen || !memory || !bitmap || !pixels) { cleanup(); throw std::runtime_error("GDI bitmap allocation failed"); }
        old = SelectObject(memory, bitmap); memset(pixels, 0xA5, static_cast<size_t>(w) * h * 4);
    }
    void cleanup() {
        if (old) SelectObject(memory, old);
        if (bitmap) DeleteObject(bitmap);
        if (memory) DeleteDC(memory);
        if (screen) ReleaseDC(nullptr, screen);
        screen = memory = nullptr; bitmap = nullptr; old = nullptr;
    }
    ~GdiBitmap() { cleanup(); }
    Image region(RECT roi) {
        validate_region(roi, width, height); GdiFlush();
        Image image; image.width = roi.right - roi.left; image.height = roi.bottom - roi.top;
        image.pixels.resize(static_cast<size_t>(image.width) * image.height);
        for (int y = 0; y < image.height; ++y)
            memcpy(image.pixels.data() + static_cast<size_t>(y) * image.width,
                static_cast<Pixel*>(pixels) + static_cast<size_t>(y + roi.top) * width + roi.left,
                image.width * sizeof(Pixel));
        return image;
    }
};
}

Graphics::Graphics(POINT screen_point) {
    ComPtr<IDXGIFactory1> factory; check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)));
    const auto monitor = MonitorFromPoint(screen_point, MONITOR_DEFAULTTONEAREST);
    ComPtr<IDXGIAdapter1> selected;
    for (UINT a = 0; !selected; ++a) {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(a, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        for (UINT i = 0;; ++i) {
            ComPtr<IDXGIOutput> candidate;
            if (adapter->EnumOutputs(i, &candidate) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_OUTPUT_DESC description{}; check(candidate->GetDesc(&description));
            if (description.Monitor == monitor) {
                selected = adapter; check(candidate.As(&output)); output_desc = description; break;
            }
        }
    }
    if (!selected) throw std::runtime_error("No DXGI output matches the sample monitor");
    check(selected->GetDesc1(&adapter_desc));
    D3D_FEATURE_LEVEL feature{};
    check(D3D11CreateDevice(selected.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_PREVENT_INTERNAL_THREADING_OPTIMIZATIONS,
        nullptr, 0, D3D11_SDK_VERSION, &device, &feature, &context));
    ComPtr<IDXGIDevice> dxgi; check(device.As(&dxgi));
    winrt::com_ptr<IInspectable> inspectable;
    check(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), inspectable.put()));
    winrt_device = inspectable.as<IDirect3DDevice>();
}

Image Graphics::texture_region(ID3D11Texture2D* texture, RECT region, DXGI_MODE_ROTATION rotation) {
    D3D11_TEXTURE2D_DESC source{}; texture->GetDesc(&source);
    if (source.Format != DXGI_FORMAT_B8G8R8A8_UNORM && source.Format != DXGI_FORMAT_R8G8B8A8_UNORM)
        throw std::runtime_error("Unsupported capture pixel format: " + std::to_string(source.Format));
    const bool sideways = rotation == DXGI_MODE_ROTATION_ROTATE90 || rotation == DXGI_MODE_ROTATION_ROTATE270;
    validate_region(region, sideways ? source.Height : source.Width, sideways ? source.Width : source.Height);
    auto coordinate = [&](int x, int y) -> POINT {
        switch (rotation) {
        case DXGI_MODE_ROTATION_ROTATE90: return {y, static_cast<LONG>(source.Height) - 1 - x};
        case DXGI_MODE_ROTATION_ROTATE180: return {static_cast<LONG>(source.Width) - 1 - x, static_cast<LONG>(source.Height) - 1 - y};
        case DXGI_MODE_ROTATION_ROTATE270: return {static_cast<LONG>(source.Width) - 1 - y, x};
        default: return {x, y};
        }
    };
    const std::array<POINT, 4> corners{coordinate(region.left, region.top), coordinate(region.right - 1, region.top),
        coordinate(region.left, region.bottom - 1), coordinate(region.right - 1, region.bottom - 1)};
    RECT box{LONG_MAX, LONG_MAX, LONG_MIN, LONG_MIN};
    for (auto p : corners) { box.left = std::min(box.left, p.x); box.top = std::min(box.top, p.y); box.right = std::max(box.right, p.x + 1); box.bottom = std::max(box.bottom, p.y + 1); }
    D3D11_TEXTURE2D_DESC staging = source;
    staging.Width = box.right - box.left; staging.Height = box.bottom - box.top;
    staging.ArraySize = 1; staging.MipLevels = 1; staging.BindFlags = staging.MiscFlags = 0;
    staging.Usage = D3D11_USAGE_STAGING; staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> cpu; check(device->CreateTexture2D(&staging, nullptr, &cpu));
    D3D11_BOX copy{static_cast<UINT>(box.left), static_cast<UINT>(box.top), 0,
        static_cast<UINT>(box.right), static_cast<UINT>(box.bottom), 1};
    context->CopySubresourceRegion(cpu.Get(), 0, 0, 0, 0, texture, 0, &copy);
    D3D11_MAPPED_SUBRESOURCE mapped{}; check(context->Map(cpu.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    Image image; image.width = region.right - region.left; image.height = region.bottom - region.top;
    image.pixels.resize(static_cast<size_t>(image.width) * image.height);
    for (int y = 0; y < image.height; ++y) for (int x = 0; x < image.width; ++x) {
        const auto p = coordinate(region.left + x, region.top + y);
        Pixel pixel = reinterpret_cast<const Pixel*>(static_cast<const uint8_t*>(mapped.pData) +
            static_cast<size_t>(p.y - box.top) * mapped.RowPitch)[p.x - box.left];
        if (source.Format == DXGI_FORMAT_R8G8B8A8_UNORM) std::swap(pixel.r, pixel.b);
        image.pixels[static_cast<size_t>(y) * image.width + x] = pixel;
    }
    context->Unmap(cpu.Get(), 0);
    image.metadata = Json::object({{"textureWidth", source.Width}, {"textureHeight", source.Height},
        {"format", source.Format}, {"rotation", rotation}});
    return image;
}

Image Graphics::desktop_region(RECT region) {
    if (!duplication) check(output->DuplicateOutput(device.Get(), &duplication));
    DXGI_OUTDUPL_FRAME_INFO info{}; ComPtr<IDXGIResource> resource;
    // Drop a queued frame. The fixture updates a footer continuously, so the next frame can prove freshness.
    HRESULT hr = duplication->AcquireNextFrame(0, &info, &resource);
    if (SUCCEEDED(hr)) { check(duplication->ReleaseFrame()); resource.Reset(); }
    else if (hr != DXGI_ERROR_WAIT_TIMEOUT) { duplication.Reset(); check(hr); }
    check(duplication->AcquireNextFrame(2000, &info, &resource));
    try {
        ComPtr<ID3D11Texture2D> texture; check(resource.As(&texture));
        RECT local = region; OffsetRect(&local, -output_desc.DesktopCoordinates.left, -output_desc.DesktopCoordinates.top);
        Image image = texture_region(texture.Get(), local, output_desc.Rotation);
        image.metadata["protectedContentMaskedOut"] = info.ProtectedContentMaskedOut != FALSE;
        image.metadata["lastPresentQpc"] = info.LastPresentTime.QuadPart;
        image.metadata["accumulatedFrames"] = info.AccumulatedFrames;
        check(duplication->ReleaseFrame()); return image;
    } catch (...) { duplication->ReleaseFrame(); throw; }
}

Image Graphics::wgc_region(HWND window, RECT region) {
    if (!GraphicsCaptureSession::IsSupported()) throw std::runtime_error("Windows Graphics Capture unsupported");
    auto interop = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{nullptr};
    if (window) check(interop->CreateForWindow(window, winrt::guid_of<IGraphicsCaptureItem>(), winrt::put_abi(item)));
    else check(interop->CreateForMonitor(output_desc.Monitor, winrt::guid_of<IGraphicsCaptureItem>(), winrt::put_abi(item)));
    auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item.Size());
    auto session = pool.CreateCaptureSession(item);
    Direct3D11CaptureFrame frame{nullptr};
    try {
        session.IsCursorCaptureEnabled(false); session.StartCapture();
        const auto start = GetTickCount64();
        do { frame = pool.TryGetNextFrame(); if (!frame) Sleep(10); } while (!frame && GetTickCount64() - start < 2500);
        if (!frame) throw std::runtime_error("WGC frame timeout (unavailable, not clean omission)");
        ComPtr<ID3D11Texture2D> texture;
        auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        check(access->GetInterface(IID_PPV_ARGS(&texture)));
        RECT origin = output_desc.DesktopCoordinates;
        if (window) check(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &origin, sizeof(origin)));
        RECT local = region; OffsetRect(&local, -origin.left, -origin.top);
        Image image = texture_region(texture.Get(), local);
        image.metadata["systemRelativeTime100ns"] = frame.SystemRelativeTime().count();
        image.metadata["contentWidth"] = frame.ContentSize().Width; image.metadata["contentHeight"] = frame.ContentSize().Height;
        image.metadata["target"] = window ? Json(handle_id(window)) : Json("monitor");
        frame.Close(); session.Close(); pool.Close(); return image;
    } catch (...) {
        if (frame) frame.Close(); session.Close(); pool.Close(); throw;
    }
}

Image gdi_region(RECT region) {
    GdiBitmap bitmap(region.right - region.left, region.bottom - region.top);
    if (!BitBlt(bitmap.memory, 0, 0, bitmap.width, bitmap.height, bitmap.screen, region.left, region.top, SRCCOPY | CAPTUREBLT))
        throw std::runtime_error("BitBlt failed: " + std::to_string(GetLastError()));
    return bitmap.region({0, 0, bitmap.width, bitmap.height});
}
Image print_region(HWND window, RECT region) {
    DWORD_PTR response = 0;
    if (!SendMessageTimeoutW(window, WM_NULL, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, &response))
        throw std::runtime_error("PrintWindow target did not respond to a bounded liveness check");
    RECT bounds{}; if (!GetWindowRect(window, &bounds)) throw std::runtime_error("PrintWindow target disappeared");
    GdiBitmap bitmap(bounds.right - bounds.left, bounds.bottom - bounds.top);
    if (!PrintWindow(window, bitmap.memory, PW_RENDERFULLCONTENT))
        throw std::runtime_error("PrintWindow failed: " + std::to_string(GetLastError()));
    OffsetRect(&region, -bounds.left, -bounds.top); return bitmap.region(region);
}
void save_bitmap(const std::filesystem::path& path, const Image& image) {
    static_assert(sizeof(Pixel) == 4);
    const auto size = image.pixels.size() * sizeof(Pixel);
    BITMAPFILEHEADER file{}; file.bfType = 0x4D42; file.bfOffBits = sizeof(file) + sizeof(BITMAPINFOHEADER);
    file.bfSize = static_cast<DWORD>(file.bfOffBits + size);
    BITMAPINFOHEADER info{}; info.biSize = sizeof(info); info.biWidth = image.width; info.biHeight = -image.height;
    info.biPlanes = 1; info.biBitCount = 32; info.biCompression = BI_RGB; info.biSizeImage = static_cast<DWORD>(size);
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write(reinterpret_cast<const char*>(&file), sizeof(file)); out.write(reinterpret_cast<const char*>(&info), sizeof(info));
    // BMP viewers disagree about BI_RGB alpha; force opaque pixels in the saved diagnostic.
    std::vector<Pixel> pixels = image.pixels; for (auto& pixel : pixels) pixel.a = 255;
    out.write(reinterpret_cast<const char*>(pixels.data()), size);
    if (!out) throw std::runtime_error("Cannot save bitmap");
}

Pixel background_pixel(int x, int y, int phase) {
    const Pixel colors[3][2] = {
        {{192, 96, 32, 255}, {144, 64, 48, 255}},
        {{80, 160, 64, 255}, {112, 112, 32, 255}},
        {{32, 112, 192, 255}, {64, 64, 160, 255}}
    };
    return colors[phase % 3][((x / 24) + (y / 24)) & 1];
}
Json evaluate_image(const Image& image, int phase, int local_x, int local_y) {
    if (image.pixels.empty()) throw std::runtime_error("Empty image is not a capture result");
    size_t background[3]{}, black = 0, magenta = 0, sentinel = 0;
    auto close = [](Pixel a, Pixel b) {
        return abs(int(a.r) - b.r) <= 6 && abs(int(a.g) - b.g) <= 6 && abs(int(a.b) - b.b) <= 6;
    };
    uint64_t hash = 14695981039346656037ULL;
    for (int y = 0; y < image.height; ++y) for (int x = 0; x < image.width; ++x) {
        auto pixel = image.pixels[static_cast<size_t>(y) * image.width + x];
        for (int candidate = 0; candidate < 3; ++candidate)
            if (close(pixel, background_pixel(local_x + x, local_y + y, candidate))) ++background[candidate];
        if (pixel.r <= 6 && pixel.g <= 6 && pixel.b <= 6) ++black;
        if (close(pixel, {255, 0, 255, 255})) ++magenta;
        if (pixel.r == 0xA5 && pixel.g == 0xA5 && pixel.b == 0xA5) ++sentinel;
        for (uint8_t component : {pixel.r, pixel.g, pixel.b}) { hash ^= component; hash *= 1099511628211ULL; }
    }
    const auto total = image.pixels.size();
    auto fraction = [total](size_t n) { return double(n) / double(total); };
    std::string classification = "mixed_or_unexpected";
    if (fraction(sentinel) >= 0.98) classification = "unpainted_capture_buffer";
    else if (background[phase] == total) classification = "live_background";
    else if (fraction(black) >= 0.98) classification = "black_mask";
    else if (fraction(magenta) >= 0.98) classification = "overlay_visible";
    else for (int i = 0; i < 3; ++i) if (i != phase && fraction(background[i]) >= 0.98) classification = "stale_or_wrong_background_phase";
    return Json::object({{"classification", classification}, {"pixelCount", total}, {"currentBackgroundMatch", fraction(background[phase])},
        {"backgroundPhaseMatches", Json::array({fraction(background[0]), fraction(background[1]), fraction(background[2])})},
        {"blackFraction", fraction(black)}, {"overlayFraction", fraction(magenta)}, {"unpaintedFraction", fraction(sentinel)},
        {"rgbFnv1a64", hex(hash)}, {"tolerancePerRgbChannel", 6}, {"uniformClassificationThreshold", 0.98},
        {"requiredBackgroundMatchForClean", 1.0}});
}

Json capture_suite(Graphics& graphics, HWND window, RECT region, int phase, int local_x, int local_y,
    const std::filesystem::path& directory, const std::string& prefix) {
    Json result = Json::array(); std::filesystem::create_directories(directory);
    const std::pair<std::string, std::function<Image()>> methods[] = {
        {"gdi_monitor", [&] { return gdi_region(region); }},
        {"print_window", [&] { return print_region(window, region); }},
        {"desktop_duplication", [&] { return graphics.desktop_region(region); }},
        {"wgc_window", [&] { return graphics.wgc_region(window, region); }},
        {"wgc_monitor", [&] { return graphics.wgc_region(nullptr, region); }}
    };
    for (const auto& [name, capture] : methods) {
        const auto start = GetTickCount64();
        Json entry = Json::object({{"method", name}, {"timestamp", utc_now()}});
        try {
            Image image = capture();
            entry["measurement"] = evaluate_image(image, phase, local_x, local_y);
            entry["metadata"] = image.metadata; entry["width"] = image.width; entry["height"] = image.height;
            auto filename = prefix + "-" + name + ".bmp";
            save_bitmap(directory / filename, image); entry["image"] = filename; entry["succeeded"] = true;
        } catch (const winrt::hresult_error& error) {
            entry["succeeded"] = false; entry["classification"] = "capture_unavailable";
            entry["hresult"] = hex(static_cast<uint32_t>(error.code().value)); entry["error"] = utf8(error.message().c_str());
        } catch (const std::exception& error) {
            entry["succeeded"] = false; entry["classification"] = "capture_unavailable"; entry["error"] = error.what();
        }
        entry["durationMs"] = GetTickCount64() - start; result.push(entry);
    }
    return result;
}
}
