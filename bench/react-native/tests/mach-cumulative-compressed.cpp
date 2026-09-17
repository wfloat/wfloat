#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif

int main(int argc, char **argv) {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(75);
  task_vm_info_data_t fixture{};
  fixture.compressed = 67108864;
  fixture.compressed_peak = 134217728;
  fixture.compressed_lifetime = 268435456;
  const auto parsed = bench::cumulativeCompressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture);
  assert(parsed.bytes == 268435456 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).compressed_lifetime");
  for (const uint64_t value : {uint64_t(0), uint64_t(UINT64_MAX)}) {
    fixture.compressed_lifetime = value;
    assert(bench::cumulativeCompressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == value);
  }
  assert(!bench::cumulativeCompressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT - 1, fixture).bytes);
  assert(!bench::cumulativeCompressedFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).bytes);
  std::cout << "Field selection, zero, uint64 range, short response and failed query passed\n";
  struct Reading { uint64_t current, peak, cumulative; };
  uint64_t previous = 0;
  const auto direct = [] {
    task_vm_info_data_t info{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV0_COUNT); return uint64_t(info.compressed_lifetime);
  };
  const auto sample = [&](const char *phase) {
    const auto before = direct();
    const auto r = bench::readResidentMemory();
    const auto after = direct();
    assert(r.cumulativeCompressed.bytes && r.compressed.bytes && r.peakCompressed.bytes);
    assert(r.cumulativeCompressed.error.empty());
    const auto cumulative = *r.cumulativeCompressed.bytes;
    assert(before <= cumulative && cumulative <= after && cumulative >= previous);
    assert(cumulative >= *r.peakCompressed.bytes && *r.peakCompressed.bytes >= *r.compressed.bytes);
    previous = cumulative;
    std::cout << phase << " current=" << *r.compressed.bytes << " peak=" << *r.peakCompressed.bytes
      << " cumulative=" << cumulative << " directBefore=" << before << " directAfter=" << after << "\n";
    return Reading{*r.compressed.bytes, *r.peakCompressed.bytes, cumulative};
  };
  sample("baseline");
  if (argc > 1) {
    const bool pageout = std::string(argv[1]) == "--pageout";
    assert(pageout || std::string(argv[1]) == "--natural");
#if TARGET_OS_SIMULATOR
    // Internal Apple advice: isolated, opt-in simulator diagnostic only. Never
    // linked into the app, and never applied beyond this owned mapping.
    constexpr size_t size = 32 * 1024 * 1024;
    const long page = sysconf(_SC_PAGESIZE); assert(page > 0 && size % page == 0);
    void *p = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    assert(p != MAP_FAILED);
    auto bytes = static_cast<volatile unsigned char *>(p);
    for (size_t i = 0; i < size; i += page) bytes[i] = 71;
    int observed = 0;
    for (int cycle = 1; cycle <= 2; ++cycle) {
      std::cout << "cycle=" << cycle << " ownMappingBytes=" << size << "\n";
      const auto before = sample("before_advice");
      errno = 0; const int status = pageout ? madvise(p, size, MADV_PAGEOUT) : 0; const int saved = errno;
      std::cout << "adviceRequested=" << pageout << " madviseStatus=" << status << " errno=" << saved << "\n";
      auto held = sample("after_advice");
      // Wait for at least half the mapping's size to change; small changes can come from this
      // process's unrelated pages and do not justify ending the wait early.
      for (int i = 0; status == 0 && i < (pageout ? 10 : 30) && held.current < before.current + size / 2; ++i) {
        usleep(pageout ? 100000 : 1000000); held = sample("awaiting_compression");
      }
      const bool rose = held.current > before.current + size / 2 && held.cumulative > before.cumulative + size / 2;
      // Read the same mapping back; verifies data integrity and restores pages.
      for (size_t i = 0; i < size; i += page) assert(bytes[i] == 71);
      const auto restored = sample("restored_same_pages");
      assert(restored.cumulative >= held.cumulative);
      if (rose && restored.current + size / 2 < held.current) ++observed;
    }
    const auto beforeRelease = sample("before_unmap");
    assert(munmap(p, size) == 0);
    const auto released = sample("after_unmap");
    assert(released.cumulative >= beforeRelease.cumulative);
    if (observed != 2) {
      std::cout << "NOT OBSERVED: " << observed << "/2 positive cycles; extraction valid, repeated compression not validated\n";
      return 2;
    }
    assert(released.cumulative > released.peak);
    std::cout << "PASS: same 32 MiB mapping compressed/restored twice; cumulative credits rose twice, survived restoration/release and exceeded peak; direct-query bounds and data integrity passed\n";
#else
    std::cout << "SKIPPED: internal pageout advice is enabled only in the simulator diagnostic\n";
    return 2;
#endif
  } else {
    sample("live_check");
    std::cout << "PASS: extraction/direct queries; no induced compression requested\n";
  }
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  const auto r = bench::memoryFromSmaps(input, true);
  assert(r.bytes == 8192 && r.pss.bytes == 4096 && !r.cumulativeCompressed.bytes);
  std::cout << "Android counters preserved; no synthetic iOS cumulative compression field\n";
#endif
}
