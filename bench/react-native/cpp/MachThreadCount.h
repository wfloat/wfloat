#pragma once
#include <mach/mach.h>
#include <cstdint>
#include <stdexcept>
#include <string>

namespace bench {
inline uint32_t readMachThreadCount() {
  thread_act_array_t threads = nullptr;
  mach_msg_type_number_t count = 0;
  const auto task = mach_task_self();
  const auto status = task_threads(task, &threads, &count);
  if (status != KERN_SUCCESS)
    throw std::runtime_error("task_threads failed: " + std::to_string(status));

  // Each returned port carries a send-right reference. Release every one,
  // including when another release fails, then release the out-of-line array.
  kern_return_t cleanup = KERN_SUCCESS;
  for (mach_msg_type_number_t i = 0; i < count; ++i) {
    const auto code = mach_port_deallocate(task, threads[i]);
    if (code != KERN_SUCCESS) cleanup = code;
  }
  if (threads != nullptr) {
    const auto code = vm_deallocate(task, reinterpret_cast<vm_address_t>(threads),
      static_cast<vm_size_t>(count) * sizeof(thread_t));
    if (code != KERN_SUCCESS) cleanup = code;
  }
  if (cleanup != KERN_SUCCESS)
    throw std::runtime_error("Thread-list cleanup failed: " + std::to_string(cleanup));
  if (count == 0) throw std::runtime_error("Current process reported no threads");
  return count;
}
} // namespace bench
