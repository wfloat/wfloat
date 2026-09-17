#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#include <chrono>
#include <thread>

int main() {
  std::cout << std::unitbuf;
  const auto read = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 65536}) {
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nReferenced: 999999 kB\nLazyFree: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.lazyFree.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nLazyFree: 3 kB\nRss: 8 kB\nLazyFree: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.lazyFree.bytes == 8192);
  assert(sum.lazyFree.source == "/proc/self/smaps:sum(LazyFree)");
  for (const auto &text : {"Rss: 8 kB\nReferenced: 4 kB\n", "Rss: 8 kB\nLazyFree: -1 kB\n",
      "Rss: 8 kB\nLazyFree: 1 MB\n", "Rss: 8 kB\nLazyFree: 1 kB extra\n",
      "Rss: 8 kB\nLazyFree: 1 kB\nLazyFree: 2 kB\n",
      "Rss: 8 kB\nLazyFree: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.lazyFree.bytes && !bad.lazyFree.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nLazyFree: 3 kB\n",
      "Rss: 4 kB\nLazyFree: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nLazyFree: 18014398509481983 kB\nRss: 8 kB\nLazyFree: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.lazyFree.bytes);
  }
  assert(!read("LazyFree: 1 kB\nRss: 8 kB\n").lazyFree.bytes);
  assert(!read("Rss: 4 kB\nLazyFree: 1 kB\nRss: 4 kB\nRss: 4 kB\nLazyFree: 1 kB\n", false).lazyFree.bytes);
  const auto independent = read("Rss: 8 kB\nLazyFree: 16 kB\nReferenced: invalid kB\n");
  assert(independent.lazyFree.bytes == 16384 && !independent.referenced.bytes);
  const auto exact = read("Rss: 8 kB\nLazyFree: 18014398509481983 kB\n");
  assert(exact.lazyFree.bytes == 18446744073709550592ULL);
  std::cout << "LazyFree parser: zero, field selection, sum, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  constexpr size_t size = 64 * 1024 * 1024;
  constexpr int64_t tolerance = 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto s = bench::readResidentMemory(); assert(s.lazyFree.bytes && s.lazyFree.error.empty());
    std::cout << phase << " lazyFree=" << *s.lazyFree.bytes << " RSS=" << s.bytes << " bytes\n";
    return s;
  };
  const auto delta = [](uint64_t a, uint64_t b) { return static_cast<int64_t>(a) - static_cast<int64_t>(b); };
  sample("warmup"); const auto before = sample("before");
  void *allocation = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(allocation != MAP_FAILED);
  auto bytes = static_cast<volatile unsigned char *>(allocation);
  for (size_t i = 0; i < size; i += page) bytes[i] = 9;
  const auto written = sample("written");
  assert(std::abs(delta(*written.lazyFree.bytes, *before.lazyFree.bytes)) < tolerance);
  // Test-only advisory operation on disposable pages, never used by collection.
  // Old bytes may be lost after MADV_FREE; rewriting does not rely on them.
  errno = 0;
  const int status = madvise(allocation, size, MADV_FREE), savedError = errno;
  std::cout << "MADV_FREE own 64 MiB: status=" << status << " errno=" << savedError << "\n";
  const auto marked = sample("marked");
  for (size_t i = 0; i < size / 2; i += page) bytes[i] = 17;
  const auto half = sample("half_rewritten");
  for (size_t i = 0; i < size; i += page) bytes[i] = 23;
  const auto all = sample("all_rewritten");
  for (size_t i = 0; i < size; i += page) assert(bytes[i] == 23);
  // Accounting may underreport or pages may be reclaimed immediately. Report
  // whether the controlled response was observed instead of claiming success
  // from madvise's return code alone.
  const bool response = status == 0 &&
    delta(*marked.lazyFree.bytes, *written.lazyFree.bytes) > static_cast<int64_t>(size - tolerance) &&
    std::abs(delta(*half.lazyFree.bytes, *before.lazyFree.bytes) - static_cast<int64_t>(size / 2)) < tolerance &&
    std::abs(delta(*all.lazyFree.bytes, *before.lazyFree.bytes)) < tolerance;
  std::cout << "Mark/half-write/all-write response observed=" << (response ? "yes" : "no") << "\n";
  const bool stillResident = std::abs(delta(marked.bytes, written.bytes)) < tolerance;
  std::cout << "RSS stayed stable after marking=" << (stillResident ? "yes" : "no") << "\n";
  assert(munmap(allocation, size) == 0); sample("released");
  std::cout << "Rewritten data verified; mapping released. No memory-pressure workload used.\n";
#endif
}
