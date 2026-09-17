#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <cstring>
#include <iostream>

// Diagnostic only. MADV_PAGEOUT is marked internal by Apple's headers and is
// never part of production collection. Advice is bounded to our own mapping.
int main() {
  constexpr size_t size = 32 * 1024 * 1024;
  const auto baseline = bench::readResidentMemory();
  assert(baseline.peakCompressed.bytes && baseline.compressed.bytes);
  uint64_t previousPeak = *baseline.peakCompressed.bytes;
  bool observed = false;
  auto sample = [&](const char *phase) {
    const auto r = bench::readResidentMemory();
    assert(r.peakCompressed.bytes && r.compressed.bytes);
    task_vm_info_data_t direct{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count) == KERN_SUCCESS);
    assert(*r.peakCompressed.bytes >= previousPeak);
    assert(direct.compressed_peak >= *r.peakCompressed.bytes);
    previousPeak = *r.peakCompressed.bytes;
    std::cout << phase << " current=" << *r.compressed.bytes << " peak=" << previousPeak
      << " directPeak=" << direct.compressed_peak << " cumulative=" << direct.compressed_lifetime << "\n";
    return r;
  };
  sample("baseline");
  for (int cycle = 0; cycle < 2; ++cycle) {
    void *p = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    assert(p != MAP_FAILED);
    auto bytes = static_cast<volatile unsigned char *>(p);
    for (size_t i=0; i<size; i+=4096) bytes[i] = static_cast<unsigned char>(65 + cycle);
    sample("held_before_advice");
    errno = 0; const int status = madvise(p, size, MADV_PAGEOUT); const int savedError = errno;
    std::cout << "cycle=" << cycle << " ownMappingBytes=" << size << " madviseStatus=" << status << " errno=" << savedError << "\n";
    for (int i = 0; i < 10; ++i) {
      usleep(100000);
      const auto r = sample("after_advice");
      if (*r.compressed.bytes > *baseline.compressed.bytes + 1024 * 1024) { observed = true; break; }
      if (status != 0) break;
    }
    const auto held = sample("before_unmap");
    assert(munmap(p, size) == 0);
    const auto released = sample("after_unmap");
    if (*held.compressed.bytes > *baseline.compressed.bytes + 1024 * 1024) {
      assert(*released.compressed.bytes < *held.compressed.bytes);
      assert(*released.peakCompressed.bytes >= *held.peakCompressed.bytes);
    }
  }
  std::cout << (observed ? "OBSERVED: current compression rose and fell while OS lifetime peak persisted\n"
                        : "NOT OBSERVED: no induced nonzero compression; extraction only validated\n");
}
