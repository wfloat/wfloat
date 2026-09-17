#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(30);
  task_vm_info_data_t fixture{};
  fixture.reusable = 16777216;
  fixture.reusable_peak = 33554432;
  fixture.compressed = 67108864;
  const auto parsed = bench::reusableFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture);
  assert(parsed.bytes == 16777216 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).reusable");
  fixture.reusable = 0;
  assert(bench::reusableFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == 0);
  fixture.reusable = UINT64_MAX;
  assert(bench::reusableFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == UINT64_MAX);
  for (const auto status : {KERN_SUCCESS, KERN_FAILURE}) {
    const auto value = bench::reusableFromTaskVmInfo(status, TASK_VM_INFO_REV0_COUNT - 1, fixture);
    assert(!value.bytes && !value.error.empty());
  }
  assert(!bench::reusableFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).bytes);
  std::cout << "Mach response revision, failure, exact raw range, zero and field-selection checks passed\n";
  const auto sample = [](const char* phase) {
    const auto collected = bench::readResidentMemory();
    task_vm_info_data_t direct{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV0_COUNT && collected.reusable.bytes);
    assert(collected.reusable.error.empty() && collected.physicalFootprint.bytes && collected.compressed.bytes);
    assert(*collected.reusable.bytes == direct.reusable);
    std::cout << phase << " reusable=" << *collected.reusable.bytes << " direct=" << direct.reusable
      << " RSS=" << collected.bytes << " footprint=" << *collected.physicalFootprint.bytes << "\n";
    return *collected.reusable.bytes;
  };
  sample("warmup");
  const auto baseline = sample("baseline");
  constexpr size_t size = 16 * 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0 && size % page == 0);
  void* region = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(region != MAP_FAILED);
  auto data = static_cast<volatile unsigned char*>(region);
  for (size_t i = 0; i < size; ++i) data[i] = 71;
  assert(sample("written") == baseline);
  errno = 0; const int advice = madvise(region, size, MADV_FREE_REUSABLE), error = errno;
  std::cout << "MADV_FREE_REUSABLE status=" << advice << " errno=" << error << " page=" << page << "\n";
  if (advice != 0) { munmap(region, size); return 77; }
  const auto marked = sample("marked_reusable"); assert(marked == baseline + size);
  assert(madvise(region, size / 2, MADV_FREE_REUSE) == 0);
  assert(sample("half_reused") == baseline + size / 2);
  assert(madvise(static_cast<unsigned char*>(region) + size / 2, size / 2, MADV_FREE_REUSE) == 0);
  assert(sample("all_reused") == baseline);
  // Discardable contents are not assumed to survive; fully initialize before use.
  for (size_t i = 0; i < size; ++i) data[i] = 93;
  for (size_t i = 0; i < size; ++i) assert(data[i] == 93);
  assert(madvise(region, size, MADV_FREE_REUSABLE) == 0);
  assert(sample("marked_again") == baseline + size);
  assert(munmap(region, size) == 0);
  assert(sample("released") == baseline);
  std::cout << "Positive 0/16/8/0 MiB response and release verified; no global pressure or settings changed\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 4096 && !reading.reusable.bytes);
  std::cout << "Android counters preserved; no synthetic iOS reusable field\n";
#endif
}
