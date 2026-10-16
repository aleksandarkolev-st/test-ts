#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "fixture.hpp"
#include "audit.hpp"
#include "capture.hpp"
#include <dcomp.h>
#include <dwmapi.h>
#include <presentation.h>
#include <algorithm>
#include <array>
#include <cstdio>
#include <memory>

namespace wa {
namespace {
constexpr DWORD protocol_version = 1;
constexpr size_t max_fixture_windows = 16;
struct FixtureWindow { uint64_t hwnd = 0; char role[48]{}; };
struct Shared {
    DWORD version = protocol_version;
    DWORD observer_pid = 0, renderer_pid = 0;
    uint64_t foreign_parent = 0, host = 0, capture_target = 0, primary_subject = 0;
    LONG origin_x = 0, origin_y = 0;
    RECT sample{};
    LONG requested_case = 0, requested_phase = 0, request_id = 0, acknowledged_id = 0;
    LONG error_code = 0;
    char error[512]{};
    DWORD affinity_set_error = 0, affinity_read_error = 0, affinity_value = 0;
    BOOL affinity_set_result = FALSE, affinity_read_result = FALSE, affinity_attempted = FALSE;
    DWORD count = 0;
    FixtureWindow windows[max_fixture_windows]{};
};
struct Mapping {
    void* view = nullptr;
    ~Mapping() { if (view) UnmapViewOfFile(view); }
};
struct OwnWindow {
    HWND value = nullptr;
    ~OwnWindow() { if (value && IsWindow(value)) DestroyWindow(value); }
};
void check(HRESULT hr) { winrt::check_hresult(hr); }
void paint(HWND window, HDC dc, bool background, int phase) {
    RECT bounds{}; GetClientRect(window, &bounds);
    if (!background) {
        HBRUSH brush = CreateSolidBrush(RGB(255, 0, 255)); FillRect(dc, &bounds, brush); DeleteObject(brush); return;
    }
    for (int y = 0; y < bounds.bottom; y += 24) for (int x = 0; x < bounds.right; x += 24) {
        auto color = background_pixel(x, y, phase); HBRUSH brush = CreateSolidBrush(RGB(color.r, color.g, color.b));
        RECT tile{x, y, std::min<LONG>(x + 24, bounds.right), std::min<LONG>(y + 24, bounds.bottom)};
        FillRect(dc, &tile, brush); DeleteObject(brush);
    }
    // A changing footer forces fresh desktop frames without changing the sampled pattern.
    const auto pulse = static_cast<BYTE>(32 + (GetTickCount64() / 30) % 192);
    RECT footer{0, bounds.bottom - 20, bounds.right, bounds.bottom};
    HBRUSH brush = CreateSolidBrush(RGB(pulse, 80, 120)); FillRect(dc, &footer, brush); DeleteObject(brush);
}
struct PaintState { bool background = false; int phase = 0; };
LRESULT CALLBACK fixture_proc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (message == WM_NCCREATE) {
        auto create = reinterpret_cast<CREATESTRUCTW*>(lp);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
    }
    auto state = reinterpret_cast<PaintState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    if (state && (message == WM_PAINT || message == WM_PRINTCLIENT)) {
        PAINTSTRUCT ps{}; HDC dc = message == WM_PAINT ? BeginPaint(window, &ps) : reinterpret_cast<HDC>(wp);
        paint(window, dc, state->background, state->phase);
        if (message == WM_PAINT) EndPaint(window, &ps); return 0;
    }
    if (message == WM_TIMER) { RECT r{}; GetClientRect(window, &r); r.top = r.bottom - 20; InvalidateRect(window, &r, FALSE); return 0; }
    return DefWindowProcW(window, message, wp, lp);
}
void register_class(const wchar_t* name, WNDPROC procedure) {
    WNDCLASSW cls{}; cls.lpfnWndProc = procedure; cls.hInstance = GetModuleHandleW(nullptr); cls.lpszClassName = name;
    if (!RegisterClassW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) throw std::runtime_error("RegisterClass failed");
}
HWND make_fixture(Shared& shared, const char* role, const wchar_t* title, DWORD style, DWORD ex,
    HWND parent, int x, int y, int width, int height, PaintState* state) {
    HWND window = CreateWindowExW(ex, L"WindowAuditFixture", title, style, x, y, width, height,
        parent, nullptr, GetModuleHandleW(nullptr), state);
    if (!window) throw std::runtime_error("CreateWindowEx failed: " + std::to_string(GetLastError()));
    if (shared.count >= max_fixture_windows) { DestroyWindow(window); throw std::runtime_error("Fixture capacity exceeded"); }
    auto& item = shared.windows[shared.count++]; item.hwnd = reinterpret_cast<uint64_t>(window); strcpy_s(item.role, role);
    return window;
}
struct Surface {
    Handle surface_handle;
    ComPtr<IPresentationManager> manager;
    ComPtr<IPresentationSurface> surface;
    ComPtr<IPresentationBuffer> buffer;
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<IDCompositionDevice3> composition;
    ComPtr<IDCompositionTarget> target;
    ComPtr<IDCompositionVisual2> visual;
    ComPtr<IDCompositionColorMatrixEffect> effect;
    Surface(Graphics& g, HWND host, bool protect, bool alpha_effect) {
        ComPtr<IPresentationFactory> factory; check(CreatePresentationFactory(g.device.Get(), IID_PPV_ARGS(&factory)));
        if (!factory->IsPresentationSupported()) throw std::runtime_error("Presentation surfaces unsupported");
        check(factory->CreatePresentationManager(&manager));
        check(DCompositionCreateSurfaceHandle(COMPOSITIONOBJECT_ALL_ACCESS, nullptr, &surface_handle.value));
        check(manager->CreatePresentationSurface(surface_handle, &surface));
        check(surface->SetAlphaMode(DXGI_ALPHA_MODE_IGNORE)); check(surface->SetColorSpace(DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709));
        check(surface->SetDisableReadback(protect));
        RECT source{0, 0, 256, 144}; check(surface->SetSourceRect(&source));
        PresentationTransform identity{1, 0, 0, 1, 0, 0}; check(surface->SetTransform(&identity));
        D3D11_TEXTURE2D_DESC description{}; description.Width = 256; description.Height = 144;
        description.MipLevels = description.ArraySize = description.SampleDesc.Count = 1;
        description.Format = DXGI_FORMAT_B8G8R8A8_UNORM; description.Usage = D3D11_USAGE_DEFAULT;
        description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        description.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
        check(g.device->CreateTexture2D(&description, nullptr, &texture));
        ComPtr<ID3D11RenderTargetView> view; check(g.device->CreateRenderTargetView(texture.Get(), nullptr, &view));
        const float magenta[]{1, 0, 1, 1}; g.context->ClearRenderTargetView(view.Get(), magenta); g.context->Flush();
        check(manager->AddBufferFromResource(texture.Get(), &buffer)); check(surface->SetBuffer(buffer.Get()));
        ComPtr<IDXGIDevice> dxgi; check(g.device.As(&dxgi)); ComPtr<IDCompositionDesktopDevice> desktop;
        check(DCompositionCreateDevice3(dxgi.Get(), IID_PPV_ARGS(&desktop))); check(desktop.As(&composition));
        check(desktop->CreateTargetForHwnd(host, TRUE, &target)); check(composition->CreateVisual(&visual));
        ComPtr<IUnknown> content; check(desktop->CreateSurfaceFromHandle(surface_handle, &content)); check(visual->SetContent(content.Get()));
        check(visual->SetOffsetX(48.0f)); check(visual->SetOffsetY(48.0f));
        if (alpha_effect) {
            check(composition->CreateColorMatrixEffect(&effect));
            D2D1_MATRIX_5X4_F matrix{}; matrix._11 = matrix._22 = matrix._33 = 1; matrix._14 = 1;
            check(effect->SetMatrix(matrix)); check(effect->SetAlphaMode(D2D1_COLORMATRIX_ALPHA_MODE_PREMULTIPLIED));
            check(effect->SetClampOutput(TRUE)); check(visual->SetEffect(effect.Get()));
        }
        check(target->SetRoot(visual.Get())); check(composition->Commit()); check(manager->Present());
    }
    ~Surface() {
        // Explicitly detach before the next fixture case; releasing a live target alone can leave stale visuals.
        if (target && composition) { target->SetRoot(nullptr); composition->Commit(); DwmFlush(); }
    }
};
const char* case_names[] = {"background_only", "ordinary_tool_popup", "wda_monitor_popup", "wda_excluded_popup",
    "ordinary_child", "affinity_requested_on_child", "exclude_then_reparent", "surface_unprotected_alpha",
    "surface_protected", "surface_protected_alpha"};
constexpr int case_count = static_cast<int>(std::size(case_names));

DWORD wait_with_messages(const HANDLE* handles, DWORD count, DWORD timeout) {
    const auto start = GetTickCount64();
    for (;;) {
        const auto elapsed = GetTickCount64() - start;
        if (elapsed >= timeout) return WAIT_TIMEOUT;
        DWORD result = MsgWaitForMultipleObjects(count, handles, FALSE, static_cast<DWORD>(timeout - elapsed), QS_ALLINPUT);
        if (result != WAIT_OBJECT_0 + count) return result;
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
}

class FixtureSession {
public:
    Handle mapping, command, ready, process, thread;
    Mapping mapped;
    OwnWindow foreign_parent;
    // On constructor failure, kill the child before destroying its cross-process parent.
    Handle job;
    Shared* shared = nullptr;
    DWORD renderer_pid = 0;
    std::wstring name;
    FixtureSession() {
        register_class(L"WindowAuditObserverRoot", DefWindowProcW);
        foreign_parent.value = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, L"WindowAuditObserverRoot",
            L"WindowAudit: own cross-process parent", WS_POPUP, 0, 0, 24, 24, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!foreign_parent.value) throw std::runtime_error("Cannot create owned cross-process fixture parent");
        name = L"Local\\WindowAudit_" + std::to_wstring(GetCurrentProcessId()) + L"_" + std::to_wstring(GetTickCount64());
        mapping.value = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name.c_str());
        if (!mapping.value || GetLastError() == ERROR_ALREADY_EXISTS) throw std::runtime_error("Cannot create unique fixture mapping");
        mapped.view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared));
        if (!mapped.view) throw std::runtime_error("Cannot map fixture protocol");
        shared = new(mapped.view) Shared{}; shared->observer_pid = GetCurrentProcessId();
        shared->foreign_parent = reinterpret_cast<uint64_t>(foreign_parent.value);
        command.value = CreateEventW(nullptr, FALSE, FALSE, (name + L"_command").c_str());
        ready.value = CreateEventW(nullptr, FALSE, FALSE, (name + L"_ready").c_str());
        job.value = CreateJobObjectW(nullptr, nullptr);
        if (!command.value || !ready.value || !job.value) throw std::runtime_error("Cannot create fixture handles");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) throw std::runtime_error("Cannot configure fixture job");
        wchar_t executable[32768]{}; GetModuleFileNameW(nullptr, executable, static_cast<DWORD>(std::size(executable)));
        std::wstring line = L"\"" + std::wstring(executable) + L"\" --fixture \"" + name + L"\"";
        STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION child{};
        if (!CreateProcessW(nullptr, line.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup, &child))
            throw std::runtime_error("Cannot start independent fixture process: " + std::to_string(GetLastError()));
        process.value = child.hProcess; thread.value = child.hThread; renderer_pid = child.dwProcessId;
        if (!AssignProcessToJobObject(job, process)) { TerminateProcess(process, 4); throw std::runtime_error("Cannot isolate fixture lifetime in job"); }
        if (ResumeThread(thread) == static_cast<DWORD>(-1)) throw std::runtime_error("Cannot resume fixture process");
        wait_ready(10000);
    }
    void wait_ready(DWORD timeout) {
        HANDLE handles[]{process.value, ready.value};
        DWORD result = wait_with_messages(handles, 2, timeout);
        if (result != WAIT_OBJECT_0 + 1) throw std::runtime_error(result == WAIT_OBJECT_0 ? "Fixture exited before acknowledgement" : "Fixture acknowledgement timeout");
        MemoryBarrier();
        if (shared->error_code) throw std::runtime_error(shared->error);
    }
    void configure(int selected, int phase) {
        shared->requested_case = selected; shared->requested_phase = phase; ++shared->request_id;
        MemoryBarrier(); SetEvent(command); wait_ready(8000);
        if (shared->acknowledged_id != shared->request_id) throw std::runtime_error("Fixture protocol sequence mismatch");
        Sleep(180); DwmFlush();
    }
    ~FixtureSession() {
        if (process.value && WaitForSingleObject(process, 0) == WAIT_TIMEOUT) {
            if (shared && command.value) { shared->requested_case = -1; MemoryBarrier(); SetEvent(command); }
            HANDLE handles[]{process.value};
            if (wait_with_messages(handles, 1, 3000) == WAIT_TIMEOUT) TerminateProcess(process, 5);
            WaitForSingleObject(process, 1000);
        }
    }
};
std::string text_at(const Json& json, const std::string& key) {
    return std::get<std::string>(std::get<Json::Object>(json.value).at(key).value);
}
bool bool_at(const Json& json, const std::string& key) {
    return std::get<bool>(std::get<Json::Object>(json.value).at(key).value);
}
Json classifier_test(bool& passed) {
    Json tests = Json::array(); passed = true;
    auto test = [&](const std::string& name, const Image& image, int phase, const std::string& expected) {
        auto measured = evaluate_image(image, phase, 72, 72); bool matches = text_at(measured, "classification") == expected;
        tests.push(Json::object({{"name", name}, {"expected", expected}, {"measurement", measured}, {"passed", matches}})); passed &= matches;
    };
    Image current; current.width = 48; current.height = 48; current.pixels.resize(48 * 48);
    for (int phase = 0; phase < 3; ++phase) {
        for (int y = 0; y < 48; ++y) for (int x = 0; x < 48; ++x) current.pixels[y * 48 + x] = background_pixel(72 + x, 72 + y, phase);
        test("current_background_phase_" + std::to_string(phase), current, phase, "live_background");
        test("stale_background_phase_" + std::to_string(phase), current, (phase + 1) % 3, "stale_or_wrong_background_phase");
    }
    Image one_bad_pixel = current; one_bad_pixel.pixels[0] = {0, 0, 0, 255};
    test("one_black_pixel_is_not_clean", one_bad_pixel, 2, "mixed_or_unexpected");
    Image plain = current; std::fill(plain.pixels.begin(), plain.pixels.end(), Pixel{0, 0, 0, 255});
    test("black_cannot_pass_as_clean", plain, 0, "black_mask");
    std::fill(plain.pixels.begin(), plain.pixels.end(), Pixel{255, 0, 255, 255}); test("visible_overlay", plain, 0, "overlay_visible");
    std::fill(plain.pixels.begin(), plain.pixels.end(), Pixel{0xA5, 0xA5, 0xA5, 255}); test("untouched_buffer", plain, 0, "unpainted_capture_buffer");
    std::fill(current.pixels.begin(), current.pixels.begin() + current.pixels.size() / 2, Pixel{0, 0, 0, 255});
    test("partial_mask_is_not_clean", current, 2, "mixed_or_unexpected");
    return tests;
}
}

int fixture_process(const std::wstring& mapping_name) {
    Handle mapping(OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mapping_name.c_str())); Mapping mapped;
    if (!mapping.value) return 10;
    mapped.view = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)); if (!mapped.view) return 11;
    auto& shared = *static_cast<Shared*>(mapped.view);
    Handle command(OpenEventW(SYNCHRONIZE, FALSE, (mapping_name + L"_command").c_str()));
    Handle ready(OpenEventW(EVENT_MODIFY_STATE, FALSE, (mapping_name + L"_ready").c_str()));
    Handle observer(OpenProcess(SYNCHRONIZE, FALSE, shared.observer_pid));
    if (shared.version != protocol_version || !command.value || !ready.value || !observer.value) return 12;
    shared.renderer_pid = GetCurrentProcessId();
    std::vector<HWND> cleanup;
    PaintState background{true, 0}, magenta{false, 0};
    try {
        register_class(L"WindowAuditFixture", fixture_proc);
        MONITORINFO monitor{}; monitor.cbSize = sizeof(monitor);
        if (!GetMonitorInfoW(MonitorFromPoint({80, 80}, MONITOR_DEFAULTTOPRIMARY), &monitor)) throw std::runtime_error("Cannot query fixture monitor");
        shared.origin_x = monitor.rcWork.left + 40; shared.origin_y = monitor.rcWork.top + 40;
        const int x = shared.origin_x, y = shared.origin_y;
        shared.sample = {x + 48, y + 48, x + 304, y + 192};
        auto create = [&](const char* role, const wchar_t* title, DWORD style, DWORD ex, HWND parent,
            int left, int top, int w, int h, PaintState* paint_state) {
            HWND result = make_fixture(shared, role, title, style, ex, parent, left, top, w, h, paint_state);
            cleanup.push_back(result); return result;
        };
        const DWORD tool = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        HWND host = create("scene_host", L"WindowAudit: changing reference background", WS_POPUP, WS_EX_NOACTIVATE,
            nullptr, x, y, 384, 256, &background); shared.host = reinterpret_cast<uint64_t>(host);
        HWND popup = create("tool_popup", L"WindowAudit: tool overlay", WS_POPUP, tool | WS_EX_LAYERED,
            nullptr, x + 48, y + 48, 256, 144, &magenta);
        SetLayeredWindowAttributes(popup, 0, 255, LWA_ALPHA);
        HWND child = create("child", L"WindowAudit: child", WS_CHILD, WS_EX_NOACTIVATE, host, 48, 48, 256, 144, &magenta);
        create("grandchild", L"WindowAudit: nested grandchild", WS_CHILD | WS_VISIBLE, 0, child, 4, 4, 20, 20, &magenta);
        create("hidden_root", L"WindowAudit: hidden nonempty title", WS_POPUP, tool, nullptr, -32000, -32000, 80, 40, &magenta);
        create("owned_popup", L"WindowAudit: owned popup", WS_POPUP, tool, host, x + 310, y + 10, 32, 32, &magenta);
        create("message_only", L"WindowAudit: message-only", 0, 0, HWND_MESSAGE, 0, 0, 0, 0, &magenta);
        create("foreign_child", L"WindowAudit: child under our observer's parent", WS_CHILD, 0,
            reinterpret_cast<HWND>(shared.foreign_parent), 0, 0, 12, 12, &magenta);
        HWND transparent = create("zero_alpha", L"WindowAudit: zero opacity", WS_POPUP, tool | WS_EX_LAYERED | WS_EX_TRANSPARENT,
            nullptr, x, y, 16, 16, &magenta);
        SetLayeredWindowAttributes(transparent, 0, 0, LWA_ALPHA); ShowWindow(transparent, SW_SHOWNOACTIVATE);
        HWND reparented = create("reparented_popup", L"WindowAudit: popup exclusion then own-parent reparent", WS_POPUP,
            tool | WS_EX_LAYERED, nullptr, x + 48, y + 48, 256, 144, &magenta);
        SetLayeredWindowAttributes(reparented, 0, 255, LWA_ALPHA);
        SetWindowPos(host, HWND_TOPMOST, x, y, 384, 256, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        SetTimer(host, 1, 30, nullptr); UpdateWindow(host);
        std::unique_ptr<Graphics> graphics; std::unique_ptr<Surface> surface;
        shared.capture_target = shared.host; shared.primary_subject = shared.host;
        MemoryBarrier(); SetEvent(ready);
        const auto start = GetTickCount64(); bool done = false;
        while (!done && IsWindow(host) && GetTickCount64() - start < 180000) {
            HANDLE handles[]{command.value, observer.value};
            DWORD result = MsgWaitForMultipleObjects(2, handles, FALSE, 30, QS_ALLINPUT);
            if (result == WAIT_OBJECT_0 + 1) break;
            if (result == WAIT_OBJECT_0) {
                MemoryBarrier();
                int selected = shared.requested_case;
                if (selected == -1) break;
                shared.error_code = 0; shared.error[0] = 0;
                try {
                    if (selected < 0 || selected >= case_count || shared.requested_phase < 0 || shared.requested_phase > 2)
                        throw std::runtime_error("Invalid fixture command");
                    surface.reset(); ShowWindow(popup, SW_HIDE); ShowWindow(child, SW_HIDE); ShowWindow(reparented, SW_HIDE);
                    SetWindowDisplayAffinity(popup, WDA_NONE); SetWindowDisplayAffinity(reparented, WDA_NONE);
                    if (GetWindowLongPtrW(reparented, GWL_STYLE) & WS_CHILD) {
                        SetParent(reparented, nullptr);
                        auto style = GetWindowLongPtrW(reparented, GWL_STYLE);
                        SetWindowLongPtrW(reparented, GWL_STYLE, (style & ~WS_CHILD) | WS_POPUP);
                        SetWindowPos(reparented, nullptr, x + 48, y + 48, 256, 144, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                    }
                    background.phase = shared.requested_phase;
                    InvalidateRect(host, nullptr, FALSE); UpdateWindow(host);
                    SetWindowPos(host, HWND_TOPMOST, x, y, 384, 256, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                    HWND subject = host, capture_target = host;
                    shared.affinity_attempted = shared.affinity_set_result = shared.affinity_read_result = FALSE;
                    shared.affinity_set_error = shared.affinity_read_error = shared.affinity_value = 0;
                    if (selected >= 1 && selected <= 3) subject = capture_target = popup;
                    if (selected == 4 || selected == 5) subject = child;
                    if (selected == 6) subject = reparented;
                    if (selected == 2 || selected == 3 || selected == 5 || selected == 6) {
                        shared.affinity_attempted = TRUE; SetLastError(0);
                        shared.affinity_set_result = SetWindowDisplayAffinity(subject, selected == 2 ? WDA_MONITOR : WDA_EXCLUDEFROMCAPTURE);
                        shared.affinity_set_error = shared.affinity_set_result ? 0 : GetLastError();
                    }
                    if (selected == 6) {
                        auto style = GetWindowLongPtrW(subject, GWL_STYLE);
                        SetWindowLongPtrW(subject, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD);
                        SetLastError(0); SetParent(subject, host);
                        if (GetAncestor(subject, GA_PARENT) != host) throw std::runtime_error("Owned-fixture reparent failed");
                        SetWindowPos(subject, HWND_TOP, 48, 48, 256, 144, SWP_NOACTIVATE | SWP_FRAMECHANGED);
                    }
                    if (selected >= 7) {
                        if (!graphics) graphics = std::make_unique<Graphics>(POINT{x + 80, y + 80});
                        surface = std::make_unique<Surface>(*graphics, host, selected != 7, selected != 8);
                    }
                    if (subject != host) {
                        SetWindowPos(subject, (selected <= 3) ? HWND_TOPMOST : HWND_TOP, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW); UpdateWindow(subject);
                    }
                    SetLastError(0); shared.affinity_read_result = GetWindowDisplayAffinity(subject, &shared.affinity_value);
                    shared.affinity_read_error = shared.affinity_read_result ? 0 : GetLastError();
                    shared.capture_target = reinterpret_cast<uint64_t>(capture_target);
                    shared.primary_subject = reinterpret_cast<uint64_t>(subject);
                    DwmFlush();
                } catch (const winrt::hresult_error& error) {
                    shared.error_code = error.code().value; strcpy_s(shared.error, utf8(error.message().c_str()).c_str());
                } catch (const std::exception& error) { shared.error_code = 1; strcpy_s(shared.error, error.what()); }
                shared.acknowledged_id = shared.request_id; MemoryBarrier(); SetEvent(ready);
            }
            MSG message{};
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
                if (message.message == WM_QUIT) { done = true; break; }
                TranslateMessage(&message); DispatchMessageW(&message);
            }
        }
        surface.reset();
    } catch (const winrt::hresult_error& error) {
        shared.error_code = error.code().value; strcpy_s(shared.error, utf8(error.message().c_str()).c_str()); MemoryBarrier(); SetEvent(ready);
    } catch (const std::exception& error) { shared.error_code = 1; strcpy_s(shared.error, error.what()); MemoryBarrier(); SetEvent(ready); }
    for (auto it = cleanup.rbegin(); it != cleanup.rend(); ++it) if (IsWindow(*it)) DestroyWindow(*it);
    return shared.error_code ? 13 : 0;
}

int self_test(const std::filesystem::path& directory, bool capture) {
    if (std::filesystem::exists(directory / "report.json")) throw std::runtime_error("Choose a fresh self-test output directory");
    std::filesystem::create_directories(directory);
    bool classifier_pass = false; Json classifier_results = classifier_test(classifier_pass);
    FixtureSession fixture; auto& shared = *fixture.shared;
    if (fixture.renderer_pid == GetCurrentProcessId() || fixture.renderer_pid != shared.renderer_pid)
        throw std::runtime_error("Self-test renderer is not independent");
    Snapshot enumeration = audit_windows(fixture.renderer_pid);
    write_json(directory / "enumeration.json", enumeration.report);
    bool enumeration_pass = true; Json expected = Json::array();
    std::map<std::string, std::string> role_handles;
    for (DWORD i = 0; i < shared.count; ++i) role_handles[shared.windows[i].role] = hex(shared.windows[i].hwnd);
    for (DWORD i = 0; i < shared.count; ++i) {
        const auto& item = shared.windows[i]; auto found = enumeration.windows.find(static_cast<uintptr_t>(item.hwnd));
        bool matched = found != enumeration.windows.end() && found->second.pid == fixture.renderer_pid && !found->second.sources.empty();
        bool correct_path = matched;
        if (matched && std::string(item.role) == "message_only") correct_path = found->second.sources.count("FindWindowEx.messageOnly") != 0;
        if (matched && (std::string(item.role) == "grandchild" || std::string(item.role) == "foreign_child"))
            correct_path = found->second.sources.count("EnumChildWindows") != 0 && found->second.sources.count("FindWindowEx.child") != 0;
        bool metadata = matched;
        if (matched) {
            const auto& fields = std::get<Json::Object>(found->second.json.value);
            const std::string role = item.role;
            if (role == "foreign_child") metadata = text_at(found->second.json, "parent") == hex(shared.foreign_parent) &&
                std::get<int64_t>(fields.at("parentPid").value) == GetCurrentProcessId();
            if (role == "grandchild") metadata = text_at(found->second.json, "parent") == role_handles["child"];
            if (role == "owned_popup") metadata = text_at(found->second.json, "owner") == role_handles["scene_host"];
            if (role == "hidden_root") metadata = !bool_at(found->second.json, "visible");
            if (role == "zero_alpha") metadata = std::get<int64_t>(std::get<Json::Object>(fields.at("layeredAttributes").value).at("alpha").value) == 0;
        }
        enumeration_pass &= matched && correct_path && metadata;
        expected.push(Json::object({{"role", item.role}, {"hwnd", hex(item.hwnd)}, {"found", matched}, {"requiredDiscoveryPathsPresent", correct_path},
            {"expectedMetadataPresent", metadata}, {"sources", matched ? found->second.json["enumerationSources"] : Json::array()}}));
    }
    fixture.configure(1, 0); auto shown = audit_windows(fixture.renderer_pid);
    fixture.configure(0, 1); auto hidden = audit_windows(fixture.renderer_pid);
    auto shown_changes = window_changes(enumeration, shown), hidden_changes = window_changes(shown, hidden);
    const auto popup_key = static_cast<uintptr_t>(std::stoull(role_handles["tool_popup"], nullptr, 16));
    bool watch_pass = shown.windows.count(popup_key) && hidden.windows.count(popup_key) &&
        bool_at(shown.windows.at(popup_key).json, "visible") && !bool_at(hidden.windows.at(popup_key).json, "visible") &&
        shown.windows.at(popup_key).fingerprint != hidden.windows.at(popup_key).fingerprint;
    write_json(directory / "watch-fixture.json", Json::object({{"shownChanges", shown_changes}, {"hiddenChanges", hidden_changes}, {"passed", watch_pass}}));
    Json report = Json::object({{"schemaVersion", 1}, {"kind", "window-audit-self-test"}, {"timestamp", utc_now()},
        {"observerPid", GetCurrentProcessId()}, {"rendererPid", fixture.renderer_pid}, {"independentProcesses", true},
        {"enumerationPassed", enumeration_pass}, {"fixtureWindows", expected}, {"captureRequested", capture},
        {"classifierTests", classifier_results}, {"classifierPassed", classifier_pass}, {"watchFixturePassed", watch_pass},
        {"physicalDisplayVisibilityVerified", false}, {"allLocalSoftwareInvisibilityProven", false},
        {"limits", Json::array({"Owned synthetic fixtures; no third-party application or driver is modified",
            "Clean captures do not establish physical display visibility",
            "A user-mode audit cannot prove detection of every local-software observation method",
            "Window capture targets differ from monitor capture; inspect captureTarget in each case",
            "Only the recorded ROI, phases, APIs, OS, and driver are measured"})}});
    Json cases = Json::array();
    std::map<std::string, std::map<std::string, std::vector<std::string>>> classifications;
    if (capture) {
        Graphics graphics({shared.sample.left, shared.sample.top});
        report["gpu"] = Json::object({{"description", std::wstring(graphics.adapter_desc.Description)},
            {"vendorId", hex(graphics.adapter_desc.VendorId)}, {"deviceId", hex(graphics.adapter_desc.DeviceId)},
            {"output", std::wstring(graphics.output_desc.DeviceName)}, {"rotation", graphics.output_desc.Rotation}});
        report["sampleRegion"] = rectangle(shared.sample); report["backgroundTileSize"] = 24;
        report["sampleLocalOrigin"] = Json::object({{"x", shared.sample.left - shared.origin_x}, {"y", shared.sample.top - shared.origin_y}});
        report["sampleRegionCoversFullFixtureOverlay"] = true;
        for (int selected = 0; selected < case_count; ++selected) {
            Json entry = Json::object({{"name", case_names[selected]}, {"phases", Json::array()}});
            std::printf("Testing %s\n", case_names[selected]); std::fflush(stdout);
            for (int phase = 0; phase < 3; ++phase) {
                Json phase_result = Json::object({{"phase", phase}});
                try {
                    fixture.configure(selected, phase);
                    auto subject = reinterpret_cast<HWND>(shared.primary_subject);
                    phase_result["primarySubject"] = handle_id(subject);
                    phase_result["captureTarget"] = hex(shared.capture_target);
                    phase_result["affinityAttempt"] = Json::object({{"attempted", shared.affinity_attempted != FALSE},
                        {"setSucceeded", shared.affinity_set_result != FALSE}, {"setError", shared.affinity_set_error},
                        {"readSucceeded", shared.affinity_read_result != FALSE}, {"readError", shared.affinity_read_error},
                        {"readValue", shared.affinity_read_result ? Json(shared.affinity_value) : Json()}});
                    if (phase == 0) {
                        auto current = audit_windows(fixture.renderer_pid);
                        const auto found = current.windows.find(reinterpret_cast<uintptr_t>(subject));
                        phase_result["subjectEnumerable"] = found != current.windows.end() && !found->second.sources.empty();
                        if (found != current.windows.end()) phase_result["subjectWindow"] = found->second.json;
                        auto name = std::string(case_names[selected]) + "-windows.json";
                        write_json(directory / name, current.report); entry["windowSnapshot"] = name;
                    }
                    const auto prefix = std::string(case_names[selected]) + "-phase" + std::to_string(phase);
                    auto samples = capture_suite(graphics, reinterpret_cast<HWND>(shared.capture_target), shared.sample,
                        phase, shared.sample.left - shared.origin_x, shared.sample.top - shared.origin_y, directory, prefix);
                    for (const auto& sample : std::get<Json::Array>(samples.value)) {
                        auto method = text_at(sample, "method");
                        const auto& fields = std::get<Json::Object>(sample.value);
                        const auto classification = bool_at(sample, "succeeded") ? text_at(fields.at("measurement"), "classification") : "capture_unavailable";
                        classifications[case_names[selected]][method].push_back(classification);
                    }
                    phase_result["captures"] = samples;
                } catch (const std::exception& error) { phase_result["error"] = error.what(); }
                entry["phases"].push(phase_result);
                // Preserve completed evidence even if a later graphics call or fixture fails.
                report["cases"] = cases; report["caseInProgress"] = entry; write_json(directory / "progress.json", report);
            }
            cases.push(entry);
        }
    }
    auto all_three = [&](const std::string& name, const std::string& method, const std::string& expected_class) {
        const auto& values = classifications[name][method];
        return values.size() == 3 && std::all_of(values.begin(), values.end(), [&](const auto& v) { return v == expected_class; });
    };
    Json control_results = Json::array(); bool controls_pass = capture;
    for (const char* method : {"gdi_monitor", "desktop_duplication", "wgc_monitor"}) if (capture) {
        bool bg = all_three("background_only", method, "live_background");
        bool overlay = all_three("ordinary_tool_popup", method, "overlay_visible");
        bool mask = all_three("wda_monitor_popup", method, "black_mask");
        bool exclusion = all_three("wda_excluded_popup", method, "live_background");
        bool passed = bg && overlay && mask && exclusion; controls_pass &= passed;
        control_results.push(Json::object({{"method", method}, {"liveBackgroundControl", bg}, {"visibleOverlayControl", overlay},
            {"blackMaskControl", mask}, {"captureExclusionControl", exclusion}, {"passed", passed}}));
    }
    report["caseInProgress"] = nullptr; report["cases"] = cases;
    report["captureControls"] = control_results; report["captureControlsPassed"] = capture ? Json(controls_pass) : Json();
    report["diagnosticSelfTestPassed"] = enumeration_pass && classifier_pass && watch_pass && (!capture || controls_pass);
    write_json(directory / "report.json", report);
    std::printf("Enumeration fixtures: %s (%lu windows)\n", enumeration_pass ? "PASS" : "FAIL", shared.count);
    if (capture) std::printf("Monitor capture controls: %s\n", controls_pass ? "PASS" : "FAIL / INCONCLUSIVE - inspect report");
    std::printf("Report: %s\n", (directory / "report.json").u8string().c_str());
    return enumeration_pass && classifier_pass && watch_pass && (!capture || controls_pass) ? 0 : 2;
}
}
