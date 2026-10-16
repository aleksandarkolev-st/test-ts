#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "audit.hpp"
#include <tlhelp32.h>
#include <dwmapi.h>
#include <algorithm>
#include <deque>
#include <unordered_set>

namespace wa {
namespace {
constexpr size_t window_limit = 100000;
struct Discovery {
    std::map<uintptr_t, std::set<std::string>> sources;
    std::map<uintptr_t, std::set<std::string>> desktops;
    Json calls = Json::array();
    bool truncated = false;
    std::string source;
    std::string desktop;
    bool add(HWND h) {
        if (!h) return false;
        const auto key = reinterpret_cast<uintptr_t>(h);
        if (sources.size() >= window_limit && !sources.count(key)) { truncated = true; return false; }
        sources[key].insert(source);
        if (!desktop.empty()) desktops[key].insert(desktop);
        return true;
    }
};
BOOL CALLBACK collect(HWND window, LPARAM context) {
    return reinterpret_cast<Discovery*>(context)->add(window) ? TRUE : FALSE;
}
std::wstring object_name(HANDLE object) {
    DWORD size = 0; GetUserObjectInformationW(object, UOI_NAME, nullptr, 0, &size);
    if (!size || size > 65536) return {};
    std::vector<wchar_t> data(size / sizeof(wchar_t) + 1);
    if (!GetUserObjectInformationW(object, UOI_NAME, data.data(), size, &size)) return {};
    return data.data();
}
BOOL CALLBACK enum_desktop(LPWSTR name, LPARAM context) {
    auto& state = *reinterpret_cast<Discovery*>(context);
    SetLastError(0);
    HDESK desktop = OpenDesktopW(name, 0, FALSE, DESKTOP_READOBJECTS | DESKTOP_ENUMERATE);
    DWORD error = desktop ? 0 : GetLastError();
    BOOL ok = FALSE;
    if (desktop) {
        state.source = "EnumDesktopWindows"; state.desktop = utf8(name); SetLastError(0);
        ok = EnumDesktopWindows(desktop, collect, context); error = ok ? 0 : GetLastError(); CloseDesktop(desktop);
    }
    state.calls.push(Json::object({{"api", "EnumDesktopWindows"}, {"desktop", utf8(name)},
        {"opened", desktop != nullptr}, {"succeeded", ok != FALSE}, {"error", error}}));
    state.desktop.clear(); return TRUE;
}
void find_siblings(Discovery& state, HWND parent) {
    std::unordered_set<uintptr_t> visited;
    HWND previous = nullptr;
    for (size_t count = 0; count < window_limit; ++count) {
        HWND child = FindWindowExW(parent, previous, nullptr, nullptr);
        if (!child) return;
        if (!visited.insert(reinterpret_cast<uintptr_t>(child)).second) {
            state.calls.push(Json::object({{"api", "FindWindowEx"}, {"parent", handle_id(parent)}, {"cycleDetected", true}})); return;
        }
        if (!state.add(child)) return;
        previous = child;
    }
    state.truncated = true;
}
Json string_set(const std::set<std::string>& entries) {
    Json result = Json::array(); for (const auto& entry : entries) result.push(entry); return result;
}
Json process_info(DWORD pid, const std::wstring& snapshot_name, bool in_snapshot) {
    Json result = Json::object({{"pid", pid}, {"snapshotName", snapshot_name}, {"presentInProcessSnapshot", in_snapshot}});
    SetLastError(0); Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    if (!process.value) { result["queryError"] = GetLastError(); return result; }
    wchar_t path[32768]{}; DWORD size = static_cast<DWORD>(std::size(path)); SetLastError(0);
    if (QueryFullProcessImageNameW(process, 0, path, &size)) result["executablePath"] = std::wstring(path, size);
    else result["pathQueryError"] = GetLastError();
    FILETIME created{}, exited{}, kernel{}, user{};
    if (GetProcessTimes(process, &created, &exited, &kernel, &user))
        result["creationFiletime"] = hex((uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime);
    DWORD session = 0; if (ProcessIdToSessionId(pid, &session)) result["sessionId"] = session;
    return result;
}
DWORD window_pid(HWND h) { DWORD pid = 0; GetWindowThreadProcessId(h, &pid); return pid; }
}

Snapshot audit_windows(DWORD target_pid, bool accessible_desktops) {
    const auto started = GetTickCount64();
    Discovery state;
    state.source = "EnumWindows"; state.desktop = utf8(object_name(GetThreadDesktop(GetCurrentThreadId())));
    SetLastError(0); BOOL ok = EnumWindows(collect, reinterpret_cast<LPARAM>(&state));
    state.calls.push(Json::object({{"api", "EnumWindows"}, {"succeeded", ok != FALSE}, {"error", ok ? 0 : GetLastError()}}));
    state.desktop.clear();
    if (accessible_desktops) {
        SetLastError(0); ok = EnumDesktopsW(GetProcessWindowStation(), enum_desktop, reinterpret_cast<LPARAM>(&state));
        state.calls.push(Json::object({{"api", "EnumDesktops"}, {"succeeded", ok != FALSE}, {"error", ok ? 0 : GetLastError()}}));
    }
    std::map<DWORD, std::wstring> processes;
    {
        Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
        if (snapshot.value == INVALID_HANDLE_VALUE) state.calls.push(Json::object({{"api", "Process32Snapshot"}, {"error", GetLastError()}}));
        else {
            PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
            if (Process32FirstW(snapshot, &entry)) do { processes[entry.th32ProcessID] = entry.szExeFile; } while (Process32NextW(snapshot, &entry));
        }
    }
    size_t thread_count = 0, thread_windows = 0;
    {
        Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0));
        if (snapshot.value == INVALID_HANDLE_VALUE) state.calls.push(Json::object({{"api", "Thread32Snapshot"}, {"error", GetLastError()}}));
        else {
            THREADENTRY32 entry{}; entry.dwSize = sizeof(entry);
            if (Thread32First(snapshot, &entry)) do {
                // Enumerate every thread: a target's child may be under another process's root.
                state.source = "EnumThreadWindows";
                const auto before = state.sources.size(); EnumThreadWindows(entry.th32ThreadID, collect, reinterpret_cast<LPARAM>(&state));
                thread_windows += state.sources.size() - before; ++thread_count;
                // A FALSE return is normal for threads with no nonchild windows.
            } while (Thread32Next(snapshot, &entry));
        }
    }
    state.calls.push(Json::object({{"api", "EnumThreadWindows"}, {"threadsVisited", thread_count}, {"additionalHandles", thread_windows},
        {"note", "FALSE with no nonchild windows is not treated as an API error"}}));
    state.source = "FindWindowEx.topLevel"; find_siblings(state, nullptr);
    state.source = "FindWindowEx.messageOnly"; find_siblings(state, HWND_MESSAGE);
    std::vector<HWND> roots;
    for (const auto& [key, sources] : state.sources) roots.push_back(reinterpret_cast<HWND>(key));
    state.source = "EnumChildWindows";
    for (HWND root : roots) {
        // EnumChildWindows already walks descendants; recurse only in the independent FindWindowEx pass.
        EnumChildWindows(root, collect, reinterpret_cast<LPARAM>(&state));
        if (state.truncated) break;
    }
    std::deque<HWND> pending;
    for (const auto& [key, sources] : state.sources) pending.push_back(reinterpret_cast<HWND>(key));
    std::unordered_set<uintptr_t> expanded;
    state.source = "FindWindowEx.child";
    while (!pending.empty() && !state.truncated) {
        HWND parent = pending.front(); pending.pop_front();
        if (!expanded.insert(reinterpret_cast<uintptr_t>(parent)).second) continue;
        find_siblings(state, parent);
        for (HWND child = FindWindowExW(parent, nullptr, nullptr, nullptr); child;) {
            const auto key = reinterpret_cast<uintptr_t>(child);
            if (!expanded.count(key)) pending.push_back(child);
            HWND next = FindWindowExW(parent, child, nullptr, nullptr);
            if (next == child || pending.size() > window_limit) { state.truncated = true; break; }
            child = next;
        }
    }
    Snapshot snapshot;
    Json windows = Json::array(), process_list = Json::array();
    std::set<DWORD> included_pids;
    RECT virtual_screen{GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), 0, 0};
    virtual_screen.right = virtual_screen.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
    virtual_screen.bottom = virtual_screen.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
    std::set<uintptr_t> include;
    for (const auto& [key, sources] : state.sources) {
        HWND h = reinterpret_cast<HWND>(key);
        if (!target_pid || window_pid(h) == target_pid) {
            include.insert(key);
            // Include up to 32 ancestors/owners as context, even when outside --pid.
            for (int relation = 0; relation < 2; ++relation) {
                HWND current = h; std::set<uintptr_t> visited;
                for (int depth = 0; depth < 32; ++depth) {
                    current = relation ? GetWindow(current, GW_OWNER) : GetAncestor(current, GA_PARENT);
                    const auto parent_key = reinterpret_cast<uintptr_t>(current);
                    if (!current || current == GetDesktopWindow() || current == HWND_MESSAGE || !visited.insert(parent_key).second) break;
                    include.insert(parent_key);
                }
            }
        }
    }
    for (const auto key : include) {
        HWND h = reinterpret_cast<HWND>(key); WindowRecord record;
        record.tid = GetWindowThreadProcessId(h, &record.pid);
        record.sources = state.sources[key];
        Json flags = Json::array(), errors = Json::array();
        SetLastError(0); const auto style = static_cast<DWORD>(GetWindowLongPtrW(h, GWL_STYLE));
        const auto style_error = GetLastError();
        SetLastError(0); const auto extended = static_cast<DWORD>(GetWindowLongPtrW(h, GWL_EXSTYLE));
        const auto extended_error = GetLastError();
        if (style_error) errors.push(Json::object({{"api", "GetWindowLongPtr.style"}, {"error", style_error}}));
        if (extended_error) errors.push(Json::object({{"api", "GetWindowLongPtr.extendedStyle"}, {"error", extended_error}}));
        wchar_t title[4097]{}, cls[257]{};
        SetLastError(0); int title_length = GetWindowTextW(h, title, static_cast<int>(std::size(title)));
        DWORD title_error = title_length ? 0 : GetLastError();
        SetLastError(0); int class_length = GetClassNameW(h, cls, static_cast<int>(std::size(cls)));
        const auto class_error = class_length ? 0 : GetLastError();
        if (class_error) errors.push(Json::object({{"api", "GetClassName"}, {"error", class_error}}));
        if (title_error) errors.push(Json::object({{"api", "GetWindowText"}, {"error", title_error}}));
        HWND parent = GetAncestor(h, GA_PARENT), owner = GetWindow(h, GW_OWNER);
        DWORD parent_pid = window_pid(parent), owner_pid = window_pid(owner);
        RECT bounds{}; SetLastError(0); BOOL has_bounds = GetWindowRect(h, &bounds);
        if (!has_bounds) errors.push(Json::object({{"api", "GetWindowRect"}, {"error", GetLastError()}}));
        DWORD affinity = 0; SetLastError(0); BOOL affinity_ok = GetWindowDisplayAffinity(h, &affinity); DWORD affinity_error = affinity_ok ? 0 : GetLastError();
        DWORD cloaked = 0; HRESULT cloak_hr = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
        COLORREF key_color = 0; BYTE alpha = 255; DWORD layer_flags = 0; SetLastError(0);
        BOOL alpha_ok = (extended & WS_EX_LAYERED) ? GetLayeredWindowAttributes(h, &key_color, &alpha, &layer_flags) : FALSE;
        DWORD alpha_error = alpha_ok ? 0 : GetLastError();
        if (!IsWindowVisible(h)) flags.push("hidden");
        if (style & WS_CHILD) flags.push("child_window");
        if (extended & WS_EX_TOOLWINDOW) flags.push("tool_window");
        if (extended & WS_EX_TOPMOST) flags.push("topmost");
        if (extended & WS_EX_NOACTIVATE) flags.push("no_activation");
        if (extended & WS_EX_TRANSPARENT) flags.push("transparent_style");
        if (extended & WS_EX_NOREDIRECTIONBITMAP) flags.push("no_redirection_bitmap");
        if (extended & WS_EX_LAYERED) flags.push("layered");
        if (alpha_ok && (layer_flags & LWA_ALPHA) && alpha == 0) flags.push("zero_opacity");
        if (SUCCEEDED(cloak_hr) && cloaked) flags.push("dwm_cloaked");
        if (affinity_ok && affinity == WDA_EXCLUDEFROMCAPTURE) flags.push("capture_excluded");
        else if (affinity_ok && affinity == WDA_MONITOR) flags.push("monitor_mask_affinity");
        if (has_bounds && (bounds.right <= bounds.left || bounds.bottom <= bounds.top)) flags.push("empty_rectangle");
        RECT intersect{};
        if (has_bounds && !IntersectRect(&intersect, &bounds, &virtual_screen)) flags.push("outside_virtual_screen_bounds");
        if ((style & WS_CHILD) && parent && parent != GetDesktopWindow() && parent_pid && parent_pid != record.pid) flags.push("cross_process_parent");
        if (owner_pid && owner_pid != record.pid) flags.push("cross_process_owner");
        if ((style & WS_CHILD) && !parent) flags.push("child_style_without_parent");
        if (!IsWindow(h) || !record.pid) flags.push("disappeared_during_snapshot");
        const bool target = !target_pid || record.pid == target_pid;
        Json detail = Json::object({{"hwnd", handle_id(h)}, {"pid", record.pid}, {"tid", record.tid},
            {"title", std::wstring(title, title_length)}, {"class", std::wstring(cls, class_length)},
            {"titlePossiblyTruncated", title_length == 4096}, {"style", hex(style)}, {"extendedStyle", hex(extended)},
            {"visible", IsWindowVisible(h) != FALSE}, {"enabled", IsWindowEnabled(h) != FALSE}, {"isTargetPid", target},
            {"parent", handle_id(parent)}, {"parentPid", parent_pid}, {"owner", handle_id(owner)}, {"ownerPid", owner_pid},
            {"root", handle_id(GetAncestor(h, GA_ROOT))}, {"rootOwner", handle_id(GetAncestor(h, GA_ROOTOWNER))},
            {"bounds", has_bounds ? rectangle(bounds) : Json()}, {"findings", flags}, {"queryErrors", errors},
            {"affinity", Json::object({{"querySucceeded", affinity_ok != FALSE}, {"value", affinity_ok ? Json(affinity) : Json()}, {"error", affinity_error}})},
            {"cloaking", Json::object({{"querySucceeded", SUCCEEDED(cloak_hr)}, {"value", SUCCEEDED(cloak_hr) ? Json(cloaked) : Json()}, {"hresult", hex(static_cast<uint32_t>(cloak_hr))}})}});
        if (extended & WS_EX_LAYERED) detail["layeredAttributes"] = Json::object({{"querySucceeded", alpha_ok != FALSE},
            {"alpha", alpha_ok ? Json(alpha) : Json()}, {"flags", layer_flags}, {"colorKey", hex(key_color)}, {"error", alpha_error}});
        // Fingerprint excludes enumeration sources; changes reflect properties, not alternate discovery order.
        record.fingerprint = detail.dump(-1);
        detail["enumerationSources"] = string_set(record.sources);
        detail["desktopsObserved"] = string_set(state.desktops[key]);
        detail["enumerableByAtLeastOneTestedApi"] = !record.sources.empty();
        record.json = detail; windows.push(detail); included_pids.insert(record.pid);
        snapshot.windows.emplace(key, std::move(record));
    }
    if (target_pid) included_pids.insert(target_pid);
    else for (const auto& [pid, name] : processes) included_pids.insert(pid);
    for (DWORD pid : included_pids) process_list.push(process_info(pid, processes[pid], processes.count(pid) && !processes[pid].empty()));
    size_t target_windows = 0;
    for (const auto& [key, record] : snapshot.windows) if (!target_pid || record.pid == target_pid) ++target_windows;
    snapshot.report = Json::object({{"schemaVersion", 1}, {"kind", "window-audit"}, {"timestamp", utc_now()},
        {"observerPid", GetCurrentProcessId()}, {"targetPid", target_pid ? Json(target_pid) : Json()},
        {"scope", "Current interactive window station; accessible desktops; no visibility/title/toolwindow filters"},
        {"coverageLimits", Json::array({"Snapshot, not atomic: windows can appear, disappear, or reuse handles during collection",
            "Desktop/session permissions, protected processes, secure desktops, and other window stations may restrict queries",
            "No HWND does not mean no process, GPU resource, driver, injected module, or compositor state",
            "Findings describe properties; they are not a maliciousness verdict or proof of universal detection"})},
        {"virtualScreen", rectangle(virtual_screen)}, {"windowStation", object_name(GetProcessWindowStation())},
        {"enumerationCalls", state.calls}, {"discoveredHandleCount", state.sources.size()}, {"targetWindowCount", target_windows},
        {"reportedWindowCountIncludingRelations", snapshot.windows.size()}, {"truncated", state.truncated},
        {"durationMs", GetTickCount64() - started}, {"windows", windows}, {"processes", process_list}});
    return snapshot;
}

Json window_changes(const Snapshot& before, const Snapshot& after) {
    Json changes = Json::array();
    for (const auto& [key, record] : after.windows) {
        auto prior = before.windows.find(key);
        if (prior == before.windows.end()) changes.push(Json::object({{"change", "added"}, {"window", record.json}}));
        else if (record.pid != prior->second.pid || record.tid != prior->second.tid)
            changes.push(Json::object({{"change", "handle_reused"}, {"before", prior->second.json}, {"after", record.json}}));
        else if (record.fingerprint != prior->second.fingerprint)
            changes.push(Json::object({{"change", "properties_changed"}, {"before", prior->second.json}, {"after", record.json}}));
    }
    for (const auto& [key, record] : before.windows)
        if (!after.windows.count(key)) changes.push(Json::object({{"change", "removed"}, {"window", record.json}}));
    return changes;
}
}
