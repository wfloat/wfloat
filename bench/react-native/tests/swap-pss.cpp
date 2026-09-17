#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#include <chrono>
#include <thread>

int main() {
  const auto read = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 65536}) {
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nSwap: 999999 kB\nSwapPss: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.swapPss.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nSwapPss: 3 kB\nRss: 8 kB\nSwapPss: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.swapPss.bytes == 8192);
  assert(sum.swapPss.source == "/proc/self/smaps:sum(SwapPss)");
  for (const auto &text : {"Rss: 8 kB\nSwap: 4 kB\n", "Rss: 8 kB\nSwapPss: -1 kB\n",
      "Rss: 8 kB\nSwapPss: 1 MB\n", "Rss: 8 kB\nSwapPss: 1 kB extra\n",
      "Rss: 8 kB\nSwapPss: 1 kB\nSwapPss: 2 kB\n",
      "Rss: 8 kB\nSwapPss: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.swapPss.bytes && !bad.swapPss.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nSwapPss: 3 kB\n",
      "Rss: 4 kB\nSwapPss: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nSwapPss: 18014398509481983 kB\nRss: 8 kB\nSwapPss: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.swapPss.bytes);
  }
  const auto exact = read("Rss: 8 kB\nSwapPss: 18014398509481983 kB\n");
  assert(exact.swapPss.bytes == 18446744073709550592ULL);
  std::cout << "SwapPss parser: zero, field selection, sum, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  constexpr size_t size = 64 * 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto s = bench::readResidentMemory(); assert(s.swapPss.bytes && s.swapPss.error.empty());
    std::cout << phase << " rss=" << s.bytes << " swapPss=" << *s.swapPss.bytes << " bytes\n";
    return *s.swapPss.bytes;
  };
  sample("before");
  void *allocation = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(allocation != MAP_FAILED);
  auto bytes = static_cast<volatile unsigned char *>(allocation);
  for (size_t i = 0; i < size; i += page) bytes[i] = static_cast<unsigned char>((i / page) % 251 + 1);
  const auto held = sample("held");
#ifdef MADV_PAGEOUT
  errno = 0; const int status = madvise(allocation, size, MADV_PAGEOUT); const int savedError = errno;
  std::cout << "MADV_PAGEOUT own 64 MiB: status=" << status << " errno=" << savedError << "\n";
  uint64_t paged = held;
  for (int i = 0; i < 20; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const auto s = bench::readResidentMemory(); assert(s.swapPss.bytes);
    paged = *s.swapPss.bytes;
    if (paged > held) break;
  }
  sample("after_request");
  std::cout << "Nonzero swap response observed=" << (paged > held ? "yes" : "no") << " (request is advisory)\n";
#endif
  for (size_t i = 0; i < size; i += page) assert(bytes[i] == static_cast<unsigned char>((i / page) % 251 + 1));
  sample("reread_verified");
  assert(munmap(allocation, size) == 0); sample("released");
#endif
}
