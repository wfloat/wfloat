#include "../cpp/ContextSwitchCounters.h"
#include "../cpp/WaitWakeProbe.h"
#include <cassert>
#include <iostream>

int main() {
  bench::WaitWakeProbe probe;
  const auto before = bench::readContextSwitchCounters();
  probe.start(probe.token(), 200);
  bool busyRejected = false;
  try { probe.start(probe.token(), 200); } catch (...) { busyRejected = true; }
  assert(busyRejected);
  while (probe.snapshot().running) std::this_thread::sleep_for(std::chrono::milliseconds(20));
  const auto completed = probe.snapshot();
  const auto after = bench::readContextSwitchCounters();
  assert(completed.wakes > 0 && completed.elapsedMs >= 200 && completed.elapsedMs < 3000);
  assert(after.total > before.total);
#ifndef __APPLE__
  assert(after.voluntary > before.voluntary);
#endif
  const auto stale = probe.token(); probe.cancel();
  bool cancelledRejected = false;
  try { probe.start(stale); } catch (...) { cancelledRejected = true; }
  assert(cancelledRejected);
  probe.start(probe.token());
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  probe.cancel();
  for (int i = 0; i < 100 && probe.snapshot().running; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  assert(!probe.snapshot().running && probe.snapshot().elapsedMs < 1000);
  const auto wakes = probe.snapshot().wakes;
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  assert(probe.snapshot().wakes == wakes);
  std::cout << "PASS: " << after.total - before.total << " context switches during " << completed.wakes
    << " completed waits; natural timeout, duplicate start, stale cancellation token, cancellation and worker cleanup\n";
}
