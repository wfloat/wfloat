#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

#ifdef __APPLE__
static bench::ResidentMemory read(const char *phase) {
  const auto value = bench::readResidentMemory();
  assert(value.regions.count && value.regions.error.empty());
  assert(value.virtualSize.bytes);
  std::cout << phase << " regions=" << *value.regions.count
    << " virtual=" << *value.virtualSize.bytes << " RSS=" << value.bytes << " bytes\n";
  return value;
}
#endif

int main() {
#ifdef __APPLE__
  task_vm_info_data_t fixture{};
  fixture.region_count = 37; fixture.page_size = 16384; fixture.virtual_size = 1048576;
  const auto valid = bench::regionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture);
  assert(valid.count == 37 && valid.rawCount == 37 && valid.error.empty());
  assert(valid.source == "task_info(TASK_VM_INFO).region_count");
  for (auto value : {0, INT32_MAX}) {
    fixture.region_count = value;
    const auto result = bench::regionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_COUNT, fixture);
    assert(result.count == static_cast<uint32_t>(value) && result.rawCount == value && result.error.empty());
  }
  for (auto value : {-1, INT32_MIN}) {
    fixture.region_count = value;
    const auto result = bench::regionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_COUNT, fixture);
    assert(!result.count && result.rawCount == value && !result.error.empty());
  }
  const auto shortReply = bench::regionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT - 1, fixture);
  const auto failure = bench::regionsFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture);
  assert(!shortReply.count && !shortReply.rawCount && !shortReply.error.empty());
  assert(!failure.count && !failure.rawCount && !failure.error.empty());
  std::cout << "Field selection, zero, signed bounds, truncated reply and Mach failure passed\n";
  read("warmup");
  const auto baseline = read("baseline");
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const size_t size = 65 * static_cast<size_t>(page);
  auto *mapping = static_cast<char *>(mmap(nullptr, size, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0));
  assert(mapping != MAP_FAILED);
  const auto reserved = read("reserved_65_pages");
  assert(*reserved.regions.count > *baseline.regions.count);
  for (size_t i = 1; i < 65; i += 2) assert(mprotect(mapping + i * page, page, PROT_READ) == 0);
  const auto split = read("alternating_permissions");
  assert(*split.regions.count == *reserved.regions.count + 64);
  assert(split.virtualSize.bytes == reserved.virtualSize.bytes);
  assert(split.bytes <= reserved.bytes + 1048576); // No pages were touched.
  assert(mprotect(mapping, size, PROT_NONE) == 0);
  const auto restored = read("uniform_permissions_restored");
  assert(restored.virtualSize.bytes == reserved.virtualSize.bytes);
  // Restoring permissions need not immediately coalesce all VM entries.
  assert(munmap(mapping, size) == 0);
  const auto released = read("released");
  assert(released.regions.count == baseline.regions.count);
  assert(released.virtualSize.bytes == baseline.virtualSize.bytes);
  task_vm_info_data_t direct{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count) == KERN_SUCCESS);
  assert(count >= TASK_VM_INFO_REV0_COUNT && static_cast<uint32_t>(direct.region_count) == *released.regions.count);
  std::cout << "One mapping split into 65 regions without changing virtual size; release restored count; direct Mach agrees\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\n");
  const auto value = bench::memoryFromSmaps(input, true);
  assert(value.bytes == 8192 && value.pss.bytes == 4096 && !value.regions.count);
  std::cout << "Android RSS/PSS intact; no synthetic region count\n";
#endif
}
