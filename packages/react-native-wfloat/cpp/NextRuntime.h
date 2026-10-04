#pragma once
#include <functional>
#include <memory>
#include <string>

namespace wfloat_next {
// One Runtime per platform module. Calls may run on independent worker threads.
// emit is synchronous: enqueue platform events without re-entering this instance.
// cancelled must be thread-safe. Exceptions reject the platform request promise.
// Join all request workers before destroying Runtime.
class Runtime {
 public:
  Runtime();
  ~Runtime();
  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;
  std::string request(const std::string& command,
                      std::function<void(const std::string&)> emit = {},
                      std::function<bool()> cancelled = {});
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
