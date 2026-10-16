#pragma once
#include "json.hpp"
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <functional>
#include <memory>

namespace wa {
using Microsoft::WRL::ComPtr;
struct Pixel { uint8_t b = 0, g = 0, r = 0, a = 255; };
struct Image {
    int width = 0, height = 0;
    std::vector<Pixel> pixels;
    Json metadata = Json::object();
};
class Graphics {
public:
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGIOutput1> output;
    ComPtr<IDXGIOutputDuplication> duplication;
    DXGI_OUTPUT_DESC output_desc{};
    DXGI_ADAPTER_DESC1 adapter_desc{};
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrt_device{nullptr};
    explicit Graphics(POINT screen_point);
    Image texture_region(ID3D11Texture2D* texture, RECT region, DXGI_MODE_ROTATION rotation = DXGI_MODE_ROTATION_IDENTITY);
    Image desktop_region(RECT screen_region);
    Image wgc_region(HWND window, RECT screen_region);
};
Image gdi_region(RECT screen_region);
Image print_region(HWND window, RECT screen_region);
void save_bitmap(const std::filesystem::path& path, const Image& image);
Json evaluate_image(const Image& image, int phase, int local_x, int local_y);
Pixel background_pixel(int x, int y, int phase);
Json capture_suite(Graphics& graphics, HWND window, RECT region, int phase, int local_x, int local_y,
    const std::filesystem::path& directory, const std::string& prefix);
}
