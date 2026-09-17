#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  const auto read = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 8}) {
    const auto s = read("Rss: 8 kB\nPss: 4 kB\nAnonHugePages: 999 kB\nAnonymous: " + std::to_string(kb) + " kB\n");
    assert(s.bytes == 8192 && s.pss.bytes == 4096 && s.anonymous.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 8 kB\nAnonymous: 3 kB\nRss: 8 kB\nAnonymous: 5 kB\n", false);
  assert(sum.anonymous.bytes == 8192 && sum.anonymous.source == "/proc/self/smaps:sum(Anonymous)");
  for (const auto &text : {"Rss: 8 kB\nAnonHugePages: 4 kB\n", "Rss: 8 kB\nAnonymous: -1 kB\n",
      "Rss: 8 kB\nAnonymous: 1 MB\n", "Rss: 8 kB\nAnonymous: 1 kB extra\n",
      "Rss: 8 kB\nAnonymous: 1 kB\nAnonymous: 2 kB\n",
      "Rss: 8 kB\nAnonymous: 18014398509481984 kB\n"}) {
    const auto s = read(text); assert(s.bytes == 8192 && !s.anonymous.bytes && !s.anonymous.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nAnonymous: 3 kB\n",
      "Rss: 4 kB\nAnonymous: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nAnonymous: 18014398509481983 kB\nRss: 8 kB\nAnonymous: 1 kB\n"}) {
    const auto s = read(text, false); assert(s.bytes == 12288 && !s.anonymous.bytes);
  }
  assert(read("Rss: 8 kB\nAnonymous: 18014398509481983 kB\n").anonymous.bytes == 18446744073709550592ULL);
  std::cout << "Anonymous parser: zero, field selection, sums, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  constexpr size_t size = 64 * 1024 * 1024;
  constexpr int64_t tolerance = 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto s = bench::readResidentMemory(); assert(s.anonymous.bytes && s.anonymous.error.empty());
    std::cout << phase << " rss=" << s.bytes << " anonymous=" << *s.anonymous.bytes << " bytes\n";
    return static_cast<int64_t>(*s.anonymous.bytes);
  };
  const auto near = [](int64_t actual, int64_t expected) { assert(std::abs(actual - expected) < tolerance); };
  const auto before = sample("before");
  void *mapping = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(mapping != MAP_FAILED); near(sample("reserved_untouched") - before, 0);
  auto bytes = static_cast<volatile unsigned char *>(mapping);
  for (size_t i = 0; i < size; i += page) bytes[i] = 7;
  const auto written = sample("anonymous_written"); near(written - before, size);
  assert(munmap(mapping, size) == 0); near(sample("anonymous_released") - before, 0);

  char path[] = "/data/local/tmp/wfloat-anonymous-XXXXXX";
  const int fd = mkstemp(path); assert(fd >= 0); assert(unlink(path) == 0); assert(ftruncate(fd, size) == 0);
  mapping = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0); assert(mapping != MAP_FAILED);
  bytes = static_cast<volatile unsigned char *>(mapping);
  const auto fileBefore = sample("file_untouched");
  for (size_t i = 0; i < size; i += page) assert(bytes[i] == 0);
  const auto fileRead = sample("file_read"); near(fileRead - fileBefore, 0);
  for (size_t i = 0; i < size; i += page) bytes[i] = 9;
  near(sample("file_private_copy_written") - fileRead, size);
  unsigned char original = 1;
  for (size_t i = 0; i < size; i += page) {
    assert(pread(fd, &original, 1, i) == 1 && original == 0);
    assert(bytes[i] == 9);
  }
  assert(munmap(mapping, size) == 0); assert(close(fd) == 0); near(sample("file_released") - fileBefore, 0);
  std::cout << "Anonymous allocation and file copy-on-write checks passed; original file data unchanged\n";
#endif
}
