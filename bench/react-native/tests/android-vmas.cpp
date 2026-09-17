#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

static auto parse(const std::string &text) { std::istringstream input(text); return bench::vmasFromMaps(input); }

int main() {
  const auto valid = parse("1000-2000 r--p 00000000 00:00 0\n2000-3000 rw-s 10 0a:ff 42 /path with spaces (deleted)\n4000-5000 ---p 0 00:00 0 [anon:label]\n");
  assert(valid.count == 3 && valid.rawCount == 3 && valid.error.empty());
  assert(valid.source == "/proc/self/maps:count(VMA)");
  for (const auto *bad : {"", "\n", "1000-2000 r--p 0 00:00 0", "1000-2000 r--p\n",
      "2000-1000 r--p 0 00:00 0\n", "1000-1000 r--p 0 00:00 0\n", "1000-2000 rwxp 0 00:00 x\n",
      "1000-2000 r--z 0 00:00 0\n", "1000-2000 r--p gg 00:00 0\n", "1000-2000 r--p 0 zz:00 0\n",
      "1000-2000 r--p 0 0000 0\n", "1000-2000 r--p 0 00:00 18446744073709551616\n",
      "1000-10000000000000000 r--p 0 00:00 0\n",
      "1000-3000 r--p 0 00:00 0\n2000-4000 r--p 0 00:00 0\n",
      "1000-2000 r--p 0 00:00 0\n1000-2000 r--p 0 00:00 0\n"}) {
    const auto result = parse(bad); assert(!result.count && !result.rawCount && !result.error.empty());
  }
  std::istringstream failed("1000-2000 r--p 0 00:00 0\n"); failed.setstate(std::ios::badbit);
  assert(!bench::vmasFromMaps(failed).count);
  std::cout << "VMA records, paths with spaces, malformed/truncated input, ordering, overflow and I/O failure passed\n";
#ifdef __ANDROID__
  const auto read = [](const char *phase) {
    const auto r = bench::readResidentMemory(); assert(r.vmas.count && r.virtualSize.bytes);
    std::cout << phase << " VMAs=" << *r.vmas.count << " virtual=" << *r.virtualSize.bytes << " RSS=" << r.bytes << " bytes\n";
    return r;
  };
  read("warmup"); const auto before = read("before");
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const size_t size = 65 * static_cast<size_t>(page);
  auto *mapping = static_cast<char *>(mmap(nullptr, size, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  assert(mapping != MAP_FAILED); const auto reserved = read("reserved");
  for (size_t i = 1; i < 65; i += 2) assert(mprotect(mapping + i * page, page, PROT_READ) == 0);
  const auto split = read("split");
  assert(*split.vmas.count == *reserved.vmas.count + 64);
  assert(split.virtualSize.bytes == reserved.virtualSize.bytes);
  assert(split.bytes <= reserved.bytes + 1048576);
  assert(mprotect(mapping, size, PROT_NONE) == 0); const auto merged = read("uniform_permissions");
  assert(merged.vmas.count == reserved.vmas.count);
  assert(munmap(mapping, size) == 0); const auto released = read("released");
  assert(released.vmas.count == before.vmas.count);
  assert(released.virtualSize.bytes == before.virtualSize.bytes);
  // A separate line-count reader checks the controlled, quiescent process.
  FILE *file = fopen("/proc/self/maps", "r"); assert(file);
  size_t lines = 0; int c; while ((c = fgetc(file)) != EOF) if (c == '\n') ++lines;
  assert(!ferror(file)); fclose(file); assert(lines == *released.vmas.count);
  std::cout << "Split added 64 VMAs at unchanged virtual size; merge and release restored counts; independent line count agrees\n";
#endif
}
