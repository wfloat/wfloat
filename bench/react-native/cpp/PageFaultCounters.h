#pragma once
#include <cstdint>
#include <cerrno>
#include <climits>
#include <stdexcept>
#include <system_error>
#ifdef __APPLE__
#include <mach/mach.h>
#else
#include <sys/resource.h>
#endif

namespace bench {
struct PageFaultCounters { int64_t first, second; };
inline PageFaultCounters readPageFaultCounters() {
#ifdef __APPLE__
  task_events_info_data_t info = {};
  mach_msg_type_number_t count = TASK_EVENTS_INFO_COUNT;
  const auto status = task_info(mach_task_self(), TASK_EVENTS_INFO,
    reinterpret_cast<task_info_t>(&info), &count);
  if (status != KERN_SUCCESS || count < TASK_EVENTS_INFO_COUNT)
    throw std::runtime_error("TASK_EVENTS_INFO failed: " + std::to_string(status));
  if (info.faults < 0 || info.pageins < 0 || info.faults >= INT32_MAX || info.pageins >= INT32_MAX)
    throw std::runtime_error("Invalid or exhausted Mach event counter");
  return {info.faults, info.pageins};
#else
  struct rusage info = {};
  if (getrusage(RUSAGE_SELF, &info) != 0)
    throw std::system_error(errno, std::generic_category(), "getrusage(RUSAGE_SELF)");
  constexpr int64_t maxExactJsInteger = 9007199254740991LL;
  if (info.ru_minflt < 0 || info.ru_majflt < 0 ||
      info.ru_minflt >= maxExactJsInteger || info.ru_majflt >= maxExactJsInteger)
    throw std::runtime_error("Invalid or exhausted page-fault counter");
  return {info.ru_minflt, info.ru_majflt};
#endif
}
} // namespace bench
