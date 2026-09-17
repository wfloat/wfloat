#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#ifdef __ANDROID__
#include <sys/syscall.h>
#endif

int main() {
  const auto parse = [](const std::string &text) {
    std::istringstream input(text); return bench::memoryFromStatus(input);
  };
  for (const auto kb : {0, 4, 64}) {
    const auto r = parse("VmPin: 999 kB\nVmLck: " + std::to_string(kb) + " kB\nVmSize: 8192 kB\nVmPTE: 4 kB\n");
    assert(r.locked.bytes == kb * 1024ULL && r.locked.error.empty());
    assert(r.locked.source == "/proc/self/status:VmLck" && r.pageTables.bytes == 4096 && r.virtualSize.bytes == 8388608);
  }
  for (const auto &text : {"", "VmPin: 99 kB\n", "VmLck: -1 kB\n", "VmLck: +1 kB\n",
      "VmLck: 1 MB\n", "VmLck: 1\n", "VmLck: 1.5 kB\n", "VmLck: 1 kB extra\n",
      "VmLck: 1 kB\nVmLck: 2 kB\n", "VmLck: bad kB\nVmLck: 2 kB\n",
      "VmLck: 18014398509481984 kB\n", "VmLck: 18446744073709551616 kB\n"}) {
    const auto r = parse(std::string(text) + "VmPTE: 4 kB\nVmSize: 8192 kB\n");
    assert(!r.locked.bytes && !r.locked.error.empty() && r.pageTables.bytes == 4096 && r.virtualSize.bytes == 8388608);
  }
  const auto independent = parse("VmPTE: bad kB\nVmSize: bad kB\nVmLck: 18014398509481983 kB\n");
  assert(!independent.pageTables.bytes && !independent.virtualSize.bytes && independent.locked.bytes == 18446744073709550592ULL);
  std::istringstream broken("VmLck: 4 kB\n"); broken.setstate(std::ios::badbit);
  assert(!bench::memoryFromStatus(broken).locked.bytes);
  std::cout << "VmLck parser: units, zero, field selection, duplicate, missing, overflow and independent failures passed\n";
#ifdef __ANDROID__
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const size_t size = static_cast<size_t>(page) * 4;
  rlimit limit{}; assert(getrlimit(RLIMIT_MEMLOCK, &limit) == 0);
  std::cout << "uid=" << getuid() << " page=" << page << " bytes; RLIMIT_MEMLOCK=" << limit.rlim_cur << " bytes\n";
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory(); assert(r.locked.bytes && r.locked.error.empty());
    std::cout << phase << " VmLck=" << *r.locked.bytes << " RSS=" << r.bytes << " bytes\n";
    return *r.locked.bytes;
  };
  const auto before = sample("before");
  if (limit.rlim_cur < before || limit.rlim_cur - before < size) {
    std::cout << "Lock response unavailable: current limit cannot accommodate four pages\n"; return 77;
  }
  void *mapping = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  assert(mapping != MAP_FAILED);
  if (mlock(mapping, size) != 0) {
    const int code = errno; assert(munmap(mapping, size) == 0);
    std::cout << "mlock unavailable: errno=" << code << "\n"; return 77;
  }
  assert(sample("locked") == before + size);
  assert(mlock(mapping, size) == 0); assert(sample("locked_again") == before + size);
  auto bytes = static_cast<volatile unsigned char *>(mapping);
  for (size_t i = 0; i < size; i += page) bytes[i] = 7;
  assert(munlock(mapping, size) == 0); assert(sample("unlocked") == before);
  for (size_t i = 0; i < size; i += page) assert(bytes[i] == 7);
  assert(mlock(mapping, size) == 0); assert(sample("relocked") == before + size);
  assert(munmap(mapping, size) == 0); assert(sample("unmapped") == before);
  std::cout << "Lock/unlock, repeated-lock accounting, unmap cleanup and page data checks passed\n";

  mapping = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0); assert(mapping != MAP_FAILED);
  if (syscall(SYS_mlock2, mapping, size, MLOCK_ONFAULT) == 0) {
    assert(sample("deferred_untouched") == before + size);
    std::vector<unsigned char> residency(size / page);
    assert(mincore(mapping, size, residency.data()) == 0);
    for (const auto value : residency) assert((value & 1) == 0);
    std::cout << "Deferred lock: four pages accounted, zero pages resident in the mapping\n";
    bytes = static_cast<volatile unsigned char *>(mapping); bytes[0] = 9;
    assert(sample("deferred_one_page_written") == before + size);
    assert(bytes[0] == 9);
  } else std::cout << "Deferred-lock check unavailable: errno=" << errno << "\n";
  assert(munmap(mapping, size) == 0); assert(sample("deferred_unmapped") == before);
#endif
}
