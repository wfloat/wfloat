#include "../cpp/MachThreadCount.h"
#include <cassert>
#include <atomic>
#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

int main() {
  const auto ownThread = mach_thread_self();
  mach_port_urefs_t before = 0, after = 0;
  assert(mach_port_get_refs(mach_task_self(), ownThread, MACH_PORT_RIGHT_SEND, &before) == KERN_SUCCESS);
  const auto baseline = bench::readMachThreadCount();
  for (int i = 0; i < 2000; ++i) assert(bench::readMachThreadCount() == baseline);
  assert(mach_port_get_refs(mach_task_self(), ownThread, MACH_PORT_RIGHT_SEND, &after) == KERN_SUCCESS);
  assert(before == after);
  std::atomic<int> ready{0};
  std::atomic<bool> stop{false};
  std::vector<std::thread> workers;
  for (int i = 0; i < 4; ++i) workers.emplace_back([&] {
    ++ready;
    while (!stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  });
  while (ready.load() != 4) std::this_thread::yield();
  assert(bench::readMachThreadCount() == baseline + 4);
  stop.store(true);
  for (auto &thread : workers) thread.join();
  for (int i = 0; i < 100 && bench::readMachThreadCount() != baseline; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  assert(bench::readMachThreadCount() == baseline);
  assert(mach_port_deallocate(mach_task_self(), ownThread) == KERN_SUCCESS);
  std::cout << "PASS: " << baseline << " -> " << baseline + 4 << " -> " << baseline
    << " threads; own-thread send references unchanged after 2,000 reads\n";
}
