#pragma once
#include <nlohmann/json.hpp>
#include <functional>
#include <memory>
#include <string>
#include <stdexcept>
namespace wfloat_next {
using Json = nlohmann::json;
using Emit = std::function<void(const std::string&)>;
using Cancel = std::function<bool()>;
inline void checkCancelled(const Cancel& cancel) {
  if (cancel && cancel()) throw std::runtime_error("Request cancelled.");
}
struct Backend {
  virtual ~Backend() = default;
  virtual Json info() const = 0;
  virtual Json request(const Json&, const Emit&, const Cancel&) = 0;
};
std::unique_ptr<Backend> makeLlm(const Json&, const Cancel&);
std::unique_ptr<Backend> makeSpeech(const Json&, const Cancel&);
// Registry logical names, with explicit aliases for existing native consumers.
inline std::string asset(const Json& load, std::initializer_list<const char*> keys) {
  const auto& paths = load.at("paths");
  for (auto key : keys) if (paths.contains(key)) {
    auto value = paths.at(key).get<std::string>();
    if (value.empty() || value.front() != '/' || value.find('\0') != std::string::npos)
      throw std::invalid_argument(std::string("Asset must be an absolute local path: ") + key);
    return value;
  }
  throw std::invalid_argument(std::string("Missing asset: ") + *keys.begin());
}
}
