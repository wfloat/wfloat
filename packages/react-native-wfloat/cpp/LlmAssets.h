#pragma once
#include "Backend.h"
#include <set>
#include <vector>

namespace wfloat_next {
// Registry roles determine split order; cache filenames are deliberately opaque.
inline std::vector<std::string> llmModelPaths(const Json& load) {
  const auto& paths = load.at("paths");
  std::vector<std::string> result;
  std::set<std::string> unique;
  for (auto it = paths.begin(); it != paths.end(); ++it) {
    const auto& role = it.key();
    if (role.compare(0, 12, "model_shard_") != 0) continue;
    if (role.size() != 17 || role.substr(12).find_first_not_of("0123456789") != std::string::npos)
      throw std::invalid_argument("Invalid GGUF shard role: " + role);
    auto expected = std::to_string(result.size() + 1);
    expected = "model_shard_" + std::string(5 - expected.size(), '0') + expected;
    if (role != expected) throw std::invalid_argument("Missing ordered GGUF shard: " + expected);
    auto path = asset(load, {role.c_str()});
    if (!unique.insert(path).second) throw std::invalid_argument("Duplicate GGUF shard path.");
    result.push_back(std::move(path));
  }
  if (result.empty()) return {asset(load, {"model", "model_gguf"})};
  if (paths.contains("model") || paths.contains("model_gguf"))
    throw std::invalid_argument("Cannot mix single GGUF and shard roles.");
  if (result.size() < 2) throw std::invalid_argument("Split GGUF requires at least two shards.");
  return result;
}
}
