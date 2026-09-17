#include "../cpp/ResidentMemory.h"
#include "../cpp/FileDescriptors.h"
#include <cassert>
#include <iostream>

bench::ResidentMemory parseClean(const std::string &text, bool rollup = false) {
  std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
}
int main(int argc, char **argv) {
  const auto rollup = parseClean("Rss: 20 kB\nPss: 16 kB\nPrivate_Clean: 4 kB\nPrivate_Dirty: 8 kB\n"
    "Shared_Clean: 8 kB\nShared_Dirty: 4 kB\nPss_Dirty: 12 kB\nSwap: 16 kB\n", true);
  assert(rollup.privateClean.bytes == 4096 && rollup.privateClean.error.empty());
  assert(rollup.privateClean.source == "/proc/self/smaps_rollup:Private_Clean");
  assert(rollup.privateDirty.bytes == 8192 && rollup.pss.bytes == 16384);
  const auto mappings = parseClean("Rss: 8 kB\nPss: 6 kB\nPrivate_Clean: 4 kB\nPrivate_Dirty: 2 kB\n"
    "Rss: 8 kB\nPss: 6 kB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 4 kB\n");
  assert(mappings.privateClean.bytes == 6144 && mappings.privateDirty.bytes == 6144);
  assert(mappings.privateClean.source == "/proc/self/smaps:sum(Private_Clean)");
  assert(parseClean("Rss: 0 kB\nPrivate_Clean: 0 kB\n", true).privateClean.bytes == 0);
  for (const auto &bad : {"", "Private_Clean:", "Private_Clean: -1 kB\n", "Private_Clean: 4 MB\n",
      "Private_Clean: 1.5 kB\n", "Private_Clean: 1 kB extra\n", "Private_Clean: 18446744073709551615 kB\n",
      "Private_Clean: 1 kB\nPrivate_Clean: 1 kB\n"}) {
    const auto r = parseClean(std::string("Rss: 8 kB\nPss: 6 kB\nPrivate_Dirty: 4 kB\n") + bad, true);
    assert(!r.privateClean.bytes && !r.privateClean.error.empty());
    assert(r.bytes == 8192 && r.pss.bytes == 6144 && r.privateDirty.bytes == 4096);
  }
  for (const auto &bad : {
      "Private_Clean: 1 kB\nRss: 4 kB\nPrivate_Clean: 1 kB\n",
      "Rss: 4 kB\nRss: 4 kB\nPrivate_Clean: 2 kB\n",
      "Rss: 4 kB\nPrivate_Clean: 2 kB\nPrivate_Clean: 2 kB\nRss: 4 kB\n",
      "Rss: 4 kB\nPrivate_Clean: 18014398509481983 kB\nRss: 4 kB\nPrivate_Clean: 1 kB\n"}) {
    const auto r = parseClean(bad);
    assert(!r.privateClean.bytes && !r.privateClean.error.empty());
  }
  const auto dirtyFailure = parseClean("Rss: 4 kB\nPrivate_Dirty: invalid\nPrivate_Clean: 4 kB\n", true);
  assert(dirtyFailure.privateClean.bytes == 4096 && !dirtyFailure.privateDirty.bytes);
  std::cout << "Private_Clean parser, independent errors and source checks passed\n";
#ifdef __linux__
  assert(argc == 2);
  const auto deltaMiB = [](uint64_t after, uint64_t before) { return (static_cast<int64_t>(after) - static_cast<int64_t>(before)) / 1048576.0; };
  bench::MemoryProbe probe;
  bool failed = false;
  try { probe.holdClean("/path/that/does/not/exist"); } catch (const std::system_error &) { failed = true; }
  assert(failed && probe.heldBytes() == 0 && std::string(probe.kind()) == "none");
  const int descriptors = bench::readFileDescriptors().count;
  for (int run = 0; run < 3; ++run) {
    const auto before = bench::readResidentMemory();
    probe.holdClean(argv[1]);
    assert(probe.heldBytes() == bench::MemoryProbe::capacity && std::string(probe.kind()) == "file_clean");
    const auto held = bench::readResidentMemory();
    bool duplicate = false;
    try { probe.hold(); } catch (const std::runtime_error &) { duplicate = true; }
    assert(duplicate);
    duplicate = false;
    try { probe.holdClean(argv[1]); } catch (const std::runtime_error &) { duplicate = true; }
    assert(duplicate);
    probe.release(); probe.release();
    const auto released = bench::readResidentMemory();
    assert(probe.heldBytes() == 0 && std::string(probe.kind()) == "none");
    assert(before.privateClean.bytes && held.privateClean.bytes && released.privateClean.bytes);
    const double rise = deltaMiB(*held.privateClean.bytes, *before.privateClean.bytes);
    const double drop = deltaMiB(*held.privateClean.bytes, *released.privateClean.bytes);
    const double dirtyRise = deltaMiB(*held.privateDirty.bytes, *before.privateDirty.bytes);
    std::cout << "Clean file check " << run + 1 << ": Private_Clean rise=" << rise
      << " MiB, drop=" << drop << " MiB; Private_Dirty rise=" << dirtyRise << " MiB\n";
    assert(rise > 60 && rise < 68 && drop > 60 && drop < 68);
    assert(dirtyRise > -4 && dirtyRise < 4);
    assert(bench::readFileDescriptors().count == descriptors);
  }
  const auto beforeDestructor = *bench::readResidentMemory().privateClean.bytes;
  { bench::MemoryProbe scoped; scoped.holdClean(argv[1]); }
  assert(*bench::readResidentMemory().privateClean.bytes < beforeDestructor + 4 * 1048576ULL);
  assert(bench::readFileDescriptors().count == descriptors);
  // Reuse the same probe for the original anonymous check after a clean hold.
  probe.hold(); assert(std::string(probe.kind()) == "anonymous_dirty"); probe.release();
  std::cout << "Clean file mapping, repeated release, failure recovery, destructor and descriptor checks passed\n";
#else
  (void)argc; (void)argv;
#endif
}
