#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "audit.hpp"
#include "fixture.hpp"
#include "real-app.hpp"
#include <winrt/base.h>
#include <atomic>
#include <cstdio>

namespace {
std::atomic<bool> stopping{false};
BOOL WINAPI console_handler(DWORD reason) {
    if (reason == CTRL_C_EVENT || reason == CTRL_BREAK_EVENT) { stopping = true; return TRUE; }
    return FALSE;
}
uint64_t number(const std::wstring& text, uint64_t minimum, uint64_t maximum) {
    if (text.empty() || text.find_first_not_of(L"0123456789") != std::wstring::npos) throw std::runtime_error("Expected a decimal integer");
    auto value = std::stoull(text); if (value < minimum || value > maximum) throw std::runtime_error("Numeric argument outside allowed range"); return value;
}
std::wstring timestamp_name() {
    auto text = wa::utc_now(); std::wstring result(text.begin(), text.end());
    for (auto& c : result) if (c == L':') c = L'-';
    return result + L"-" + std::to_wstring(GetCurrentProcessId());
}
void help() {
    std::puts("Window Audit - read-only HWND diagnostics and controlled capture experiments\n"
        "  window-audit.exe [--pid PID | --all] [--output report.json]\n"
        "  window-audit.exe [--pid PID] --watch SECONDS [--interval-ms 750] [--output watch.json]\n"
        "  window-audit.exe --self-test [--output NEW_DIRECTORY]\n"
        "  window-audit.exe --enumeration-test [--output NEW_DIRECTORY]\n"
        "  window-audit.exe --capture-real --hwnd HWND --phase 0..2 --origin X,Y --output DIR --prefix NAME\n"
        "  window-audit.exe --capture-real --hwnd HWND --desktop-content --output DIR --prefix NAME\n"
        "  window-audit.exe --capture-region --app-pid PID --region L,T,R,B --output DIR --prefix NAME\n"
        "  window-audit.exe --reference-backdrop --hwnd HWND --control FILE --output DIR [--seconds 600]\n"
        "  --current-desktop-only   Skip the accessible-desktop enumeration pass\n\n"
        "Default audit includes hidden, untitled, tool, child, owner and message-only windows.\n"
        "--pid retains ancestors/owners from other processes as labelled context.\n"
        "Watch mode records additions, removals and property changes; Ctrl+C saves and stops.\n"
        "Self-test temporarily shows owned test windows on the primary monitor.\n"
        "--capture-real samples an external actual window's frame; normal audits capture no pixels.\n"
        "--capture-region samples an explicit screen rectangle and verifies app process identity, without a target HWND.\n"
        "Findings are properties, not malware verdicts or universal detection guarantees.");
}
}
int wmain(int argc, wchar_t** argv) {
    try {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        if (argc == 3 && std::wstring(argv[1]) == L"--fixture") return wa::fixture_process(argv[2]);
        if (argc > 1 && (std::wstring(argv[1]) == L"--capture-real" || std::wstring(argv[1]) == L"--reference-backdrop" ||
            std::wstring(argv[1]) == L"--capture-region"))
            return wa::real_app_mode(std::vector<std::wstring>(argv + 1, argv + argc));
        DWORD pid = 0, watch_seconds = 0, interval_ms = 750;
        bool test = false, capture = true, desktops = true;
        std::filesystem::path output;
        for (int i = 1; i < argc; ++i) {
            std::wstring arg = argv[i];
            auto next = [&]() -> std::wstring { if (++i >= argc) throw std::runtime_error("Missing value after argument"); return argv[i]; };
            if (arg == L"--help" || arg == L"-h") { help(); return 0; }
            else if (arg == L"--pid") pid = static_cast<DWORD>(number(next(), 1, MAXDWORD));
            else if (arg == L"--all") pid = 0;
            else if (arg == L"--watch") watch_seconds = static_cast<DWORD>(number(next(), 1, 3600));
            else if (arg == L"--interval-ms") interval_ms = static_cast<DWORD>(number(next(), 100, 10000));
            else if (arg == L"--output") output = next();
            else if (arg == L"--self-test") test = true;
            else if (arg == L"--enumeration-test") { test = true; capture = false; }
            else if (arg == L"--current-desktop-only") desktops = false;
            else throw std::runtime_error("Unknown argument: " + wa::utf8(arg));
        }
        if (test && (pid || watch_seconds)) throw std::runtime_error("Self-test cannot be combined with --pid or --watch");
        const std::filesystem::path base = std::filesystem::path(L"artifacts") / L"window-audit";
        if (output.empty()) output = test ? base / (L"self-test-" + timestamp_name()) : base / (L"audit-" + timestamp_name() + L".json");
        output = std::filesystem::absolute(output);
        if (test) return wa::self_test(output, capture);
        auto snapshot = wa::audit_windows(pid, desktops);
        if (!watch_seconds) {
            wa::write_json(output, snapshot.report);
            size_t target_count = 0; for (const auto& [key, record] : snapshot.windows) if (!pid || record.pid == pid) ++target_count;
            std::printf("Observed %zu target windows (%zu including relationships).\nReport: %s\n", target_count,
                snapshot.windows.size(), output.u8string().c_str()); return 0;
        }
        SetConsoleCtrlHandler(console_handler, TRUE);
        wa::Json report = wa::Json::object({{"schemaVersion", 1}, {"kind", "window-audit-watch"}, {"startedAt", wa::utc_now()},
            {"requestedSeconds", watch_seconds}, {"minimumIntervalMs", interval_ms}, {"baseline", snapshot.report},
            {"events", wa::Json::array()}, {"completed", false}});
        wa::write_json(output, report);
        const auto start = GetTickCount64(); size_t polls = 0, event_batches = 0;
        std::printf("Watching for %lu seconds; Ctrl+C saves and stops.\nReport: %s\n", watch_seconds, output.u8string().c_str()); std::fflush(stdout);
        while (!stopping && GetTickCount64() - start < uint64_t(watch_seconds) * 1000) {
            Sleep(interval_ms); if (stopping) break;
            auto next = wa::audit_windows(pid, desktops); auto changes = wa::window_changes(snapshot, next); ++polls;
            const auto count = std::get<wa::Json::Array>(changes.value).size();
            if (count) {
                report["events"].push(wa::Json::object({{"timestamp", wa::utc_now()}, {"elapsedMs", GetTickCount64() - start}, {"changes", changes}}));
                ++event_batches; std::printf("%zu change(s) at %llu ms\n", count, GetTickCount64() - start); std::fflush(stdout);
                report["lastSnapshot"] = next.report; wa::write_json(output, report);
            }
            snapshot = std::move(next);
            if (event_batches >= 10000) { report["eventLimitReached"] = true; break; }
        }
        report["lastSnapshot"] = snapshot.report; report["finishedAt"] = wa::utc_now(); report["polls"] = polls;
        report["completed"] = !stopping; report["stoppedByUser"] = stopping.load();
        wa::write_json(output, report); return 0;
    } catch (const winrt::hresult_error& error) {
        std::fprintf(stderr, "Window Audit: %s (%s)\n", wa::utf8(error.message().c_str()).c_str(), wa::hex(static_cast<uint32_t>(error.code().value)).c_str());
    } catch (const std::exception& error) { std::fprintf(stderr, "Window Audit: %s\n", error.what()); }
    return 1;
}
