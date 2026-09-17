#pragma once
#ifdef __APPLE__
#include <mach/mach.h>
#include <stdexcept>
#include <string>
namespace bench {
class ApplePurgeableProbe {
  vm_address_t address_ = 0;
  static void check(kern_return_t status, const char* action) {
    if (status != KERN_SUCCESS) throw std::runtime_error(std::string(action) + " failed with Mach status " + std::to_string(status));
  }
public:
  static constexpr vm_size_t size = 16 * 1024 * 1024;
  ApplePurgeableProbe() = default;
  ApplePurgeableProbe(const ApplePurgeableProbe&) = delete;
  ApplePurgeableProbe& operator=(const ApplePurgeableProbe&) = delete;
  ~ApplePurgeableProbe() { release(); }
  uint64_t heldBytes() const { return address_ ? size : 0; }
  void hold() {
    release();
    check(vm_allocate(mach_task_self(), &address_, size, VM_FLAGS_ANYWHERE | VM_FLAGS_PURGABLE), "Purgeable allocation");
    rewrite();
  }
  int setState(int desired) {
    if (!address_) throw std::runtime_error("No purgeable allocation held");
    int state = desired;
    check(vm_purgable_control(mach_task_self(), address_, VM_PURGABLE_SET_STATE, &state), "Purgeable state change");
    return state & VM_PURGABLE_STATE_MASK;
  }
  void rewrite() {
    if (!address_) throw std::runtime_error("No purgeable allocation held");
    auto bytes = reinterpret_cast<volatile unsigned char*>(address_);
    for (size_t i = 0; i < size; ++i) bytes[i] = 71;
  }
  void release() noexcept {
    if (address_) { vm_deallocate(mach_task_self(), address_, size); address_ = 0; }
  }
};
}
#endif
