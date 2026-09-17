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
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nSwapPss: 999999 kB\nSwap: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.swap.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nSwap: 3 kB\nRss: 8 kB\nSwap: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.swap.bytes == 8192);
  assert(sum.swap.source == "/proc/self/smaps:sum(Swap)");
  for (const auto &text : {"Rss: 8 kB\nSwapPss: 4 kB\n", "Rss: 8 kB\nSwap: -1 kB\n",
      "Rss: 8 kB\nSwap: 1 MB\n", "Rss: 8 kB\nSwap: 1 kB extra\n",
      "Rss: 8 kB\nSwap: 1 kB\nSwap: 2 kB\n",
      "Rss: 8 kB\nSwap: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.swap.bytes && !bad.swap.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nSwap: 3 kB\n",
      "Rss: 4 kB\nSwap: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nSwap: 18014398509481983 kB\nRss: 8 kB\nSwap: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.swap.bytes);
  }
  assert(!read("Swap: 1 kB\nRss: 8 kB\n").swap.bytes);
  assert(!read("Rss: 4 kB\nSwap: 1 kB\nRss: 4 kB\nRss: 4 kB\nSwap: 1 kB\n", false).swap.bytes);
  const auto independent = read("Rss: 8 kB\nSwap: 16 kB\nSwapPss: invalid kB\n");
  assert(independent.swap.bytes == 16384 && !independent.swapPss.bytes);
  const auto exact = read("Rss: 8 kB\nSwap: 18014398509481983 kB\n");
  assert(exact.swap.bytes == 18446744073709550592ULL);
  std::cout << "Swap parser: zero, field selection, sum, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  constexpr size_t size = 64 * 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto s = bench::readResidentMemory(); assert(s.swap.bytes && s.swap.error.empty());
    std::cout << phase << " rss=" << s.bytes << " swap=" << *s.swap.bytes << " swapPss=" << (s.swapPss.bytes ? std::to_string(*s.swapPss.bytes) : "unavailable") << " bytes\n";
    return *s.swap.bytes;
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
    const auto s = bench::readResidentMemory(); assert(s.swap.bytes);
    paged = *s.swap.bytes;
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
