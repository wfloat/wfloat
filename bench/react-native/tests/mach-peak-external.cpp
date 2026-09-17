#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(30);
  task_vm_info_data_t fixture{};
  fixture.external = 16777216; fixture.external_peak = 33554432; fixture.compressed = 67108864;
  const auto parsed = bench::peakExternalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture);
  assert(parsed.bytes == 33554432 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).external_peak");
  for (const uint64_t value : {uint64_t(0), uint64_t(UINT64_MAX)}) {
    fixture.external_peak = value;
    assert(bench::peakExternalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == value);
  }
  assert(!bench::peakExternalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT - 1, fixture).bytes);
  assert(!bench::peakExternalFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).bytes);
  std::cout << "Field selection, zero, uint64 range, short response and failed query passed\n";
  struct Reading { uint64_t current, peak; };
  uint64_t previous = 0;
  const auto directPeak = [] {
    task_vm_info_data_t info{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV0_COUNT); return uint64_t(info.external_peak);
  };
  const auto sample = [&](const char* phase) {
    const auto before = directPeak();
    const auto row = bench::readResidentMemory();
    const auto after = directPeak();
    assert(row.external.bytes && row.peakExternal.bytes && row.peakExternal.error.empty());
    const auto peak = *row.peakExternal.bytes;
    // Bracket the collector with direct OS queries; calls are not atomic.
    assert(before <= peak && peak <= after && peak >= previous);
    assert(peak >= *row.external.bytes); previous = peak;
    std::cout << phase << " current=" << *row.external.bytes << " peak=" << peak
      << " directBefore=" << before << " directAfter=" << after << "\n";
    return Reading{*row.external.bytes, peak};
  };
  constexpr size_t size = 32 * 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0 && size % page == 0);
  char name[] = "/tmp/wfloat-peak-external-XXXXXX";
  const int fd = mkstemp(name); assert(fd >= 0); assert(unlink(name) == 0);
  std::array<unsigned char, 65536> block{}; block.fill(71);
  for (size_t offset = 0; offset < size;) {
    const auto written = write(fd, block.data(), block.size());
    assert(written > 0); offset += written;
  }
  sample("warmup"); const auto baseline = sample("baseline");
  void* region = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
  assert(region != MAP_FAILED);
  const auto reserved = sample("mapped_untouched");
  assert(reserved.current < baseline.current + 262144);
  const auto bytes = static_cast<volatile const unsigned char*>(region);
  for (size_t offset = 0; offset < size; offset += page) assert(bytes[offset] == 71);
  const auto held = sample("read_mapping");
  assert(held.current > reserved.current + size - 262144);
  assert(held.peak > baseline.peak && held.peak >= held.current);
  assert(munmap(region, size) == 0);
  const auto released = sample("unmapped");
  assert(released.current + size - 262144 < held.current);
  assert(released.peak >= held.peak && released.peak > released.current);
  assert(close(fd) == 0);
  std::cout << "32 MiB file-backed response, retained OS peak after unmapping and direct-query bounds passed; temporary file released\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  auto row = bench::memoryFromSmaps(input, true);
  assert(row.bytes == 8192 && row.pss.bytes == 4096 && !row.peakExternal.bytes);
  std::cout << "Android counters preserved; no synthetic iOS peak external field\n";
#endif
}
