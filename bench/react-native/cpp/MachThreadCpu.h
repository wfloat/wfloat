#pragma once
#include <mach/mach.h>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace bench {
struct MachThreadCpu {
  std::string id;
  int64_t userUs, systemUs;
  double startedMs, finishedMs;
  int32_t runState;
  thread_basic_info_data_t basic{};
  thread_identifier_info_data_t identifier{};
};
struct MachThreadCpuRead {
  uint32_t enumerated = 0;
  std::vector<MachThreadCpu> threads;
  std::vector<std::string> errors;
};
// Takes the platform's monotonic clock so each thread has its own query bounds.
template<class Clock> MachThreadCpuRead readMachThreadCpu(Clock now) {
  thread_act_array_t ports = nullptr;
  mach_msg_type_number_t count = 0;
  const auto task = mach_task_self();
  const auto status = task_threads(task, &ports, &count);
  if (status != KERN_SUCCESS) throw std::runtime_error("task_threads failed: " + std::to_string(status));
  struct Cleanup {
    task_t task; thread_act_array_t ports; mach_msg_type_number_t count;
    ~Cleanup() {
      for (mach_msg_type_number_t i = 0; i < count; ++i) mach_port_deallocate(task, ports[i]);
      if (ports) vm_deallocate(task, reinterpret_cast<vm_address_t>(ports), count * sizeof(thread_t));
    }
  } cleanup{task, ports, count};
  if (count == 0 || count > 1024) throw std::runtime_error("Invalid or excessive thread count");
  MachThreadCpuRead result; result.enumerated = count;
  for (mach_msg_type_number_t i = 0; i < count; ++i) {
    const double before = now();
    thread_identifier_info_data_t identity{};
    mach_msg_type_number_t size = THREAD_IDENTIFIER_INFO_COUNT;
    auto code = thread_info(ports[i], THREAD_IDENTIFIER_INFO, reinterpret_cast<thread_info_t>(&identity), &size);
    if (code != KERN_SUCCESS || size < THREAD_IDENTIFIER_INFO_COUNT || identity.thread_id == 0) {
      result.errors.push_back("thread_identity_failed:" + std::to_string(code)); continue;
    }
    thread_basic_info_data_t info{}; size = THREAD_BASIC_INFO_COUNT;
    code = thread_info(ports[i], THREAD_BASIC_INFO, reinterpret_cast<thread_info_t>(&info), &size);
    const double after = now();
    if (code != KERN_SUCCESS || size < THREAD_BASIC_INFO_COUNT) {
      result.errors.push_back("thread_time_failed:" + std::to_string(code)); continue;
    }
    auto micros = [](time_value_t value) -> int64_t {
      if (value.seconds < 0 || value.microseconds < 0 || value.microseconds >= 1000000)
        throw std::runtime_error("Invalid Mach thread time");
      return static_cast<int64_t>(value.seconds) * 1000000 + value.microseconds;
    };
    const auto user = micros(info.user_time), system = micros(info.system_time);
    if (user > 9007199254740991LL - system) throw std::runtime_error("Inexact total thread time");
    result.threads.push_back({std::to_string(identity.thread_id), user, system, before, after, info.run_state, info, identity});
  }
  return result;
}
} // namespace bench
