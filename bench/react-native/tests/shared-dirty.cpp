#include "../cpp/ResidentMemory.h"
#include "../cpp/FileDescriptors.h"
#include <cassert>
#include <cmath>
#include <iostream>

bench::ResidentMemory parseSharedDirty(const std::string &text, bool rollup = false) {
  std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
}
int main(int argc, char **argv) {
  const auto rollup = parseSharedDirty("Rss: 32 kB\nPss: 24 kB\nShared_Dirty: 16 kB\nPrivate_Clean: 8 kB\n"
    "Private_Dirty: 8 kB\nShared_Clean: 0 kB\nPss_Dirty: 8 kB\nSwap: 16 kB\nShared_Hugetlb: 20 kB\n", true);
  assert(rollup.sharedDirty.bytes == 16384 && rollup.sharedDirty.error.empty());
  assert(rollup.sharedDirty.source == "/proc/self/smaps_rollup:Shared_Dirty");
  assert(rollup.privateClean.bytes == 8192 && rollup.privateDirty.bytes == 8192 && rollup.pss.bytes == 24576);
  const auto mappings = parseSharedDirty("Rss: 8 kB\nPss: 4 kB\nShared_Dirty: 8 kB\nPrivate_Clean: 0 kB\n"
    "Rss: 8 kB\nPss: 4 kB\nShared_Dirty: 8 kB\nPrivate_Clean: 0 kB\n");
  assert(mappings.sharedDirty.bytes == 16384 && mappings.privateClean.bytes == 0 && mappings.pss.bytes == 8192);
  assert(mappings.sharedDirty.source == "/proc/self/smaps:sum(Shared_Dirty)");
  assert(parseSharedDirty("Rss: 0 kB\nShared_Dirty: 0 kB\n", true).sharedDirty.bytes == 0);
  for (const auto &bad : {"", "Shared_Dirty:", "Shared_Dirty: -1 kB\n", "Shared_Dirty: 4 MB\n",
      "Shared_Dirty: 1.5 kB\n", "Shared_Dirty: 1 kB extra\n", "Shared_Dirty: 18446744073709551615 kB\n",
      "Shared_Dirty: 1 kB\nShared_Dirty: 1 kB\n"}) {
    const auto r = parseSharedDirty(std::string("Rss: 8 kB\nPss: 6 kB\nPrivate_Dirty: 4 kB\nPrivate_Clean: 2 kB\n") + bad, true);
    assert(!r.sharedDirty.bytes && !r.sharedDirty.error.empty());
    assert(r.bytes == 8192 && r.pss.bytes == 6144 && r.privateDirty.bytes == 4096 && r.privateClean.bytes == 2048);
  }
  for (const auto &bad : {
      "Shared_Dirty: 1 kB\nRss: 4 kB\nShared_Dirty: 1 kB\n",
      "Rss: 4 kB\nRss: 4 kB\nShared_Dirty: 2 kB\n",
      "Rss: 4 kB\nShared_Dirty: 2 kB\nShared_Dirty: 2 kB\nRss: 4 kB\n",
      "Rss: 4 kB\nShared_Dirty: 18014398509481983 kB\nRss: 4 kB\nShared_Dirty: 1 kB\n"}) {
    const auto r = parseSharedDirty(bad); assert(!r.sharedDirty.bytes && !r.sharedDirty.error.empty());
  }
  const auto partial = parseSharedDirty("Rss: 4 kB\nPrivate_Clean: invalid\nShared_Dirty: 4 kB\n", true);
  assert(partial.sharedDirty.bytes == 4096 && !partial.privateClean.bytes);
  std::cout << "Shared_Dirty parser, independent failures and provenance checks passed\n";
#ifdef __ANDROID__
  (void)argc; (void)argv;
  const auto delta = [](uint64_t a, uint64_t b) { return (static_cast<int64_t>(a) - static_cast<int64_t>(b)) / 1048576.0; };
  const auto near = [](double actual, double expected) { assert(std::abs(actual - expected) < 4); };
  bench::MemoryProbe probe;
  bool rejected = false;
  try { probe.releaseSecondMapping(); } catch (const std::runtime_error &) { rejected = true; }
  assert(rejected && probe.heldBytes() == 0 && probe.heldSharedRegionBytes() == 0);
  // Warm library loading before baseline descriptor and memory readings.
  probe.holdSharedDirty(); probe.release();
  const int descriptors = bench::readFileDescriptors().count;
  for (int run = 0; run < 3; ++run) {
    const auto before = bench::readResidentMemory();
    probe.holdSharedDirty();
    assert(probe.heldBytes() == 2 * bench::MemoryProbe::capacity);
    assert(probe.heldSharedRegionBytes() == bench::MemoryProbe::capacity && probe.heldFileBytes() == 0);
    assert(std::string(probe.kind()) == "shared_dirty_twice");
    const auto twice = bench::readResidentMemory();
    rejected = false;
    try { probe.holdSharedDirty(); } catch (const std::runtime_error &) { rejected = true; }
    assert(rejected && probe.heldBytes() == 2 * bench::MemoryProbe::capacity);
    probe.releaseSecondMapping();
    assert(probe.heldBytes() == bench::MemoryProbe::capacity && probe.heldSharedRegionBytes() == bench::MemoryProbe::capacity);
    assert(std::string(probe.kind()) == "shared_dirty_once");
    const auto once = bench::readResidentMemory();
    rejected = false;
    try { probe.releaseSecondMapping(); } catch (const std::runtime_error &) { rejected = true; }
    assert(rejected && probe.heldBytes() == bench::MemoryProbe::capacity);
    probe.release(); probe.release();
    const auto released = bench::readResidentMemory();
    assert(probe.heldBytes() == 0 && probe.heldSharedRegionBytes() == 0 && std::string(probe.kind()) == "none");
    const double sharedRise = delta(*twice.sharedDirty.bytes, *before.sharedDirty.bytes);
    const double pssRise = delta(*twice.pss.bytes, *before.pss.bytes);
    const double sharedDrop = delta(*twice.sharedDirty.bytes, *once.sharedDirty.bytes);
    const double privateRise = delta(*once.privateDirty.bytes, *twice.privateDirty.bytes);
    const double pssChange = delta(*once.pss.bytes, *twice.pss.bytes);
    std::cout << "Run " << run + 1 << ": Shared_Dirty +" << sharedRise
      << " MiB, RSS +" << delta(twice.bytes, before.bytes) << " MiB, PSS +" << pssRise
      << " MiB; remove second: Shared_Dirty -" << sharedDrop << " MiB, Private_Dirty +"
      << privateRise << " MiB, PSS change=" << pssChange << " MiB\n";
    near(sharedRise, 128); near(delta(twice.bytes, before.bytes), 128); near(pssRise, 64);
    near(sharedDrop, 128); near(privateRise, 64); near(pssChange, 0);
    near(delta(*twice.sharedClean.bytes, *before.sharedClean.bytes), 0);
    near(delta(*released.sharedDirty.bytes, *before.sharedDirty.bytes), 0);
    near(delta(*released.privateDirty.bytes, *before.privateDirty.bytes), 0);
    near(delta(*released.pss.bytes, *before.pss.bytes), 0);
    assert(bench::readFileDescriptors().count == descriptors);
  }
  const auto baseline = bench::readResidentMemory();
  { bench::MemoryProbe scoped; scoped.holdSharedDirty(); }
  const auto cleaned = bench::readResidentMemory();
  near(delta(*cleaned.sharedDirty.bytes, *baseline.sharedDirty.bytes), 0);
  near(delta(*cleaned.pss.bytes, *baseline.pss.bytes), 0);
  probe.holdSharedDirty(); probe.release();
  assert(probe.heldBytes() == 0 && probe.heldSharedRegionBytes() == 0 && bench::readFileDescriptors().count == descriptors);
  std::cout << "Shared-memory alias check, two-to-one transition, repeated release, descriptor and destructor checks passed\n";
#else
  (void)argc; (void)argv;
  bench::MemoryProbe probe;
  bool rejected = false;
  try { probe.holdSharedDirty(); } catch (const std::runtime_error &) { rejected = true; }
  assert(rejected && probe.heldBytes() == 0 && probe.heldSharedRegionBytes() == 0);
#endif
}
