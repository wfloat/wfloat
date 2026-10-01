#include "../IntervalTimerSources.h"
#include <cassert>
#include <cstdio>

static int fakeQuery(int which, itimerval *v) {
  if (which == ITIMER_REAL) {
    v->it_value.tv_sec = 123; v->it_value.tv_usec = 456;
    v->it_interval.tv_sec = 7; v->it_interval.tv_usec = 890;
    errno = EIO; // stale errno must not turn a successful query into failure.
    return 0;
  }
  if (which == ITIMER_VIRTUAL) { v->it_value.tv_sec = 999; errno = EPERM; return -1; }
  return 0;
}

int main() {
  const auto record = bench::intervalTimerSources(fakeQuery);
  assert(record.find("\"remainingSeconds\":\"123\"") != std::string::npos);
  assert(record.find("\"remainingMicroseconds\":\"456\"") != std::string::npos);
  assert(record.find("\"intervalMicroseconds\":\"890\"") != std::string::npos);
  assert(record.find("999") == std::string::npos);
  assert(record.find("\"values\":null") != std::string::npos);
  assert(record.find("\"remainingSeconds\":\"0\"") != std::string::npos);
  puts(record.c_str());
  // Arm only this standalone test process. The production collector never sets
  // timers. Long deadlines prevent delivery during the read-preservation check.
  const int timers[] = {ITIMER_REAL, ITIMER_VIRTUAL, ITIMER_PROF};
  for (const int timer : timers) {
    itimerval saved{}, armed{}, after{};
    assert(getitimer(timer, &saved) == 0);
    armed.it_value.tv_sec = 120; armed.it_interval.tv_sec = 60;
    assert(setitimer(timer, &armed, nullptr) == 0);
    puts(bench::intervalTimerSources().c_str());
    assert(getitimer(timer, &after) == 0);
    assert(after.it_value.tv_sec >= 110 && after.it_value.tv_sec <= 120);
    assert(after.it_interval.tv_sec == 60 && after.it_interval.tv_usec == 0);
    assert(setitimer(timer, &saved, nullptr) == 0);
  }
  puts("PASS: unavailable differs from zero; exact timer fields; getters preserve armed timers");
}
