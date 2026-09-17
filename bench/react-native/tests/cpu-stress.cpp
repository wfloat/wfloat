#include "../cpp/CpuStress.h"
#include <cassert>
#include <cmath>
#include <iostream>

template <class Predicate> void waitFor(Predicate predicate) {
  const auto deadline = bench::monotonicMs() + 2000;
  while (!predicate()) {
    assert(bench::monotonicMs() < deadline);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
}
int main() {
  bench::CpuStress stress;
  assert(stress.start(2, 1000));
  assert(!stress.start(2, 1000));
  waitFor([&] { return stress.snapshot().blocks > 0; });
  assert(std::isfinite(stress.snapshot().checksum));
  const auto stoppedAt = bench::monotonicMs();
  stress.stop("Manual test");
  stress.stop("Must not replace first reason");
  waitFor([&] { return !stress.snapshot().running; });
  assert(bench::monotonicMs() - stoppedAt < 1000);
  assert(stress.snapshot().reason == "Manual test");
  const auto blocks = stress.snapshot().blocks;
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  assert(stress.snapshot().blocks == blocks);

  assert(stress.start(3, 250, 30));
  waitFor([&] { return stress.snapshot().workers == 3; });
  waitFor([&] { return !stress.snapshot().running; });
  assert(stress.snapshot().reason == "Time limit reached");

  assert(stress.start(1, 1000, 10, 50));
  waitFor([&] { return !stress.snapshot().running; });
  assert(stress.snapshot().reason == "Native thermal monitor stopped responding");

  for (const int thermal : {1, -1}) {
    assert(stress.start(1, 1000));
    stress.observe(thermal, true);
    waitFor([&] { return !stress.snapshot().running; });
    assert(stress.snapshot().reason == (thermal == 1 ?
      "Thermal state reached native value 1" : "Thermal reading unavailable"));
  }
  assert(stress.start(1, 1000));
  stress.observe(0, false);
  waitFor([&] { return !stress.snapshot().running; });
  assert(stress.snapshot().reason == "App moved to the background");
  bool rejected = false;
  try { stress.start(0, 1000); } catch (const std::invalid_argument &) { rejected = true; }
  assert(rejected);
  std::atomic<bool> companionStarted{false}, companionFinished{false};
  assert(stress.start(1, 1000, 10, 5000, [&](const std::atomic<bool> &stop) {
    companionStarted = true;
    while (!stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    // Simulate draining an already submitted GPU batch.
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    companionFinished = true;
  }));
  waitFor([&] { return companionStarted.load(); });
  stress.stop("Combined manual stop");
  assert(!stress.start(1, 1000));
  waitFor([&] { return !stress.snapshot().running; });
  assert(companionFinished.load());
  assert(stress.snapshot().reason == "Combined manual stop");

  assert(stress.start(1, 1000, 10, 5000, [](const std::atomic<bool>&) {
    throw std::runtime_error("GPU unavailable");
  }));
  waitFor([&] { return !stress.snapshot().running; });
  assert(stress.snapshot().reason == "GPU workload failed");
  assert(stress.snapshot().workers == 0);

  assert(stress.start(1, 1000, 10, 5000, [](const std::atomic<bool>&) {}));
  waitFor([&] { return !stress.snapshot().running; });
  assert(stress.snapshot().reason == "GPU workload ended unexpectedly");
  for (int cause = 0; cause < 4; ++cause) {
    companionStarted = false;
    companionFinished = false;
    assert(stress.start(1, cause == 0 ? 80 : 1000, 10,
                        cause == 1 ? 80 : 5000, [&](const std::atomic<bool> &stop) {
      companionStarted = true;
      while (!stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
      companionFinished = true;
    }));
    waitFor([&] { return companionStarted.load(); });
    if (cause == 2) stress.observe(1, true);
    if (cause == 3) stress.observe(0, false);
    waitFor([&] { return !stress.snapshot().running; });
    assert(companionFinished.load());
    assert(stress.snapshot().workers == 0);
    const char *reasons[] = {"Time limit reached", "Native thermal monitor stopped responding",
      "Thermal state reached native value 1", "App moved to the background"};
    assert(stress.snapshot().reason == reasons[cause]);
  }
  std::cout << "Native workload: arithmetic, ramp, Stop, restart, deadline, monitor loss, thermal, lifecycle and companion drain/failure checks passed.\n";
}
