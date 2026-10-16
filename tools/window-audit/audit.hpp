#pragma once
#include "json.hpp"
#include <set>

namespace wa {
struct WindowRecord {
    DWORD pid = 0;
    DWORD tid = 0;
    Json json;
    std::string fingerprint;
    std::set<std::string> sources;
};
struct Snapshot {
    Json report;
    std::map<uintptr_t, WindowRecord> windows;
};
Snapshot audit_windows(DWORD target_pid = 0, bool accessible_desktops = true);
Json window_changes(const Snapshot& before, const Snapshot& after);
}
