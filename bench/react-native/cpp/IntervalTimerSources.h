#pragma once
#include "NativeJson.h"
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#include <cerrno>

namespace bench {
// Read existing process timers only. Never arm a timer or install a handler.
// These are not dispatch/JavaScript/POSIX timer inventories or wakeup counts.
inline std::string intervalTimerSources(int (*query)(int, itimerval *) = ::getitimer) {
  const int ids[] = {ITIMER_REAL, ITIMER_VIRTUAL, ITIMER_PROF};
  const char *names[] = {"ITIMER_REAL", "ITIMER_VIRTUAL", "ITIMER_PROF"};
  const char *domains[] = {"elapsed_real_time", "process_user_cpu_time", "process_user_and_system_cpu_time"};
  std::string rows = "[";
  for (size_t i = 0; i < 3; ++i) {
    timespec began{}, ended{};
    const int beginError = clock_gettime(CLOCK_MONOTONIC, &began) == 0 ? 0 : errno;
    itimerval value{};
    errno = 0;
    const int result = query(ids[i], &value), error = result == 0 ? 0 : errno;
    const int endError = clock_gettime(CLOCK_MONOTONIC, &ended) == 0 ? 0 : errno;
    const auto timestamp = [](const timespec &v, int e) {
      return jsonObject({{"errno", std::to_string(e)},
        {"seconds", e ? "null" : jsonInteger(v.tv_sec)},
        {"nanoseconds", e ? "null" : jsonInteger(v.tv_nsec)}});
    };
    if (i) rows += ',';
    rows += jsonObject({{"name", jsonString(names[i])}, {"which", std::to_string(ids[i])},
      {"countdownDomain", jsonString(domains[i])}, {"returnCode", std::to_string(result)},
      {"errno", std::to_string(error)},
      {"startedMonotonic", timestamp(began, beginError)}, {"finishedMonotonic", timestamp(ended, endError)},
      {"values", result != 0 ? "null" : jsonObject({
        {"remainingSeconds", jsonInteger(value.it_value.tv_sec)},
        {"remainingMicroseconds", jsonInteger(value.it_value.tv_usec)},
        {"intervalSeconds", jsonInteger(value.it_interval.tv_sec)},
        {"intervalMicroseconds", jsonInteger(value.it_interval.tv_usec)}})}});
  }
  return jsonObject({{"processId", jsonInteger(getpid())}, {"timers", rows + ']'},
    {"scope", jsonString("three process interval timers, sequential snapshots; zero remaining means disarmed; interval is reload configuration, not observed cadence")}});
}
}
