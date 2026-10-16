#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "real-app.hpp"
#include "capture.hpp"
#include <dwmapi.h>
#include <algorithm>
#include <array>
#include <cstdio>
#include <exception>
#include <functional>
#include <memory>
#include <optional>

namespace wa {
namespace {
constexpr int border = 24;
struct Options {
    HWND target = nullptr;
    std::filesystem::path control, output;
    DWORD seconds = 600;
    int phase = -1;
    POINT origin{};
    bool has_origin = false;
    bool desktop_content = false;
    std::string prefix;
};
int64_t integer(const std::wstring& value, int64_t minimum, int64_t maximum, int base = 10) {
    size_t consumed = 0;
    if (value.empty()) throw std::runtime_error("Missing numeric value");
    const auto parsed = std::stoll(value, &consumed, base);
    if (consumed != value.size() || parsed < minimum || parsed > maximum)
        throw std::runtime_error("Numeric argument outside allowed range");
    return parsed;
}
Options parse(const std::vector<std::wstring>& args) {
    Options options;
    for (size_t i = 1; i < args.size(); ++i) {
        const auto& arg = args[i];
        auto next = [&]() -> const std::wstring& {
            if (++i >= args.size()) throw std::runtime_error("Missing value after " + utf8(arg));
            return args[i];
        };
        if (arg == L"--hwnd") {
            const auto value = next(); size_t used = 0;
            const auto handle = std::stoull(value, &used, 0);
            if (!handle || used != value.size()) throw std::runtime_error("Invalid HWND");
            options.target = reinterpret_cast<HWND>(static_cast<uintptr_t>(handle));
        } else if (arg == L"--output") options.output = next();
        else if (arg == L"--control") options.control = next();
        else if (arg == L"--seconds") options.seconds = static_cast<DWORD>(integer(next(), 1, 3600));
        else if (arg == L"--phase") options.phase = static_cast<int>(integer(next(), 0, 2));
        else if (arg == L"--desktop-content") options.desktop_content = true;
        else if (arg == L"--origin") {
            const auto value = next(); const auto comma = value.find(L',');
            if (comma == std::wstring::npos || value.find(L',', comma + 1) != std::wstring::npos)
                throw std::runtime_error("--origin requires X,Y");
            options.origin = {static_cast<LONG>(integer(value.substr(0, comma), -100000, 100000)),
                static_cast<LONG>(integer(value.substr(comma + 1), -100000, 100000))};
            options.has_origin = true;
        } else if (arg == L"--prefix") options.prefix = utf8(next());
        else throw std::runtime_error("Unknown real-app argument: " + utf8(arg));
    }
    if (!options.target || options.output.empty()) throw std::runtime_error("--hwnd and --output are required");
    options.output = std::filesystem::absolute(options.output);
    if (args[0] == L"--reference-backdrop") {
        if (options.control.empty()) throw std::runtime_error("--reference-backdrop requires --control");
        options.control = std::filesystem::absolute(options.control);
        if (options.phase != -1 || options.has_origin || options.desktop_content || !options.prefix.empty())
            throw std::runtime_error("Capture-only options passed to reference mode");
    } else {
        if (options.prefix.empty()) throw std::runtime_error("--capture-real requires --prefix");
        if (options.desktop_content && (options.phase != -1 || options.has_origin))
            throw std::runtime_error("--desktop-content cannot be combined with --phase or --origin");
        if (!options.desktop_content && (options.phase < 0 || !options.has_origin))
            throw std::runtime_error("--capture-real requires --phase and --origin, or --desktop-content");
        if (options.prefix.size() > 80 || options.prefix.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos)
            throw std::runtime_error("--prefix must contain only letters, digits, underscore or hyphen");
        if (!options.control.empty()) throw std::runtime_error("--control is only valid for reference mode");
    }
    return options;
}
void atomic_json(const std::filesystem::path& path, const Json& value) {
    auto temporary = path; temporary += L".tmp-" + std::to_wstring(GetCurrentProcessId());
    write_json(temporary, value);
    if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("Cannot atomically replace status report: " + std::to_string(GetLastError()));
}
struct TargetState {
    HWND window = nullptr;
    DWORD pid = 0, tid = 0, affinity = 0, affinity_error = 0;
    bool exists = false, visible = false, topmost = false, affinity_ok = false, bounds_ok = false;
    RECT bounds{}, ordinary_bounds{};
    HRESULT bounds_hr = E_FAIL;
    DWORD rect_error = 0;
    bool rect_ok = false;
    Json json() const {
        return Json::object({{"hwnd", handle_id(window)}, {"pid", pid}, {"tid", tid}, {"exists", exists},
            {"visible", visible}, {"topmost", topmost}, {"bounds", bounds_ok ? rectangle(bounds) : Json()},
            {"dwmBoundsHresult", hex(static_cast<uint32_t>(bounds_hr))},
            {"windowRect", rect_ok ? rectangle(ordinary_bounds) : Json()}, {"windowRectError", rect_error},
            {"affinity", Json::object({{"querySucceeded", affinity_ok}, {"value", affinity_ok ? Json(affinity) : Json()},
                {"error", affinity_error}})}});
    }
};
TargetState target_state(HWND window) {
    TargetState state; state.window = window; state.exists = IsWindow(window) != FALSE;
    state.tid = GetWindowThreadProcessId(window, &state.pid); state.visible = IsWindowVisible(window) != FALSE;
    state.topmost = (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    state.bounds_hr = DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &state.bounds, sizeof(state.bounds));
    state.bounds_ok = SUCCEEDED(state.bounds_hr) && state.bounds.right > state.bounds.left && state.bounds.bottom > state.bounds.top;
    SetLastError(0); state.rect_ok = GetWindowRect(window, &state.ordinary_bounds) != FALSE;
    state.rect_error = state.rect_ok ? 0 : GetLastError();
    SetLastError(0); state.affinity_ok = GetWindowDisplayAffinity(window, &state.affinity) != FALSE;
    state.affinity_error = state.affinity_ok ? 0 : GetLastError();
    return state;
}
bool same_identity(const TargetState& current, const TargetState& original) {
    return current.exists && current.pid && current.tid && current.pid == original.pid && current.tid == original.tid;
}
bool same_rect(RECT a, RECT b) { return EqualRect(&a, &b) != FALSE; }
bool stable(const TargetState& before, const TargetState& after) {
    return same_identity(after, before) && before.bounds_ok && after.bounds_ok && same_rect(before.bounds, after.bounds) &&
        before.visible == after.visible && before.topmost == after.topmost && before.affinity_ok == after.affinity_ok &&
        (!before.affinity_ok || before.affinity == after.affinity);
}
void require_target(const TargetState& state) {
    if (!state.exists || !state.pid || !state.tid) throw std::runtime_error("Target HWND does not identify a live window");
    if (!state.bounds_ok) throw std::runtime_error("Target has no usable DWM frame bounds");
    const int64_t width = int64_t(state.bounds.right) - state.bounds.left;
    const int64_t height = int64_t(state.bounds.bottom) - state.bounds.top;
    if (width > 8192 || height > 8192 || width * height > 32000000)
        throw std::runtime_error("Target bounds exceed diagnostic image limits");
}
Json error_json(const std::exception_ptr& error) {
    try { std::rethrow_exception(error); }
    catch (const winrt::hresult_error& exception) {
        return Json::object({{"hresult", hex(static_cast<uint32_t>(exception.code().value))}, {"message", utf8(exception.message().c_str())}});
    } catch (const std::exception& exception) { return Json::object({{"message", exception.what()}}); }
    catch (...) { return Json::object({{"message", "Unknown exception"}}); }
}
struct BackdropState {
    HWND window = nullptr;
    RECT target{}, outer{}, refresh{};
    int phase = 0;
};
LRESULT CALLBACK backdrop_proc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (message == WM_NCCREATE) {
        auto create = reinterpret_cast<CREATESTRUCTW*>(lp);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
    }
    auto state = reinterpret_cast<BackdropState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    if (message == WM_NCHITTEST) return HTTRANSPARENT;
    if (message == WM_ERASEBKGND) return 1;
    if (state && message == WM_TIMER) { InvalidateRect(window, &state->refresh, FALSE); return 0; }
    if (state && message == WM_PAINT) {
        PAINTSTRUCT ps{}; HDC dc = BeginPaint(window, &ps);
        const int width = state->outer.right - state->outer.left, height = state->outer.bottom - state->outer.top;
        // Tile boundaries within the measured ROI coincide exactly with background_pixel(0,0,phase).
        for (int y = 0; y < height; y += 24) for (int x = 0; x < width; x += 24) {
            const auto pixel = background_pixel(x - border, y - border, state->phase);
            HBRUSH brush = CreateSolidBrush(RGB(pixel.r, pixel.g, pixel.b));
            RECT tile{x, y, std::min(x + 24, width), std::min(y + 24, height)};
            FillRect(dc, &tile, brush); DeleteObject(brush);
        }
        if (!IsRectEmpty(&state->refresh)) {
            const auto pulse = static_cast<BYTE>(32 + (GetTickCount64() / 40) % 192);
            HBRUSH brush = CreateSolidBrush(RGB(pulse, 80, 120)); FillRect(dc, &state->refresh, brush); DeleteObject(brush);
        }
        EndPaint(window, &ps); return 0;
    }
    return DefWindowProcW(window, message, wp, lp);
}
RECT refresh_strip(RECT target, RECT outer) {
    MONITORINFO monitor{sizeof(monitor)};
    if (!GetMonitorInfoW(MonitorFromRect(&target, MONITOR_DEFAULTTONEAREST), &monitor)) return {};
    const RECT strips[] = {{outer.left, target.bottom, outer.right, outer.bottom},
        {outer.left, outer.top, outer.right, target.top}, {outer.left, target.top, target.left, target.bottom},
        {target.right, target.top, outer.right, target.bottom}};
    for (const auto strip : strips) {
        RECT visible{};
        if (IntersectRect(&visible, &strip, &monitor.rcMonitor) && visible.right - visible.left >= 8 && visible.bottom - visible.top >= 8) {
            OffsetRect(&visible, -outer.left, -outer.top); return visible;
        }
    }
    return {};
}
std::optional<std::string> read_control(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary); if (!file) return {};
    std::string value; std::getline(file, value);
    if (value.size() >= 3 && static_cast<unsigned char>(value[0]) == 0xEF &&
        static_cast<unsigned char>(value[1]) == 0xBB && static_cast<unsigned char>(value[2]) == 0xBF) value.erase(0, 3);
    const auto begin = value.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return {};
    const auto end = value.find_last_not_of(" \t\r\n"); return value.substr(begin, end - begin + 1);
}
int reference_backdrop(const Options& options) {
    if (std::filesystem::exists(options.output) && !std::filesystem::is_empty(options.output))
        throw std::runtime_error("Reference output directory must be new or empty");
    std::filesystem::create_directories(options.output);
    const auto original = target_state(options.target); require_target(original);
    BackdropState state; state.target = original.bounds;
    state.outer = original.bounds; InflateRect(&state.outer, border, border);
    state.refresh = refresh_strip(state.target, state.outer);
    WNDCLASSW cls{}; cls.lpfnWndProc = backdrop_proc; cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = L"WindowAuditRealAppBackdrop";
    if (!RegisterClassW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
        throw std::runtime_error("Cannot register reference window class");
    state.window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | (original.topmost ? WS_EX_TOPMOST : 0), cls.lpszClassName,
        L"Window Audit reference background", WS_POPUP, state.outer.left, state.outer.top,
        state.outer.right - state.outer.left, state.outer.bottom - state.outer.top,
        nullptr, nullptr, cls.hInstance, &state);
    if (!state.window) throw std::runtime_error("Cannot create reference background: " + std::to_string(GetLastError()));
    struct OwnWindow { HWND value; ~OwnWindow() { if (IsWindow(value)) DestroyWindow(value); } } own{state.window};
    if (!SetTimer(state.window, 1, 40, nullptr)) throw std::runtime_error("Cannot start reference refresh timer");
    const auto started = GetTickCount64(); std::string last_status;
    std::string finish = "timeout"; bool first = true;
    for (;;) {
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
        if (auto command = read_control(options.control)) {
            if (*command == "stop") { finish = "control_stop"; break; }
            if (*command == "0" || *command == "1" || *command == "2") {
                const int phase = (*command)[0] - '0';
                if (phase != state.phase) { state.phase = phase; InvalidateRect(state.window, nullptr, FALSE); }
            }
        }
        const auto target = target_state(options.target);
        if (!same_identity(target, original)) { finish = "target_destroyed_or_reused"; break; }
        if (!target.bounds_ok) { finish = "target_bounds_unavailable"; break; }
        require_target(target);
        if (!same_rect(target.bounds, state.target)) {
            state.target = target.bounds; state.outer = target.bounds; InflateRect(&state.outer, border, border);
            state.refresh = refresh_strip(state.target, state.outer); InvalidateRect(state.window, nullptr, FALSE);
        }
        // Only this diagnostic's window is repositioned. The application's state is left untouched.
        const bool reference_topmost = (GetWindowLongPtrW(state.window, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
        if (reference_topmost != target.topmost && !SetWindowPos(state.window,
            target.topmost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER))
            throw std::runtime_error("Cannot match reference z-order band: " + std::to_string(GetLastError()));
        if (!SetWindowPos(state.window, options.target, state.outer.left, state.outer.top,
            state.outer.right - state.outer.left, state.outer.bottom - state.outer.top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER))
            throw std::runtime_error("Cannot position reference background: " + std::to_string(GetLastError()));
        UpdateWindow(state.window);
        Json status = Json::object({{"kind", "real-app-reference-background"}, {"state", "running"},
            {"phase", state.phase}, {"target", target.json()}, {"targetHwnd", handle_id(options.target)},
            {"targetPid", original.pid}, {"targetTid", original.tid}, {"targetBounds", rectangle(state.target)},
            {"origin", Json::object({{"x", state.target.left}, {"y", state.target.top}})},
            {"referenceHwnd", handle_id(state.window)}, {"referencePid", GetCurrentProcessId()},
            {"referenceBounds", rectangle(state.outer)}, {"referenceVisible", IsWindowVisible(state.window) != FALSE},
            {"referenceTopmost", (GetWindowLongPtrW(state.window, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0},
            {"referencePreviousWindow", handle_id(GetWindow(state.window, GW_HWNDPREV))},
            {"targetImmediatelyPrecedesReference", GetWindow(state.window, GW_HWNDPREV) == options.target},
            {"refreshStripLocal", rectangle(state.refresh)}, {"refreshStripOnMonitor", !IsRectEmpty(&state.refresh)},
            {"targetModified", false}, {"controlFile", options.control.wstring()}});
        const auto fingerprint = status.dump(-1);
        if (first || fingerprint != last_status) {
            status["dwmFlushHresult"] = hex(static_cast<uint32_t>(DwmFlush()));
            status["timestamp"] = utc_now(); atomic_json(options.output / L"status.json", status);
            last_status = fingerprint; first = false;
        }
        if (GetTickCount64() - started >= uint64_t(options.seconds) * 1000) break;
        Sleep(20);
    }
    atomic_json(options.output / L"status.json", Json::object({{"kind", "real-app-reference-background"},
        {"state", "stopped"}, {"reason", finish}, {"timestamp", utc_now()}, {"phase", state.phase},
        {"target", target_state(options.target).json()}, {"targetHwnd", handle_id(options.target)},
        {"targetPid", original.pid}, {"targetTid", original.tid}, {"targetBounds", rectangle(state.target)},
        {"origin", Json::object({{"x", state.target.left}, {"y", state.target.top}})},
        {"referenceHwnd", handle_id(state.window)}, {"referencePid", GetCurrentProcessId()},
        {"durationMs", GetTickCount64() - started}}));
    return finish == "control_stop" || finish == "timeout" ? 0 : 2;
}
Json desktop_measurement(const Image& image) {
    if (image.pixels.empty()) throw std::runtime_error("Empty image is not a capture result");
    size_t exact_black = 0, near_black = 0;
    uint64_t hash = 14695981039346656037ULL;
    for (const auto& pixel : image.pixels) {
        if (!pixel.r && !pixel.g && !pixel.b) ++exact_black;
        if (pixel.r <= 6 && pixel.g <= 6 && pixel.b <= 6) ++near_black;
        for (const uint8_t component : {pixel.r, pixel.g, pixel.b}) { hash ^= component; hash *= 1099511628211ULL; }
    }
    return Json::object({{"classification", "uncalibrated_desktop_content"}, {"pixelCount", image.pixels.size()},
        {"exactBlackPixelCount", exact_black}, {"nearBlackPixelCount", near_black},
        {"blackFraction", double(exact_black) / double(image.pixels.size())}, {"rgbFnv1a64", hex(hash)},
        {"pixelHashOrder", "row-major RGB bytes; alpha excluded"}, {"blackPixelsAreNotMaskVerdict", true}});
}
struct RegionOptions {
    DWORD app_pid = 0;
    RECT region{};
    bool has_region = false;
    std::filesystem::path output;
    std::string prefix;
};
RegionOptions parse_region_options(const std::vector<std::wstring>& args) {
    RegionOptions options;
    for (size_t i = 1; i < args.size(); ++i) {
        const auto& arg = args[i];
        auto next = [&]() -> const std::wstring& {
            if (++i >= args.size()) throw std::runtime_error("Missing value after " + utf8(arg));
            return args[i];
        };
        if (arg == L"--app-pid") options.app_pid = static_cast<DWORD>(integer(next(), 1, MAXDWORD));
        else if (arg == L"--region") {
            const auto value = next(); std::array<LONG, 4> coordinates{};
            size_t begin = 0;
            for (size_t coordinate = 0; coordinate < coordinates.size(); ++coordinate) {
                const auto end = value.find(L',', begin);
                if ((coordinate < 3 && end == std::wstring::npos) || (coordinate == 3 && end != std::wstring::npos))
                    throw std::runtime_error("--region requires LEFT,TOP,RIGHT,BOTTOM");
                coordinates[coordinate] = static_cast<LONG>(integer(value.substr(begin,
                    end == std::wstring::npos ? end : end - begin), -100000, 100000));
                begin = end == std::wstring::npos ? value.size() : end + 1;
            }
            options.region = {coordinates[0], coordinates[1], coordinates[2], coordinates[3]};
            options.has_region = true;
        } else if (arg == L"--output") options.output = next();
        else if (arg == L"--prefix") options.prefix = utf8(next());
        else throw std::runtime_error("Unknown region-capture argument: " + utf8(arg));
    }
    if (!options.app_pid || !options.has_region || options.output.empty() || options.prefix.empty())
        throw std::runtime_error("--capture-region requires --app-pid, --region, --output and --prefix");
    if (options.app_pid == GetCurrentProcessId())
        throw std::runtime_error("Application PID must be separate from the capture observer");
    if (options.prefix.size() > 80 || options.prefix.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos)
        throw std::runtime_error("--prefix must contain only letters, digits, underscore or hyphen");
    const int64_t width = int64_t(options.region.right) - options.region.left;
    const int64_t height = int64_t(options.region.bottom) - options.region.top;
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 32000000)
        throw std::runtime_error("Capture region must be nonempty and within diagnostic image limits");
    options.output = std::filesystem::absolute(options.output);
    return options;
}
struct ApplicationState {
    DWORD pid = 0;
    bool running = false, query_succeeded = false;
    uint64_t creation_filetime = 0;
    std::wstring executable_path;
    Json query_errors = Json::array();
    Json json() const {
        return Json::object({{"pid", pid}, {"running", running}, {"querySucceeded", query_succeeded},
            {"creationFiletime", creation_filetime ? Json(std::to_string(creation_filetime)) : Json()},
            {"executablePath", executable_path.empty() ? Json() : Json(executable_path)}, {"queryErrors", query_errors}});
    }
};
ApplicationState application_state(DWORD pid) {
    ApplicationState state; state.pid = pid;
    auto error = [&](const char* api, DWORD code) { state.query_errors.push(Json::object({{"api", api}, {"error", code}})); };
    SetLastError(0); Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
    if (!process.value) { error("OpenProcess", GetLastError()); return state; }
    const auto wait = WaitForSingleObject(process, 0);
    const bool liveness_ok = wait == WAIT_TIMEOUT || wait == WAIT_OBJECT_0;
    state.running = wait == WAIT_TIMEOUT;
    if (!liveness_ok) error("WaitForSingleObject.process", GetLastError());
    FILETIME created{}, exited{}, kernel{}, user{}; SetLastError(0);
    const bool time_ok = GetProcessTimes(process, &created, &exited, &kernel, &user) != FALSE;
    if (time_ok) state.creation_filetime = (uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    else error("GetProcessTimes", GetLastError());
    wchar_t filename[32768]{}; DWORD length = static_cast<DWORD>(std::size(filename)); SetLastError(0);
    const bool path_ok = QueryFullProcessImageNameW(process, 0, filename, &length) != FALSE;
    if (path_ok) state.executable_path.assign(filename, length); else error("QueryFullProcessImageName", GetLastError());
    state.query_succeeded = liveness_ok && time_ok && path_ok;
    return state;
}
bool same_application(const ApplicationState& current, const ApplicationState& original) {
    return current.query_succeeded && original.query_succeeded && current.running && original.running &&
        current.pid == original.pid && current.creation_filetime && current.creation_filetime == original.creation_filetime &&
        !current.executable_path.empty() && !original.executable_path.empty() &&
        CompareStringOrdinal(current.executable_path.c_str(), -1, original.executable_path.c_str(), -1, TRUE) == CSTR_EQUAL;
}
int capture_region(const RegionOptions& options) {
    std::filesystem::create_directories(options.output);
    const auto report_path = options.output / (options.prefix + "-report.json");
    if (std::filesystem::exists(report_path)) throw std::runtime_error("Capture prefix already has a report; choose a fresh prefix");
    const std::array<std::string, 3> names{"gdi_monitor", "desktop_duplication", "wgc_monitor"};
    for (const auto& name : names) if (std::filesystem::exists(options.output / (options.prefix + "-" + name + ".bmp")))
        throw std::runtime_error("Capture prefix already has images; choose a fresh prefix");
    const auto original = application_state(options.app_pid);
    Json report = Json::object({{"schemaVersion", 1}, {"kind", "real-app-monitor-region-capture"}, {"timestamp", utc_now()},
        {"observerPid", GetCurrentProcessId()}, {"applicationPid", options.app_pid}, {"application", original.json()},
        {"applicationIdentityVerifiedAtStart", same_application(original, original)}, {"region", rectangle(options.region)},
        {"targetWindowRequired", false}, {"applicationModified", false}, {"backgroundWindowCreated", false},
        {"physicalPanelVisibilityVerified", false}, {"desktopContentRequiresPairedReferences", true},
        {"methods", Json::array()}, {"successfulCaptureCount", 0}, {"captureAttemptCount", names.size()}, {"completed", false},
        {"coverageLimits", Json::array({"The caller supplies an explicit screen rectangle; this does not require or discover a target overlay HWND",
            "A targetless capture command does not establish that the application has no helper HWNDs; raw window discovery is separate",
            "The application process must remain running with the same creation FILETIME and executable path around each sample",
            "Process identity checks do not reveal renderer visibility or guarantee the sampled pixels came from that process",
            "Ordinary desktop pixels are unclassified; matched hidden-before/shown/hidden-after references require independent verification",
            "Natural black pixels are not themselves evidence of a protection mask; errors never count as clean omission",
            "GPU capture is limited to one selected output; an unsupported cross-output rectangle remains an explicit API failure",
            "Capture omission does not establish physical panel visibility or invisibility to every local observer"})}});
    atomic_json(report_path, report);
    std::unique_ptr<Graphics> graphics; bool graphics_attempted = false; std::exception_ptr graphics_error;
    auto get_graphics = [&]() -> Graphics& {
        if (!graphics_attempted) {
            graphics_attempted = true;
            try { graphics = std::make_unique<Graphics>(POINT{(options.region.left + options.region.right) / 2,
                (options.region.top + options.region.bottom) / 2}); }
            catch (...) { graphics_error = std::current_exception(); }
        }
        if (graphics_error) std::rethrow_exception(graphics_error);
        return *graphics;
    };
    size_t successful = 0;
    for (const auto& name : names) {
        const auto start = GetTickCount64(); const auto before = application_state(options.app_pid);
        Json entry = Json::object({{"method", name}, {"timestamp", utc_now()}, {"applicationBefore", before.json()}});
        try {
            if (!same_application(before, original)) throw std::runtime_error("Application is unavailable or process identity changed before capture");
            Image image;
            if (name == "gdi_monitor") image = gdi_region(options.region);
            else if (name == "desktop_duplication") image = get_graphics().desktop_region(options.region);
            else image = get_graphics().wgc_region(nullptr, options.region);
            const auto after = application_state(options.app_pid);
            entry["applicationAfter"] = after.json(); entry["applicationStateStable"] = same_application(after, before);
            entry["applicationIdentityMatchesInitial"] = same_application(after, original);
            entry["measurement"] = desktop_measurement(image);
            entry["classification"] = same_application(after, before) && same_application(after, original) ?
                Json("uncalibrated_desktop_content") : Json("application_identity_changed_during_capture");
            entry["width"] = image.width; entry["height"] = image.height; entry["metadata"] = image.metadata;
            const auto filename = options.prefix + "-" + name + ".bmp";
            save_bitmap(options.output / filename, image); entry["image"] = filename;
            entry["succeeded"] = true; ++successful;
        } catch (...) {
            entry["succeeded"] = false; entry["classification"] = "capture_unavailable";
            entry["error"] = error_json(std::current_exception());
            const auto after = application_state(options.app_pid); entry["applicationAfter"] = after.json();
            entry["applicationStateStable"] = same_application(after, before);
            entry["applicationIdentityMatchesInitial"] = same_application(after, original);
        }
        entry["durationMs"] = GetTickCount64() - start; report["methods"].push(entry);
        report["successfulCaptureCount"] = successful; atomic_json(report_path, report);
    }
    report["applicationAfter"] = application_state(options.app_pid).json();
    report["finishedAt"] = utc_now(); report["completed"] = true;
    if (graphics_error) report["graphicsInitializationError"] = error_json(graphics_error);
    atomic_json(report_path, report);
    std::printf("Application monitor-region capture: %zu/%zu methods returned pixels.\nReport: %s\n", successful,
        names.size(), report_path.u8string().c_str());
    return successful ? 0 : 2;
}
int capture_real(const Options& options) {
    std::filesystem::create_directories(options.output);
    const auto report_path = options.output / (options.prefix + "-report.json");
    if (std::filesystem::exists(report_path)) throw std::runtime_error("Capture prefix already has a report; choose a fresh prefix");
    const std::array<std::string, 4> names{"gdi_monitor", "desktop_duplication", "wgc_monitor", "wgc_window"};
    for (const auto& name : names) if (std::filesystem::exists(options.output / (options.prefix + "-" + name + ".bmp")))
        throw std::runtime_error("Capture prefix already has images; choose a fresh prefix");
    const auto original = target_state(options.target); require_target(original);
    Json report = Json::object({{"schemaVersion", 1},
        {"kind", options.desktop_content ? "real-app-desktop-content-capture" : "real-app-capture"}, {"timestamp", utc_now()},
        {"observerPid", GetCurrentProcessId()}, {"target", original.json()},
        {"region", rectangle(original.bounds)}, {"targetModified", false},
        {"backgroundWindowCreated", false},
        {"physicalPanelVisibilityVerified", false}, {"methods", Json::array()},
        {"coverageLimits", Json::array({
            "Only the actual target DWM frame rectangle is sampled; this is not every application process or every monitor",
            "Window captures can be black or unavailable for an excluded window while monitor captures remain clean",
            "Before/after identity checks cannot rule out every change occurring entirely between those checks",
            "A successful capture or clean omission does not establish physical panel visibility"})}});
    if (options.desktop_content) {
        report["desktopContentRequiresPairedReferences"] = true;
        report["coverageLimits"].push("Ordinary desktop content is captured unchanged; no predefined background or reference window is created");
        report["coverageLimits"].push("Natural black pixels are measured but cannot establish a protection mask without matched hidden-app controls");
        report["coverageLimits"].push("Native samples are uncalibrated; exact saved-image comparisons and freshness evidence require independent verification");
    } else {
        report["phase"] = options.phase;
        report["referenceOrigin"] = Json::object({{"x", options.origin.x}, {"y", options.origin.y}});
        report["coverageLimits"].push("Reference phase and origin are supplied by the caller and require separately validated hidden-app controls");
    }
    std::unique_ptr<Graphics> graphics; bool graphics_attempted = false; std::exception_ptr graphics_error;
    auto get_graphics = [&]() -> Graphics& {
        if (!graphics_attempted) {
            graphics_attempted = true;
            try { graphics = std::make_unique<Graphics>(POINT{(original.bounds.left + original.bounds.right) / 2,
                (original.bounds.top + original.bounds.bottom) / 2}); }
            catch (...) { graphics_error = std::current_exception(); }
        }
        if (graphics_error) std::rethrow_exception(graphics_error);
        return *graphics;
    };
    size_t successful = 0;
    for (const auto& name : names) {
        const auto start = GetTickCount64(); const auto before = target_state(options.target);
        Json entry = Json::object({{"method", name}, {"timestamp", utc_now()}, {"targetBefore", before.json()}});
        try {
            if (!same_identity(before, original)) throw std::runtime_error("Target destroyed or identity changed before capture");
            if (!before.bounds_ok || !same_rect(before.bounds, original.bounds))
                throw std::runtime_error("Target geometry changed before capture; request a fresh capture");
            Image image;
            if (name == "gdi_monitor") image = gdi_region(original.bounds);
            else if (name == "desktop_duplication") image = get_graphics().desktop_region(original.bounds);
            else if (name == "wgc_monitor") image = get_graphics().wgc_region(nullptr, original.bounds);
            else image = get_graphics().wgc_region(options.target, original.bounds);
            const auto after = target_state(options.target);
            entry["targetAfter"] = after.json(); entry["targetStateStable"] = stable(before, after);
            entry["targetIdentityMatchesInitial"] = same_identity(after, original);
            entry["measurement"] = options.desktop_content ? desktop_measurement(image) :
                evaluate_image(image, options.phase, original.bounds.left - options.origin.x, original.bounds.top - options.origin.y);
            const auto& measurement = std::get<Json::Object>(entry["measurement"].value);
            entry["classification"] = stable(before, after) && same_identity(after, original) ?
                measurement.at("classification") : Json("target_state_changed_during_capture");
            entry["width"] = image.width; entry["height"] = image.height; entry["metadata"] = image.metadata;
            const auto filename = options.prefix + "-" + name + ".bmp";
            save_bitmap(options.output / filename, image); entry["image"] = filename;
            entry["succeeded"] = true; ++successful;
        } catch (...) {
            entry["succeeded"] = false; entry["classification"] = "capture_unavailable";
            entry["error"] = error_json(std::current_exception());
            const auto after = target_state(options.target); entry["targetAfter"] = after.json();
            entry["targetStateStable"] = stable(before, after);
            entry["targetIdentityMatchesInitial"] = same_identity(after, original);
        }
        entry["durationMs"] = GetTickCount64() - start; report["methods"].push(entry);
        atomic_json(report_path, report);
    }
    report["finishedAt"] = utc_now(); report["successfulCaptureCount"] = successful;
    report["captureAttemptCount"] = names.size(); report["completed"] = true;
    if (graphics_error) report["graphicsInitializationError"] = error_json(graphics_error);
    atomic_json(report_path, report);
    std::printf("Real application capture: %zu/%zu methods returned pixels.\nReport: %s\n", successful,
        names.size(), report_path.u8string().c_str());
    return successful ? 0 : 2;
}
}
int real_app_mode(const std::vector<std::wstring>& args) {
    if (!args.empty() && args[0] == L"--capture-region") return capture_region(parse_region_options(args));
    if (args.empty() || (args[0] != L"--reference-backdrop" && args[0] != L"--capture-real"))
        throw std::runtime_error("Unknown real-app command");
    const auto options = parse(args);
    return args[0] == L"--reference-backdrop" ? reference_backdrop(options) : capture_real(options);
}
}
