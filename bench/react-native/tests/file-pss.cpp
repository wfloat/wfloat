#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
  const auto parse = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 8}) {
    const auto r = parse("Rss: 16 kB\nPss: 12 kB\nPss_Shmem: 999 kB\nAnonymous: 16 kB\nPss_File: " + std::to_string(kb) + " kB\n");
    assert(r.filePss.bytes == kb * 1024ULL && r.anonymous.bytes == 16384 && r.pss.bytes == 12288);
  }
  for (const auto *bad : {"", "Pss_File: -1 kB\n", "Pss_File: 1 MB\n", "Pss_File: 1 kB extra\n",
      "Pss_File: 1 kB\nPss_File: 2 kB\n", "Pss_File: 18014398509481984 kB\n"}) {
    const auto r = parse(std::string("Rss: 8 kB\nPss: 4 kB\n") + bad);
    assert(!r.filePss.bytes && !r.filePss.error.empty() && r.bytes == 8192 && r.pss.bytes == 4096);
  }
  assert(!parse("Pss_File: 1 kB\nRss: 8 kB\n").filePss.bytes);
  assert(parse("Rss: 8 kB\nPss_File: 18014398509481983 kB\n").filePss.bytes == 18446744073709550592ULL);
  const auto fallback = parse("Rss: 8 kB\nPss: 4 kB\nAnonymous: 8 kB\nPss_File: 4 kB\n", false);
  assert(fallback.bytes == 8192 && fallback.pss.bytes == 4096 && !fallback.filePss.bytes);
  assert(fallback.filePss.source == "/proc/self/smaps_rollup:Pss_File");
  std::cout << "Pss_File field selection, zero, missing/duplicate/malformed/overflow and unavailable fallback passed\n";
#ifdef __ANDROID__
  alarm(30);
  constexpr size_t size = 64 * 1024 * 1024;
  constexpr int64_t tolerance = 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory(); assert(r.filePss.bytes && r.anonymousPss.bytes);
    std::cout << phase << " filePss=" << *r.filePss.bytes << " anonymousPss=" << *r.anonymousPss.bytes
      << " RSS=" << r.bytes << " bytes\n";
    return r;
  };
  const auto delta = [](uint64_t after, uint64_t before) { return static_cast<int64_t>(after) - static_cast<int64_t>(before); };
  const auto near = [](int64_t actual, int64_t expected) { if (std::abs(actual - expected) >= tolerance) std::cerr << "Unexpected delta " << actual << ", expected " << expected << " bytes\n"; assert(std::abs(actual - expected) < tolerance); };
  char path[] = "/data/local/tmp/wfloat-file-pss-XXXXXX";
  const int fd = mkstemp(path); assert(fd >= 0); assert(unlink(path) == 0);
  unsigned char data[4096]; memset(data, 7, sizeof(data));
  for (size_t i = 0; i < size; i += sizeof(data)) assert(write(fd, data, sizeof(data)) == sizeof(data));
  assert(fsync(fd) == 0);
  sample("warmup"); const auto before = sample("before");
  auto *first = static_cast<volatile unsigned char *>(mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0));
  assert(first != MAP_FAILED);
  near(delta(*sample("mapped_untouched").filePss.bytes, *before.filePss.bytes), 0);
  for (size_t i = 0; i < size; i += page) assert(first[i] == 7);
  const auto once = sample("read_once");
  near(delta(*once.filePss.bytes, *before.filePss.bytes), size);
  auto *second = static_cast<volatile unsigned char *>(mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0));
  assert(second != MAP_FAILED);
  for (size_t i = 0; i < size; i += page) assert(second[i] == 7);
  const auto twice = sample("read_two_mappings");
  near(delta(*twice.filePss.bytes, *once.filePss.bytes), 0);
  near(delta(twice.bytes, once.bytes), size);
  for (size_t i = 0; i < size; i += page) first[i] = 9;
  // Private writes can cause file pages to be reclaimed. Fault the original
  // mapping back in before comparing the two resident categories.
  for (size_t i = 0; i < size; i += page) assert(second[i] == 7 && first[i] == 9);
  const auto copied = sample("first_mapping_private_copies");
  near(delta(*copied.filePss.bytes, *twice.filePss.bytes), 0);
  near(delta(*copied.anonymousPss.bytes, *twice.anonymousPss.bytes), size);
  for (size_t i = 0; i < size; i += page) {
    assert(first[i] == 9 && second[i] == 7);
    unsigned char original = 0; assert(pread(fd, &original, 1, i) == 1 && original == 7);
  }
  assert(munmap(const_cast<unsigned char *>(second), size) == 0);
  const auto privateOnly = sample("only_private_copies_remain");
  near(delta(*privateOnly.filePss.bytes, *before.filePss.bytes), 0);
  near(delta(*privateOnly.anonymousPss.bytes, *before.anonymousPss.bytes), size);
  assert(munmap(const_cast<unsigned char *>(first), size) == 0); assert(close(fd) == 0);
  const auto released = sample("released");
  near(delta(*released.filePss.bytes, *before.filePss.bytes), 0);
  near(delta(*released.anonymousPss.bytes, *before.anonymousPss.bytes), 0);
  alarm(0);
  std::cout << "64 MiB file read raised file PSS; mapping twice doubled its RSS contribution without doubling PSS; private writes became anonymous; original file unchanged and cleanup passed\n";
#endif
}
