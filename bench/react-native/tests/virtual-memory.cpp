#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  const auto parse = [](const std::string &text) {
    std::istringstream input(text); return bench::memoryFromStatus(input);
  };
  for (const auto kb : {0, 4, 8192}) {
    const auto r = parse("VmRSS: 12 kB\nVmPeak: 999999 kB\nVmSize: " + std::to_string(kb) + " kB\nVmPTE: 4 kB\n");
    assert(r.virtualSize.bytes == kb * 1024ULL && r.virtualSize.error.empty());
    assert(r.virtualSize.source == "/proc/self/status:VmSize" && r.pageTables.bytes == 4096);
  }
  for (const auto &text : {"", "VmPeak: 99 kB\n", "VmSize: -1 kB\n", "VmSize: +1 kB\n",
      "VmSize: 1 MB\n", "VmSize: 1\n", "VmSize: 1.5 kB\n", "VmSize: 1 kB extra\n",
      "VmSize: 1 kB\nVmSize: 2 kB\n", "VmSize: nope kB\nVmSize: 2 kB\n",
      "VmSize: 18014398509481984 kB\n", "VmSize: 18446744073709551616 kB\n"}) {
    const auto r = parse(std::string(text) + "VmPTE: 4 kB\n");
    assert(!r.virtualSize.bytes && !r.virtualSize.error.empty() && r.pageTables.bytes == 4096);
  }
  const auto independent = parse("VmPTE: bad kB\nVmSize: 18014398509481983 kB\n");
  assert(!independent.pageTables.bytes && independent.virtualSize.bytes == 18446744073709550592ULL);
  std::istringstream broken("VmSize: 4 kB\nVmPTE: 4 kB\n"); broken.setstate(std::ios::badbit);
  const auto failure = bench::memoryFromStatus(broken);
  assert(!failure.virtualSize.bytes && !failure.pageTables.bytes);
  std::cout << "VmSize parser: units, zero, exact field, duplicates, missing, overflow and independent failures passed\n";
#if defined(__APPLE__) || defined(__ANDROID__)
  constexpr size_t span = 64 * 1024 * 1024;
  constexpr size_t touched = 4 * 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory(); assert(r.virtualSize.bytes && r.virtualSize.error.empty());
    std::cout << phase << " virtual=" << *r.virtualSize.bytes << " RSS=" << r.bytes << " bytes\n";
    return r;
  };
  sample("warmup"); const auto before = sample("before");
  void *mapping = mmap(nullptr, span, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
  assert(mapping != MAP_FAILED); const auto reserved = sample("reserved_untouched");
  assert(*reserved.virtualSize.bytes - *before.virtualSize.bytes == span);
  assert(std::abs(static_cast<int64_t>(reserved.bytes) - static_cast<int64_t>(before.bytes)) < 1024 * 1024);
  assert(mprotect(mapping, touched, PROT_READ | PROT_WRITE) == 0);
  auto bytes = static_cast<volatile unsigned char *>(mapping);
  for (size_t i = 0; i < touched; i += page) bytes[i] = 7;
  const auto written = sample("four_MiB_written");
  assert(written.virtualSize.bytes == reserved.virtualSize.bytes);
  assert(written.bytes > reserved.bytes);
  for (size_t i = 0; i < touched; i += page) assert(bytes[i] == 7);
  assert(munmap(mapping, span) == 0); const auto released = sample("released");
  assert(released.virtualSize.bytes == before.virtualSize.bytes);
  std::cout << "64 MiB reservation changed virtual size without a comparable RSS increase; writing 4 MiB kept virtual size fixed; unmap reversed reservation\n";
#endif
}
