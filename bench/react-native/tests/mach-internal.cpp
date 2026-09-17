#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(30);
  task_vm_info_data_t fixture{};
  fixture.internal = 16777216;
  fixture.internal_peak = 33554432;
  fixture.compressed = 67108864;
  const auto parsed = bench::internalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture);
  assert(parsed.bytes == 16777216 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).internal");
  fixture.internal = 0;
  assert(bench::internalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == 0);
  fixture.internal = UINT64_MAX;
  assert(bench::internalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == UINT64_MAX);
  for (const auto status : {KERN_SUCCESS, KERN_FAILURE}) {
    const auto value = bench::internalFromTaskVmInfo(status, TASK_VM_INFO_REV0_COUNT - 1, fixture);
    assert(!value.bytes && !value.error.empty());
  }
  assert(!bench::internalFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).bytes);
  std::cout << "Mach response revision, failure, exact raw range, zero and field-selection checks passed\n";
  struct Reading { uint64_t internal, reusable, compressed; };
  const auto sample = [](const char* phase) {
    const auto collected = bench::readResidentMemory();
    task_vm_info_data_t direct{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV0_COUNT && collected.internal.bytes && collected.reusable.bytes && collected.compressed.bytes);
    assert(collected.internal.error.empty() && collected.physicalFootprint.bytes);
    // Separate calls may see runtime bookkeeping; preserve both values and allow
    // at most 64 KiB variation in this otherwise single-threaded diagnostic.
    const auto difference = static_cast<int64_t>(*collected.internal.bytes) - static_cast<int64_t>(direct.internal);
    assert(difference >= -65536 && difference <= 65536);
    std::cout << phase << " internal=" << *collected.internal.bytes << " direct=" << direct.internal
      << " reusable=" << *collected.reusable.bytes << " compressed=" << *collected.compressed.bytes
      << " RSS=" << collected.bytes << " footprint=" << *collected.physicalFootprint.bytes << "\n";
    return Reading{*collected.internal.bytes, *collected.reusable.bytes, *collected.compressed.bytes};
  };
  const auto near = [](uint64_t actual, uint64_t expected) {
    const auto delta = static_cast<int64_t>(actual) - static_cast<int64_t>(expected);
    assert(delta >= -262144 && delta <= 262144);
  };
  sample("warmup");
  constexpr size_t size = 16 * 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0 && size % page == 0);
  const auto baseline = sample("baseline");
  void* region = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(region != MAP_FAILED);
  const auto reserved = sample("reserved_untouched");near(reserved.internal, baseline.internal);
  auto data = static_cast<volatile unsigned char*>(region);
  for (size_t i = 0; i < size; ++i) data[i] = 71;
  const auto written = sample("written");near(written.internal, reserved.internal + size);
  errno = 0; const int advice = madvise(region, size, MADV_FREE_REUSABLE), error = errno;
  std::cout << "MADV_FREE_REUSABLE status=" << advice << " errno=" << error << " page=" << page << "\n";
  if (advice != 0) { munmap(region, size); return 77; }
  const auto marked = sample("marked_reusable");near(marked.internal + size, written.internal);
  near(marked.reusable, written.reusable + size);
  assert(madvise(region, size, MADV_FREE_REUSE) == 0);
  // Discardable contents may have been reclaimed. Rewrite before validating.
  for (size_t i = 0; i < size; ++i) data[i] = 93;
  for (size_t i = 0; i < size; ++i) assert(data[i] == 93);
  const auto reused = sample("rewritten");near(reused.internal, written.internal);near(reused.reusable, written.reusable);
  assert(munmap(region, size) == 0);
  const auto released = sample("released");near(released.internal, baseline.internal);
  std::cout << "Reserved address space excluded; positive allocation/reusable/reuse/release response verified; 256 KiB bookkeeping tolerance; no global pressure changes\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 4096 && !reading.internal.bytes);
  std::cout << "Android counters preserved; no synthetic iOS internal field\n";
#endif
}
