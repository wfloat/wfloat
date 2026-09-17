#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(30);
  task_vm_info_data_t fixture{};
  fixture.internal = 16777216; fixture.internal_peak = 33554432; fixture.compressed = 67108864;
  const auto parsed = bench::peakInternalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture);
  assert(parsed.bytes == 33554432 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).internal_peak");
  for (const uint64_t value : {uint64_t(0), uint64_t(UINT64_MAX)}) {
    fixture.internal_peak = value;
    assert(bench::peakInternalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == value);
  }
  assert(!bench::peakInternalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT - 1, fixture).bytes);
  assert(!bench::peakInternalFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).bytes);
  std::cout << "Field selection, zero, uint64 range, short response and failed query passed\n";
  struct Reading { uint64_t current, peak; };
  uint64_t previous = 0;
  const auto directPeak = [] {
    task_vm_info_data_t info{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV0_COUNT); return uint64_t(info.internal_peak);
  };
  const auto sample = [&](const char* phase) {
    const auto before = directPeak();
    const auto row = bench::readResidentMemory();
    const auto after = directPeak();
    assert(row.internal.bytes && row.peakInternal.bytes && row.peakInternal.error.empty());
    const auto peak = *row.peakInternal.bytes;
    // Bracket the collector with direct OS queries; calls are not atomic.
    assert(before <= peak && peak <= after && peak >= previous);
    assert(peak >= *row.internal.bytes); previous = peak;
    std::cout << phase << " current=" << *row.internal.bytes << " peak=" << peak
      << " directBefore=" << before << " directAfter=" << after << "\n";
    return Reading{*row.internal.bytes, peak};
  };
  sample("warmup"); const auto baseline = sample("baseline");
  constexpr size_t size = 32 * 1024 * 1024;
  void* region = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(region != MAP_FAILED);
  const auto reserved = sample("reserved_untouched");
  auto bytes = static_cast<volatile unsigned char*>(region);
  for (size_t i = 0; i < size; ++i) bytes[i] = 71;
  const auto held = sample("written");
  assert(held.current > reserved.current + size - 262144);
  assert(held.peak > baseline.peak && held.peak >= held.current);
  assert(munmap(region, size) == 0);
  const auto released = sample("released");
  assert(released.current + size - 262144 < held.current);
  assert(released.peak >= held.peak);
  assert(released.peak > released.current);
  std::cout << "32 MiB response, retained OS peak after release and direct-query bounds passed\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  auto row = bench::memoryFromSmaps(input, true);
  assert(row.bytes == 8192 && row.pss.bytes == 4096 && !row.peakInternal.bytes);
  std::cout << "Android counters preserved; no synthetic iOS peak internal field\n";
#endif
}
