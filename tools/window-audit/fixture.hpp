#pragma once
#include "json.hpp"
namespace wa {
int fixture_process(const std::wstring& mapping_name);
int self_test(const std::filesystem::path& directory, bool capture);
}
