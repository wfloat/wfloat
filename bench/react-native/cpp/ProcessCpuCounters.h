#pragma once
#include <sys/resource.h>
#include <cerrno>
#include <cstdint>
#include <stdexcept>
#include <system_error>

namespace bench {
constexpr int64_t maxExactCpuUs = 9007199254740991LL;
inline int64_t cpuTimevalUs(const timeval &value) {
  if (value.tv_sec < 0 || value.tv_usec < 0 || value.tv_usec >= 1000000 ||
      value.tv_sec > maxExactCpuUs / 1000000)
    throw std::runtime_error("Invalid or exhausted process CPU time");
  const auto result = static_cast<int64_t>(value.tv_sec) * 1000000 + value.tv_usec;
  if (result > maxExactCpuUs) throw std::runtime_error("Process CPU time exceeds exact integer range");
  return result;
}
struct ProcessCpuCounters {
  int64_t userUs, systemUs;
  int64_t totalUs() const {
    if (userUs > maxExactCpuUs - systemUs)
      throw std::runtime_error("Total process CPU time exceeds exact integer range");
    return userUs + systemUs;
  }
};
inline ProcessCpuCounters readProcessCpuCounters() {
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) != 0)
    throw std::system_error(errno, std::generic_category(), "getrusage(RUSAGE_SELF)");
  ProcessCpuCounters result{cpuTimevalUs(usage.ru_utime), cpuTimevalUs(usage.ru_stime)};
  result.totalUs();
  return result;
}
} // namespace bench
