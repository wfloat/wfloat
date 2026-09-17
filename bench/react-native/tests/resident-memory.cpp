#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

uint64_t parse(const std::string &text, bool rollup = false) {
  std::istringstream stream(text);
  return bench::rssFromSmaps(stream, rollup);
}

bench::ResidentMemory parseMemory(const std::string &text, bool rollup = false) {
  std::istringstream stream(text);
  return bench::memoryFromSmaps(stream, rollup);
}

uint64_t platformMemory(const bench::ResidentMemory &memory) {
#ifdef __APPLE__
  assert(memory.physicalFootprint.bytes.has_value());
  assert(memory.physicalFootprint.error.empty());
  assert(memory.physicalFootprint.source == "task_info(TASK_VM_INFO).phys_footprint");
  return *memory.physicalFootprint.bytes;
#else
  assert(memory.pss.bytes.has_value());
  assert(memory.pss.error.empty());
  return *memory.pss.bytes;
#endif
}

int main() {
  assert(bench::peakRssBytes(1024, 1024) == 1048576);
  assert(bench::peakRssBytes(1048576, 1) == 1048576);
  assert(bench::peakRssBytes(0, 1024) == 0);
  assert(bench::peakRssBytes(9007199254740991LL, 1) == 9007199254740991ULL);
  for (const auto &bad : {std::pair<int64_t,uint64_t>{-1,1}, {9007199254740992LL,1}, {8796093022208LL,1024}, {1,0}, {1,2}}) {
    bool rejected = false;
    try { bench::peakRssBytes(bad.first, bad.second); } catch (...) { rejected = true; }
    assert(rejected);
  }
  assert(parse("Rss: 1024 kB\nPss: 512 kB\nSwap: 100 kB\n", true) == 1048576);
  assert(parse("mapping one\nRss: 4 kB\nShared_Clean: 4 kB\nmapping two\nRss: 12 kB\n") == 16384);
  assert(parse("Rss: 0 kB\n", true) == 0);
  for (const auto &bad : {"", "Pss: 4 kB\n", "Rss: -1 kB\n", "Rss: 1 MB\n",
      "Rss: 1 kB extra\n", "Rss: 1.5 kB\n", "Rss: 18446744073709551615 kB\n",
      "Rss: 18014398509481983 kB\nRss: 1 kB\n"}) {
    bool threw = false;
    try { parse(bad); } catch (const std::exception &) { threw = true; }
    assert(threw);
  }
  bool duplicate = false;
  try { parse("Rss: 1 kB\nRss: 2 kB\n", true); }
  catch (const std::exception &) { duplicate = true; }
  assert(duplicate);

  const auto proportional = parseMemory(
    "Rss: 3072 kB\nPss: 1024 kB\nPss_Dirty: 512 kB\nSwapPss: 64 kB\n", true);
  assert(proportional.bytes == 3 * 1048576);
  assert(proportional.pss.bytes == 1048576);
  assert(proportional.pss.source == "/proc/self/smaps_rollup:Pss");
  const auto mappings = parseMemory("Rss: 4 kB\nPss: 2 kB\nRss: 12 kB\nPss: 8 kB\n");
  assert(mappings.bytes == 16384 && mappings.pss.bytes == 10240);
  assert(mappings.pss.source == "/proc/self/smaps:sum(Pss)");
  assert(parseMemory("Rss: 0 kB\nPss: 0 kB\n", true).pss.bytes == 0);
  for (const auto &badPss : {"", "Pss: -1 kB\n", "Pss: 1 MB\n", "Pss: 1.5 kB\n",
      "Pss: 1 kB extra\n", "Pss: 18446744073709551615 kB\n", "Pss: 1 kB\nPss: 1 kB\n"}) {
    const auto partial = parseMemory(std::string("Rss: 8 kB\n") + badPss, true);
    assert(partial.bytes == 8192); // Valid RSS survives unavailable PSS.
    assert(!partial.pss.bytes && !partial.pss.error.empty());
  }
  for (const auto &incomplete : {
      "Rss: 4 kB\nRss: 4 kB\nPss: 2 kB\n", // A region was missing PSS.
      "Rss: 4 kB\nPss: 2 kB\nPss: 2 kB\nRss: 4 kB\n", // Duplicate + missing cannot cancel out.
      "Rss: 4 kB\nPss: 18014398509481983 kB\nRss: 4 kB\nPss: 1 kB\n"}) {
    const auto partial = parseMemory(incomplete);
    assert(partial.bytes == 8192 && !partial.pss.bytes && !partial.pss.error.empty());
  }

  const auto dirtyRollup = parseMemory("Rss: 16 kB\nPss: 12 kB\nPrivate_Dirty: 4 kB\n"
    "Pss_Dirty: 6 kB\nShared_Dirty: 8 kB\nPrivate_Clean: 2 kB\nSwap: 20 kB\n", true);
  assert(dirtyRollup.privateDirty.bytes == 4096);
  assert(dirtyRollup.privateDirty.source == "/proc/self/smaps_rollup:Private_Dirty");
  assert(dirtyRollup.pss.bytes == 12288 && dirtyRollup.bytes == 16384);
  const auto dirtyMappings = parseMemory("Rss: 8 kB\nPss: 6 kB\nPrivate_Dirty: 4 kB\n"
    "Rss: 12 kB\nPss: 10 kB\nPrivate_Dirty: 8 kB\n");
  assert(dirtyMappings.privateDirty.bytes == 12288);
  assert(dirtyMappings.privateDirty.source == "/proc/self/smaps:sum(Private_Dirty)");
  assert(parseMemory("Rss: 0 kB\nPss: 0 kB\nPrivate_Dirty: 0 kB\n", true).privateDirty.bytes == 0);
  for (const auto &bad : {"", "Private_Dirty:", "Private_Dirty: -1 kB\n", "Private_Dirty: 4 MB\n",
      "Private_Dirty: 1.5 kB\n", "Private_Dirty: 1 kB extra\n", "Private_Dirty: 18446744073709551615 kB\n",
      "Private_Dirty: 1 kB\nPrivate_Dirty: 1 kB\n"}) {
    const auto reading = parseMemory(std::string("Rss: 8 kB\nPss: 6 kB\n") + bad, true);
    assert(!reading.privateDirty.bytes && !reading.privateDirty.error.empty());
    assert(reading.bytes == 8192 && reading.pss.bytes == 6144);
  }
  for (const auto &incomplete : {
      "Private_Dirty: 1 kB\nRss: 4 kB\nPrivate_Dirty: 1 kB\n",
      "Rss: 4 kB\nRss: 4 kB\nPrivate_Dirty: 2 kB\n",
      "Rss: 4 kB\nPrivate_Dirty: 2 kB\nPrivate_Dirty: 2 kB\nRss: 4 kB\n",
      "Rss: 4 kB\nPrivate_Dirty: 18014398509481983 kB\nRss: 4 kB\nPrivate_Dirty: 1 kB\n"}) {
    const auto reading = parseMemory(incomplete);
    assert(!reading.privateDirty.bytes && !reading.privateDirty.error.empty());
  }
  const auto pssFailure = parseMemory("Rss: 4 kB\nPss: invalid\nPrivate_Dirty: 4 kB\n", true);
  assert(!pssFailure.pss.bytes && pssFailure.privateDirty.bytes == 4096);

  bench::MemoryProbe probe;
  // No read while the allocation is held: the OS peak must survive a burst
  // that is entirely between our snapshots. This runs before other allocations.
  const auto beforeBurst = bench::readResidentMemory();
  assert(beforeBurst.peakRss.bytes && beforeBurst.peakRss.error.empty());
  probe.hold(); probe.release();
  const auto afterBurst = bench::readResidentMemory();
  assert(afterBurst.peakRss.bytes && *afterBurst.peakRss.bytes > *beforeBurst.peakRss.bytes + 60 * 1048576ULL);
  assert(afterBurst.bytes < beforeBurst.bytes + 4 * 1048576ULL);
  std::cout << "Unsampled 64 MiB burst: peak " << *beforeBurst.peakRss.bytes / 1048576.0 << " -> "
    << *afterBurst.peakRss.bytes / 1048576.0 << " MiB; current " << afterBurst.bytes / 1048576.0 << " MiB\n";
  for (int run = 0; run < 3; ++run) {
    const auto before = bench::readResidentMemory();
    probe.hold();
    assert(probe.heldBytes() == bench::MemoryProbe::capacity);
    const auto held = bench::readResidentMemory();
    bool duplicateHold = false;
    try { probe.hold(); } catch (const std::exception &) { duplicateHold = true; }
    assert(duplicateHold);
    probe.release();
    probe.release(); // Idempotent lifecycle cleanup.
    assert(probe.heldBytes() == 0);
    const auto released = bench::readResidentMemory();
    assert(before.peakRss.bytes && held.peakRss.bytes && released.peakRss.bytes);
    assert(*held.peakRss.bytes >= *before.peakRss.bytes);
    assert(*released.peakRss.bytes >= *held.peakRss.bytes);
    const double rise = (static_cast<int64_t>(held.bytes) - static_cast<int64_t>(before.bytes)) / 1048576.0;
    const double drop = (static_cast<int64_t>(held.bytes) - static_cast<int64_t>(released.bytes)) / 1048576.0;
    const double platformRise = (static_cast<int64_t>(platformMemory(held)) - static_cast<int64_t>(platformMemory(before))) / 1048576.0;
    const double platformDrop = (static_cast<int64_t>(platformMemory(held)) - static_cast<int64_t>(platformMemory(released))) / 1048576.0;
    std::cout << before.source << " rise=" << rise << " MiB drop=" << drop << " MiB\n";
    std::cout << "PSS/physical-footprint rise=" << platformRise << " MiB drop=" << platformDrop << " MiB\n";
    // A small allowance for code/library pages and background OS accounting.
    assert(rise > 60 && rise < 68);
    assert(drop > 60 && drop < 68);
    assert(platformRise > 60 && platformRise < 68);
    assert(platformDrop > 60 && platformDrop < 68);
#ifndef __APPLE__
    assert(before.privateDirty.bytes && held.privateDirty.bytes && released.privateDirty.bytes);
    const double dirtyRise = (static_cast<int64_t>(*held.privateDirty.bytes) - static_cast<int64_t>(*before.privateDirty.bytes)) / 1048576.0;
    const double dirtyDrop = (static_cast<int64_t>(*held.privateDirty.bytes) - static_cast<int64_t>(*released.privateDirty.bytes)) / 1048576.0;
    std::cout << "Private_Dirty rise=" << dirtyRise << " MiB drop=" << dirtyDrop << " MiB\n";
    assert(dirtyRise > 60 && dirtyRise < 68);
    assert(dirtyDrop > 60 && dirtyDrop < 68);
#endif
  }
  const auto baseline = bench::readResidentMemory().bytes;
  const auto platformBaseline = platformMemory(bench::readResidentMemory());
  { bench::MemoryProbe scoped; scoped.hold(); }
  const auto afterDestructor = bench::readResidentMemory().bytes;
  assert(afterDestructor < baseline + 4 * 1024 * 1024);
  assert(platformMemory(bench::readResidentMemory()) < platformBaseline + 4 * 1024 * 1024);
#ifndef __APPLE__
  const auto dirtyBeforeReservation = *bench::readResidentMemory().privateDirty.bytes;
  void *reservation = mmap(nullptr, bench::MemoryProbe::capacity, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  assert(reservation != MAP_FAILED);
  const auto dirtyAfterReservation = *bench::readResidentMemory().privateDirty.bytes;
  assert(dirtyAfterReservation < dirtyBeforeReservation + 4 * 1048576ULL);
  assert(munmap(reservation, bench::MemoryProbe::capacity) == 0);
  std::cout << "Untouched 64 MiB reservation: Private_Dirty delta="
    << (static_cast<int64_t>(dirtyAfterReservation) - static_cast<int64_t>(dirtyBeforeReservation)) / 1048576.0 << " MiB\n";
#endif
  std::cout << "RSS/PSS/private-dirty parser, footprint, allocation, repeat and destructor checks passed\n";
}
