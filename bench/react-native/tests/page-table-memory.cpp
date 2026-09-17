#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  const auto parse = [](const std::string &text) {
    std::istringstream input(text); return bench::pageTablesFromStatus(input);
  };
  for (const auto kb : {0, 4, 1024}) {
    const auto s = parse("VmRSS: 999 kB\nVmPTE:\t" + std::to_string(kb) + " kB\nVmSwap: 9 kB\n");
    assert(s.bytes == kb * 1024ULL && s.error.empty() && s.source == "/proc/self/status:VmPTE");
  }
  for (const auto &text : {"", "VmPMD: 4 kB\n", "VmPTE: -1 kB\n", "VmPTE: +1 kB\n",
      "VmPTE: 1 MB\n", "VmPTE: 1\n", "VmPTE: 1.5 kB\n", "VmPTE: 1 kB extra\n",
      "VmPTE: 1 kB\nVmPTE: 2 kB\n", "VmPTE: 18014398509481984 kB\n",
      "VmPTE: 18446744073709551616 kB\n"}) {
    const auto s = parse(text); assert(!s.bytes && !s.error.empty());
  }
  assert(parse("VmPTE: 18014398509481983 kB\n").bytes == 18446744073709550592ULL);
  std::istringstream broken("VmPTE: 4 kB\n"); broken.setstate(std::ios::badbit);
  assert(!bench::pageTablesFromStatus(broken).bytes);
  broken.clear(std::ios::failbit); assert(!bench::pageTablesFromStatus(broken).bytes);
  std::istringstream throwing("VmPTE: 4 kB\n"); throwing.exceptions(std::ios::eofbit);
  assert(!bench::pageTablesFromStatus(throwing).bytes);
  std::cout << "VmPTE parser: zero, units, exact field, duplicates, missing, overflow and I/O failures passed\n";
#ifdef __ANDROID__
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  constexpr size_t span = 512 * 1024 * 1024;
  constexpr size_t stride = 2 * 1024 * 1024;
  assert(static_cast<size_t>(page) <= stride);
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory();
    assert(r.pageTables.bytes && r.pageTables.error.empty());
    std::cout << phase << " VmPTE=" << *r.pageTables.bytes << " RSS=" << r.bytes << " bytes\n";
    return static_cast<int64_t>(*r.pageTables.bytes);
  };
  std::cout << "Page size=" << page << "; virtual span=" << span
    << "; written pages=" << span / stride << "; written bytes=" << (span / stride) * page << "\n";
  sample("warmup");
  const auto before = sample("before");
  void *mapping = mmap(nullptr, span, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(mapping != MAP_FAILED);
  const int advice = madvise(mapping, span, MADV_NOHUGEPAGE);
  std::cout << "MADV_NOHUGEPAGE result=" << advice << "\n";
  const auto reserved = sample("reserved_untouched");
  auto bytes = static_cast<volatile unsigned char *>(mapping);
  for (size_t i = 0; i < span; i += stride) bytes[i] = 7;
  const auto written = sample("sparse_written");
  for (size_t i = 0; i < span; i += stride) assert(bytes[i] == 7);
  assert(munmap(mapping, span) == 0);
  const auto released = sample("released");
  assert(written > reserved && released < written);
  std::cout << "Reserved delta=" << reserved - before << "; written delta=" << written - reserved
    << "; released delta=" << released - written << " bytes\n";
  std::cout << "Sparse allocation increased page-table memory; unmapping decreased it; data verified\n";
#endif
}
