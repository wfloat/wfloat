#pragma once
#include <cstdint>
#include <climits>
#include <cerrno>
#include <stdexcept>
#include <system_error>
#ifdef __APPLE__
#include <mach/mach.h>
#else
#include <sys/resource.h>
#endif

namespace bench {
struct ContextSwitchCounters { int64_t total, voluntary, involuntary; };
inline ContextSwitchCounters readContextSwitchCounters() {
#ifdef __APPLE__
  task_events_info_data_t info{};
  mach_msg_type_number_t count = TASK_EVENTS_INFO_COUNT;
  const auto result = task_info(mach_task_self(), TASK_EVENTS_INFO,
    reinterpret_cast<task_info_t>(&info), &count);
  if (result != KERN_SUCCESS || count < TASK_EVENTS_INFO_COUNT)
    throw std::runtime_error("Could not read Mach task context switches");
  // XNU clamps this field. A saturated counter must not become a false zero rate.
  if (info.csw < 0 || info.csw >= INT32_MAX)
    throw std::runtime_error("Invalid or exhausted Mach context-switch counter");
  return {info.csw, -1, -1};
#else
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) != 0)
    throw std::system_error(errno, std::generic_category(), "getrusage(RUSAGE_SELF)");
  constexpr int64_t maxExact = 9007199254740991LL;
  if (usage.ru_nvcsw < 0 || usage.ru_nivcsw < 0 || usage.ru_nivcsw > maxExact ||
      usage.ru_nvcsw > maxExact - usage.ru_nivcsw)
    throw std::runtime_error("Invalid or exhausted process context-switch counter");
  return {usage.ru_nvcsw + usage.ru_nivcsw, usage.ru_nvcsw, usage.ru_nivcsw};
#endif
}
} // namespace bench
