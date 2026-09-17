#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  const auto parse = [](const std::string &text) {
    std::istringstream input(text); return bench::memoryFromStatus(input);
  };
  for (const auto kb : {0, 4, 8192}) {
    const auto r = parse("VmHWM: 999 kB\nVmSize: 4 kB\nVmPeak: " + std::to_string(kb) + " kB\n");
    assert(r.peakVirtual.bytes == kb * 1024ULL && r.peakVirtual.error.empty());
    assert(r.peakVirtual.source == "/proc/self/status:VmPeak" && r.virtualSize.bytes == 4096);
  }
  for (const auto &text : {"", "VmHWM: 99 kB\n", "VmPeak: -1 kB\n", "VmPeak: +1 kB\n",
      "VmPeak: 1 MB\n", "VmPeak: 1\n", "VmPeak: 1.5 kB\n", "VmPeak: 1 kB extra\n",
      "VmPeak: 1 kB\nVmPeak: 2 kB\n", "VmPeak: bad kB\nVmPeak: 2 kB\n",
      "VmPeak: 18014398509481984 kB\n", "VmPeak: 18446744073709551616 kB\n"}) {
    const auto r = parse(std::string(text) + "VmPTE: 4 kB\nVmSize: 8192 kB\nVmLck: 0 kB\n");
    assert(!r.peakVirtual.bytes && !r.peakVirtual.error.empty());
    assert(r.pageTables.bytes == 4096 && r.virtualSize.bytes == 8388608 && r.locked.bytes == 0);
  }
  const auto independent = parse("VmSize: bad kB\nVmPeak: 18014398509481983 kB\n");
  assert(!independent.virtualSize.bytes && independent.peakVirtual.bytes == 18446744073709550592ULL);
  std::istringstream broken("VmPeak: 4 kB\n"); broken.setstate(std::ios::badbit);
  assert(!bench::memoryFromStatus(broken).peakVirtual.bytes);
  std::cout << "VmPeak parser: field selection, zero, units, missing, duplicates, overflow and independent failures passed\n";
#ifdef __ANDROID__
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory();
    assert(r.peakVirtual.bytes && r.virtualSize.bytes && r.peakVirtual.error.empty());
    assert(*r.peakVirtual.bytes >= *r.virtualSize.bytes);
    std::cout << phase << " VmPeak=" << *r.peakVirtual.bytes << " VmSize=" << *r.virtualSize.bytes << " RSS=" << r.bytes << " bytes\n";
    return r;
  };
  sample("warmup"); const auto before = sample("before");
  constexpr size_t span = 128 * 1024 * 1024;
  assert(*before.peakVirtual.bytes - *before.virtualSize.bytes < span);
  // Deliberately make NO collector call while this reservation exists.
  void *mapping = mmap(nullptr, span, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
  assert(mapping != MAP_FAILED); assert(munmap(mapping, span) == 0);
  const auto after = sample("after_unobserved_reservation");
  assert(after.virtualSize.bytes == before.virtualSize.bytes);
  assert(*after.peakVirtual.bytes == *before.virtualSize.bytes + span);
  assert(std::abs(static_cast<int64_t>(after.bytes) - static_cast<int64_t>(before.bytes)) < 1024 * 1024);
  mapping = mmap(nullptr, span / 2, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
  assert(mapping != MAP_FAILED); const auto smaller = sample("smaller_reservation");
  assert(smaller.peakVirtual.bytes == after.peakVirtual.bytes);
  assert(munmap(mapping, span / 2) == 0);
  const auto released = sample("released"); assert(released.peakVirtual.bytes == after.peakVirtual.bytes);
  assert(released.virtualSize.bytes == before.virtualSize.bytes);
  std::cout << "Unobserved 128 MiB reservation retained by OS peak; smaller 64 MiB reservation and releases did not lower it\n";
#endif
}
