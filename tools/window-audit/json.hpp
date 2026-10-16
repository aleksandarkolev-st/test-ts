#pragma once
#include <windows.h>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <variant>
#include <vector>

namespace wa {
inline std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}
inline std::string hex(uint64_t value) {
    std::ostringstream out; out << "0x" << std::hex << std::uppercase << value; return out.str();
}
inline std::string handle_id(HWND window) { return hex(reinterpret_cast<uintptr_t>(window)); }
inline std::string utc_now() {
    SYSTEMTIME time{}; GetSystemTime(&time); char result[40]{};
    sprintf_s(result, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", time.wYear, time.wMonth,
        time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds);
    return result;
}
class Json {
public:
    using Array = std::vector<Json>;
    using Object = std::map<std::string, Json>;
    std::variant<std::nullptr_t, bool, int64_t, double, std::string, Array, Object> value = nullptr;
    Json() = default;
    Json(std::nullptr_t) {}
    Json(bool x) : value(x) {}
    template<class T, std::enable_if_t<(std::is_integral_v<T> || std::is_enum_v<T>) && !std::is_same_v<T, bool>, int> = 0>
    Json(T x) : value(static_cast<int64_t>(x)) {}
    Json(double x) : value(x) {}
    Json(const char* x) : value(std::string(x)) {}
    Json(const std::string& x) : value(x) {}
    Json(const std::wstring& x) : value(utf8(x)) {}
    Json(const Array& x) : value(x) {}
    Json(const Object& x) : value(x) {}
    static Json object(std::initializer_list<Object::value_type> x = {}) { return Object(x); }
    static Json array(std::initializer_list<Json> x = {}) { return Array(x); }
    Json& operator[](const std::string& key) {
        if (std::holds_alternative<std::nullptr_t>(value)) value = Object{};
        return std::get<Object>(value)[key];
    }
    void push(const Json& x) { std::get<Array>(value).push_back(x); }
    std::string dump(int indent = 2) const {
        std::ostringstream out; write(out, indent, 0); return out.str();
    }
private:
    static void quote(std::ostream& out, const std::string& s) {
        out << '"';
        for (unsigned char c : s) {
            switch (c) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (c < 32) out << "\\u00" << "0123456789abcdef"[c >> 4] << "0123456789abcdef"[c & 15];
                else out << static_cast<char>(c);
            }
        }
        out << '"';
    }
    void write(std::ostream& out, int indent, int level) const {
        auto newline = [&](int depth) { if (indent >= 0) out << '\n' << std::string(depth * indent, ' '); };
        if (std::holds_alternative<std::nullptr_t>(value)) out << "null";
        else if (auto boolean = std::get_if<bool>(&value)) out << (*boolean ? "true" : "false");
        else if (auto integer = std::get_if<int64_t>(&value)) out << *integer;
        else if (auto real = std::get_if<double>(&value)) out << std::setprecision(8) << *real;
        else if (auto string = std::get_if<std::string>(&value)) quote(out, *string);
        else if (auto array_value = std::get_if<Array>(&value)) {
            out << '[';
            for (size_t i = 0; i < array_value->size(); ++i) { if (i) out << ','; newline(level + 1); (*array_value)[i].write(out, indent, level + 1); }
            if (!array_value->empty()) newline(level); out << ']';
        } else if (auto object_value = std::get_if<Object>(&value)) {
            out << '{'; size_t i = 0;
            for (const auto& [key, entry] : *object_value) {
                if (i++) out << ','; newline(level + 1); quote(out, key); out << (indent >= 0 ? ": " : ":");
                entry.write(out, indent, level + 1);
            }
            if (!object_value->empty()) newline(level); out << '}';
        }
    }
};
inline void write_json(const std::filesystem::path& path, const Json& data) {
    if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) throw std::runtime_error("Cannot create report: " + path.u8string());
    out << data.dump() << '\n';
    if (!out) throw std::runtime_error("Cannot finish report: " + path.u8string());
}
struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    explicit Handle(HANDLE x) : value(x) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    operator HANDLE() const { return value; }
};
inline Json rectangle(RECT r) {
    return Json::object({{"left", r.left}, {"top", r.top}, {"right", r.right}, {"bottom", r.bottom}});
}
}
