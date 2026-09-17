#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#ifdef __ANDROID__
#include <sys/wait.h>
#endif

int main() {
  std::cout << std::unitbuf;
  const auto parse = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 8}) {
    const auto r = parse("Rss: 16 kB\nPss: 12 kB\nPrivate_Dirty: 999 kB\nReferenced: " + std::to_string(kb) + " kB\n");
    assert(r.referenced.bytes == kb * 1024ULL && r.pss.bytes == 12288);
  }
  for (const auto *bad : {"", "Referenced: -1 kB\n", "Referenced: 1 MB\n", "Referenced: 1 kB extra\n",
      "Referenced: 1 kB\nReferenced: 2 kB\n", "Referenced: 18014398509481984 kB\n"}) {
    const auto r = parse(std::string("Rss: 8 kB\nPss: 4 kB\n") + bad);
    assert(!r.referenced.bytes && !r.referenced.error.empty() && r.bytes == 8192 && r.pss.bytes == 4096);
  }
  assert(!parse("Referenced: 1 kB\nRss: 8 kB\n").referenced.bytes);
  assert(parse("Rss: 8 kB\nReferenced: 18014398509481983 kB\n").referenced.bytes == 18446744073709550592ULL);
  const auto sum = parse("Rss: 8 kB\nReferenced: 3 kB\nRss: 8 kB\nReferenced: 5 kB\n", false);
  assert(sum.referenced.bytes == 8192 && sum.referenced.source == "/proc/self/smaps:sum(Referenced)");
  for (const auto *text : {"Rss: 8 kB\nRss: 8 kB\nReferenced: 4 kB\n",
      "Rss: 8 kB\nReferenced: 4 kB\nRss: 8 kB\n",
      "Rss: 8 kB\nReferenced: 18014398509481983 kB\nRss: 8 kB\nReferenced: 1 kB\n"})
    assert(!parse(text, false).referenced.bytes);
  std::cout << "Referenced field selection, zero, missing/duplicate/malformed/overflow and complete fallback sums passed\n";
#ifdef __ANDROID__
  alarm(30);
  constexpr size_t size = 64 * 1024 * 1024;
  constexpr int64_t tolerance = 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory(); assert(r.referenced.bytes);
    std::cout << phase << " referenced=" << *r.referenced.bytes << " RSS=" << r.bytes << " bytes\n";
    return r;
  };
  const auto delta = [](uint64_t after, uint64_t before) { return static_cast<int64_t>(after) - static_cast<int64_t>(before); };
  const auto near = [](int64_t actual, int64_t expected) {
    if (std::abs(actual - expected) >= tolerance) std::cerr << "Unexpected delta " << actual << ", expected " << expected << " bytes\n";
    assert(std::abs(actual - expected) < tolerance);
  };
  sample("warmup"); const auto before = sample("before");
  auto *mapping = static_cast<volatile unsigned char *>(mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  assert(mapping != MAP_FAILED);
  near(delta(*sample("mapped_untouched").referenced.bytes, *before.referenced.bytes), 0);
  for (size_t i = 0; i < size; i += page) mapping[i] = 9;
  const auto written = sample("all_pages_written");
  near(delta(*written.referenced.bytes, *before.referenced.bytes), size);
  // Test-only operation on this diagnostic's own process. Production collection
  // never clears access markers or changes the kernel's reclamation history.
  const int refs = open("/proc/self/clear_refs", O_WRONLY);
  const int openError = errno;
  ssize_t result = -1; int writeError = 0;
  if (refs >= 0) { result = write(refs, "1\n", 2); writeError = errno; close(refs); }
  if (refs >= 0 && result == 2) {
    const auto cleared = sample("markers_cleared");
    assert(delta(*written.referenced.bytes, *cleared.referenced.bytes) > static_cast<int64_t>(size - tolerance));
    near(delta(cleared.bytes, written.bytes), 0);
    for (size_t i = 0; i < size / 2; i += page) assert(mapping[i] == 9);
    const auto half = sample("half_pages_read");
    near(delta(*half.referenced.bytes, *cleared.referenced.bytes), size / 2);
    near(delta(half.bytes, cleared.bytes), 0);
    for (size_t i = 0; i < size; i += page) assert(mapping[i] == 9);
    const auto all = sample("all_pages_read");
    near(delta(*all.referenced.bytes, *cleared.referenced.bytes), size);
    near(delta(all.bytes, cleared.bytes), 0);
    for (size_t i = 0; i < size; i += page) assert(mapping[i] == 9);
    near(delta(*sample("all_pages_read_again").referenced.bytes, *all.referenced.bytes), 0);
    std::cout << "Self clear_refs supported; clearing lowered Referenced without lowering RSS; reading half/all pages restored markers without cumulative double-counting\n";
  } else {
    std::cout << "Self clear_refs unavailable: openErrno=" << (refs < 0 ? openError : 0)
      << " writeResult=" << result << " writeErrno=" << (refs >= 0 ? writeError : 0)
      << "; marker-reset experiment not validated\n";
  }
  assert(munmap(const_cast<unsigned char *>(mapping), size) == 0);
  const auto released = sample("released");
  near(delta(released.bytes, before.bytes), 0);
  assert(*released.referenced.bytes < size / 2);
  alarm(0);
  std::cout << "Untouched reservation, 64 MiB page access and release checks passed\n";
#endif
}
