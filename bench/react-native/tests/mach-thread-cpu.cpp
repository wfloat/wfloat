#include "../cpp/MachThreadCpu.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <iostream>
#include <pthread.h>
#include <thread>
#include <time.h>

double now() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
double ownCpu() { timespec t{}; assert(clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t) == 0); return t.tv_sec * 1e6 + t.tv_nsec / 1000.0; }
int main() {
  std::atomic<uint64_t> busyId{0}, idleId{0}; std::atomic<int> phase{0};
  std::atomic<double> ownDelta{0}, checksum{0};
  std::thread busy([&] {
    uint64_t id; pthread_threadid_np(nullptr, &id); busyId = id;
    while (phase == 0) std::this_thread::yield();
    const auto before = ownCpu(); double x = 1;
    while (phase == 1) for (int i = 0; i < 10000; ++i) x = std::sin(x) + 1;
    ownDelta = ownCpu() - before; checksum = x;
    while (phase != 3) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  });
  std::thread idle([&] { uint64_t id; pthread_threadid_np(nullptr, &id); idleId = id;
    while (phase != 3) std::this_thread::sleep_for(std::chrono::milliseconds(10)); });
  while (!busyId || !idleId) std::this_thread::yield();
  auto find = [](const bench::MachThreadCpuRead &r, uint64_t id) {
    for (const auto &t : r.threads) if (t.id == std::to_string(id)) return t;
    throw std::runtime_error("Worker missing");
  };
  const auto first = bench::readMachThreadCpu(now);
  phase = 1; std::this_thread::sleep_for(std::chrono::milliseconds(500)); phase = 2;
  while (ownDelta == 0) std::this_thread::yield();
  const auto second = bench::readMachThreadCpu(now);
  const auto a = find(first, busyId), b = find(second, busyId), c = find(first, idleId), d = find(second, idleId);
  const auto delta = b.userUs + b.systemUs - a.userUs - a.systemUs;
  const auto idleDelta = d.userUs + d.systemUs - c.userUs - c.systemUs;
  phase = 3; busy.join(); idle.join();
  assert(delta > 20000); assert(idleDelta < delta / 5);
  assert(std::abs(delta - ownDelta) < std::max(20000.0, ownDelta.load() * .2));
  const auto ownPort = mach_thread_self(); mach_port_urefs_t refsBefore = 0, refsAfter = 0;
  assert(mach_port_get_refs(mach_task_self(), ownPort, MACH_PORT_RIGHT_SEND, &refsBefore) == KERN_SUCCESS);
  for (int i = 0; i < 200; ++i) { const auto r = bench::readMachThreadCpu(now); assert(r.errors.empty()); }
  assert(mach_port_get_refs(mach_task_self(), ownPort, MACH_PORT_RIGHT_SEND, &refsAfter) == KERN_SUCCESS);
  assert(refsBefore == refsAfter);
  assert(mach_port_deallocate(mach_task_self(), ownPort) == KERN_SUCCESS);
  const auto final = bench::readMachThreadCpu(now);
  for (const auto &t : final.threads) assert(t.id != std::to_string(busyId) && t.id != std::to_string(idleId));
  std::cout << "busy_us=" << delta << " own_clock_us=" << ownDelta << " idle_us=" << idleDelta << " repeated_scans=200 port_refs_unchanged=true\n";
}
