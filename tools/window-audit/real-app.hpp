#pragma once
#include <string>
#include <vector>

namespace wa {
// args[0] is --reference-backdrop, --capture-real or --capture-region.
// --capture-real accepts either --phase/--origin for known-pattern measurement,
// or --desktop-content for unclassified ordinary-desktop pixel evidence.
// --capture-region uses an application PID and explicit screen rectangle without a target HWND.
int real_app_mode(const std::vector<std::wstring>& args);
}
