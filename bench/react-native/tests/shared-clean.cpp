#include "../cpp/ResidentMemory.h"
#include "../cpp/FileDescriptors.h"
#include <cassert>
#include <cmath>
#include <iostream>

bench::ResidentMemory parseShared(const std::string &text, bool rollup = false) {
  std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
}
int main(int argc, char **argv) {
  const auto rollup = parseShared("Rss: 32 kB\nPss: 24 kB\nShared_Clean: 16 kB\nPrivate_Clean: 8 kB\n"
    "Private_Dirty: 8 kB\nShared_Dirty: 0 kB\nPss_Dirty: 8 kB\nSwap: 16 kB\nShared_Hugetlb: 20 kB\n", true);
  assert(rollup.sharedClean.bytes == 16384 && rollup.sharedClean.error.empty());
  assert(rollup.sharedClean.source == "/proc/self/smaps_rollup:Shared_Clean");
  assert(rollup.privateClean.bytes == 8192 && rollup.privateDirty.bytes == 8192 && rollup.pss.bytes == 24576);
  const auto mappings = parseShared("Rss: 8 kB\nPss: 4 kB\nShared_Clean: 8 kB\nPrivate_Clean: 0 kB\n"
    "Rss: 8 kB\nPss: 4 kB\nShared_Clean: 8 kB\nPrivate_Clean: 0 kB\n");
  assert(mappings.sharedClean.bytes == 16384 && mappings.privateClean.bytes == 0 && mappings.pss.bytes == 8192);
  assert(mappings.sharedClean.source == "/proc/self/smaps:sum(Shared_Clean)");
  assert(parseShared("Rss: 0 kB\nShared_Clean: 0 kB\n", true).sharedClean.bytes == 0);
  for (const auto &bad : {"", "Shared_Clean:", "Shared_Clean: -1 kB\n", "Shared_Clean: 4 MB\n",
      "Shared_Clean: 1.5 kB\n", "Shared_Clean: 1 kB extra\n", "Shared_Clean: 18446744073709551615 kB\n",
      "Shared_Clean: 1 kB\nShared_Clean: 1 kB\n"}) {
    const auto r = parseShared(std::string("Rss: 8 kB\nPss: 6 kB\nPrivate_Dirty: 4 kB\nPrivate_Clean: 2 kB\n") + bad, true);
    assert(!r.sharedClean.bytes && !r.sharedClean.error.empty());
    assert(r.bytes == 8192 && r.pss.bytes == 6144 && r.privateDirty.bytes == 4096 && r.privateClean.bytes == 2048);
  }
  for (const auto &bad : {
      "Shared_Clean: 1 kB\nRss: 4 kB\nShared_Clean: 1 kB\n",
      "Rss: 4 kB\nRss: 4 kB\nShared_Clean: 2 kB\n",
      "Rss: 4 kB\nShared_Clean: 2 kB\nShared_Clean: 2 kB\nRss: 4 kB\n",
      "Rss: 4 kB\nShared_Clean: 18014398509481983 kB\nRss: 4 kB\nShared_Clean: 1 kB\n"}) {
    const auto r = parseShared(bad); assert(!r.sharedClean.bytes && !r.sharedClean.error.empty());
  }
  const auto partial = parseShared("Rss: 4 kB\nPrivate_Clean: invalid\nShared_Clean: 4 kB\n", true);
  assert(partial.sharedClean.bytes == 4096 && !partial.privateClean.bytes);
  std::cout << "Shared_Clean parser, independent failures and provenance checks passed\n";
#ifdef __linux__
  assert(argc == 2);
  const auto delta = [](uint64_t after, uint64_t before) { return (static_cast<int64_t>(after) - static_cast<int64_t>(before)) / 1048576.0; };
  const auto near = [](double actual, double expected) { assert(std::abs(actual - expected) < 4); };
  bench::MemoryProbe probe;
  bool rejected = false;
  try { probe.releaseSecondMapping(); } catch (const std::runtime_error &) { rejected = true; }
  assert(rejected && probe.heldBytes() == 0 && probe.heldFileBytes() == 0);
  rejected = false;
  try { probe.holdClean("/path/that/does/not/exist", true); } catch (const std::system_error &) { rejected = true; }
  assert(rejected && probe.heldBytes() == 0);
  const int descriptors = bench::readFileDescriptors().count;
  for (int run = 0; run < 3; ++run) {
    const auto before = bench::readResidentMemory();
    probe.holdClean(argv[1], true);
    assert(probe.heldBytes() == 2 * bench::MemoryProbe::capacity && probe.heldFileBytes() == bench::MemoryProbe::capacity);
    assert(std::string(probe.kind()) == "file_clean_twice");
    const auto twice = bench::readResidentMemory();
    rejected = false;
    try { probe.holdClean(argv[1], true); } catch (const std::runtime_error &) { rejected = true; }
    assert(rejected);
    probe.releaseSecondMapping();
    assert(probe.heldBytes() == bench::MemoryProbe::capacity && probe.heldFileBytes() == bench::MemoryProbe::capacity);
    assert(std::string(probe.kind()) == "file_clean");
    const auto once = bench::readResidentMemory();
    probe.release(); probe.release();
    const auto released = bench::readResidentMemory();
    assert(probe.heldBytes() == 0 && probe.heldFileBytes() == 0 && std::string(probe.kind()) == "none");
    const double sharedRise = delta(*twice.sharedClean.bytes, *before.sharedClean.bytes);
    const double pssRise = delta(*twice.pss.bytes, *before.pss.bytes);
    const double sharedDrop = delta(*twice.sharedClean.bytes, *once.sharedClean.bytes);
    const double privateRise = delta(*once.privateClean.bytes, *twice.privateClean.bytes);
    const double pssChange = delta(*once.pss.bytes, *twice.pss.bytes);
    std::cout << "Run " << run + 1 << ": two mappings: Shared_Clean +" << sharedRise
      << " MiB, RSS +" << delta(twice.bytes, before.bytes) << " MiB, PSS +" << pssRise
      << " MiB; remove second: Shared_Clean -" << sharedDrop << " MiB, Private_Clean +"
      << privateRise << " MiB, PSS change=" << pssChange << " MiB\n";
    near(sharedRise, 128); near(delta(twice.bytes, before.bytes), 128); near(pssRise, 64);
    near(sharedDrop, 128); near(privateRise, 64); near(pssChange, 0);
    near(delta(*released.sharedClean.bytes, *before.sharedClean.bytes), 0);
    near(delta(*released.privateClean.bytes, *before.privateClean.bytes), 0);
    near(delta(*released.pss.bytes, *before.pss.bytes), 0);
    assert(bench::readFileDescriptors().count == descriptors);
  }
  const auto baseline = bench::readResidentMemory();
  { bench::MemoryProbe scoped; scoped.holdClean(argv[1], true); }
  const auto cleaned = bench::readResidentMemory();
  near(delta(*cleaned.sharedClean.bytes, *baseline.sharedClean.bytes), 0);
  near(delta(*cleaned.pss.bytes, *baseline.pss.bytes), 0);
  probe.holdClean(argv[1], true); probe.release(); // Release both mappings at once.
  assert(probe.heldBytes() == 0 && bench::readFileDescriptors().count == descriptors);
  std::cout << "Two-to-one mapping transition, repeated release, failure recovery and destructor checks passed\n";
#else
  (void)argc; (void)argv;
#endif
}
