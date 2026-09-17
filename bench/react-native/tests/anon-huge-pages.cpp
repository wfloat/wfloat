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
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nReferenced: 999999 kB\nAnonHugePages: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.anonHugePages.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nAnonHugePages: 3 kB\nRss: 8 kB\nAnonHugePages: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.anonHugePages.bytes == 8192);
  assert(sum.anonHugePages.source == "/proc/self/smaps:sum(AnonHugePages)");
  for (const auto &text : {"Rss: 8 kB\nReferenced: 4 kB\n", "Rss: 8 kB\nAnonHugePages: -1 kB\n",
      "Rss: 8 kB\nAnonHugePages: 1 MB\n", "Rss: 8 kB\nAnonHugePages: 1 kB extra\n",
      "Rss: 8 kB\nAnonHugePages: 1 kB\nAnonHugePages: 2 kB\n",
      "Rss: 8 kB\nAnonHugePages: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.anonHugePages.bytes && !bad.anonHugePages.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nAnonHugePages: 3 kB\n",
      "Rss: 4 kB\nAnonHugePages: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nAnonHugePages: 18014398509481983 kB\nRss: 8 kB\nAnonHugePages: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.anonHugePages.bytes);
  }
  assert(!read("AnonHugePages: 1 kB\nRss: 8 kB\n").anonHugePages.bytes);
  assert(!read("Rss: 4 kB\nAnonHugePages: 1 kB\nRss: 4 kB\nRss: 4 kB\nAnonHugePages: 1 kB\n", false).anonHugePages.bytes);
  const auto independent = read("Rss: 8 kB\nAnonHugePages: 16 kB\nReferenced: invalid kB\n");
  assert(independent.anonHugePages.bytes == 16384 && !independent.referenced.bytes);
  const auto exact = read("Rss: 8 kB\nAnonHugePages: 18014398509481983 kB\n");
  assert(exact.anonHugePages.bytes == 18446744073709550592ULL);
  std::cout << "AnonHugePages parser: zero, field selection, sum, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  constexpr size_t size = 64 * 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  uint64_t huge = 0;
  std::ifstream setting("/sys/kernel/mm/transparent_hugepage/hpage_pmd_size");
  setting >> huge;
  if (!setting || huge < static_cast<uint64_t>(page) || huge > size ||
      (huge & (huge - 1)) || size % huge) {
    std::cout << "PMD size unavailable or outside bounded test limits; live allocation experiment skipped\n";
    return 0;
  }
  std::cout << "Base page bytes=" << page << " PMD huge-page bytes=" << huge << "\n";
  const auto sample = [](const char *phase) {
    const auto s = bench::readResidentMemory(); assert(s.anonHugePages.bytes && s.anonHugePages.error.empty());
    std::cout << phase << " anonHugePages=" << *s.anonHugePages.bytes << " RSS=" << s.bytes << " bytes\n";
    return *s.anonHugePages.bytes;
  };
  const auto trial = [&](bool requestHuge) {
    // Reserve extra address space, then trim to PMD alignment. No fixed address
    // is used and at most 64 MiB is touched. Advice applies only to this mapping.
    void *reservation = mmap(nullptr, size + huge, PROT_READ | PROT_WRITE,
      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    assert(reservation != MAP_FAILED);
    const uintptr_t start = reinterpret_cast<uintptr_t>(reservation);
    const uintptr_t aligned = (start + huge - 1) & ~(huge - 1);
    const size_t prefix = aligned - start, suffix = huge - prefix;
    if (prefix) assert(munmap(reservation, prefix) == 0);
    if (suffix) assert(munmap(reinterpret_cast<void *>(aligned + size), suffix) == 0);
    void *allocation = reinterpret_cast<void *>(aligned);
    errno = 0;
    const int status = madvise(allocation, size, requestHuge ? MADV_HUGEPAGE : MADV_NOHUGEPAGE);
    const int savedError = errno;
    std::cout << (requestHuge ? "MADV_HUGEPAGE" : "MADV_NOHUGEPAGE")
      << " status=" << status << " errno=" << savedError << "\n";
    const auto before = sample(requestHuge ? "huge_untouched" : "base_untouched");
    auto bytes = static_cast<volatile unsigned char *>(allocation);
    for (size_t i = 0; i < size; i += page) bytes[i] = 29;
    auto held = sample(requestHuge ? "huge_written" : "base_written");
    // Allow slightly more than this emulator's 10-second khugepaged scan
    // interval. This remains bounded and does not guarantee a scan/allocation.
    for (int wait = 0; requestHuge && status == 0 && held <= before && wait < 12; ++wait) {
      std::this_thread::sleep_for(std::chrono::seconds(1));
      held = sample("huge_after_bounded_wait");
    }
    // Independent raw per-mapping evidence, excluding addresses and paths.
    std::ifstream mappings("/proc/self/smaps");
    std::string line;
    bool target = false;
    while (std::getline(mappings, line)) {
      std::istringstream fields(line);
      std::string token; fields >> token;
      if (token.find('-') != std::string::npos && token.find(':') == std::string::npos) {
        const auto dash = token.find('-');
        try {
          const auto lo = std::stoull(token.substr(0, dash), nullptr, 16);
          const auto hi = std::stoull(token.substr(dash + 1), nullptr, 16);
          target = lo <= aligned && aligned < hi;
        } catch (...) { target = false; }
      }
      if (target && (line.rfind("Rss:", 0) == 0 || line.rfind("AnonHugePages:", 0) == 0 ||
          line.rfind("THPeligible:", 0) == 0 || line.rfind("VmFlags:", 0) == 0))
        std::cout << "mapping " << line << "\n";
    }
    for (size_t i = 0; i < size; i += page) assert(bytes[i] == 29);
    assert(munmap(allocation, size) == 0);
    const auto released = sample(requestHuge ? "huge_released" : "base_released");
    const bool response = held > before && released < held;
    std::cout << (requestHuge ? "Huge-page increase and release observed=" : "Base-page control increase observed=")
      << (response ? "yes" : "no") << "\n";
  };
  std::ifstream statusFile("/proc/self/status");
  std::string statusLine;
  while (std::getline(statusFile, statusLine))
    if (statusLine.rfind("THP_enabled:", 0) == 0) std::cout << statusLine << "\n";
  sample("baseline"); trial(false); trial(true);
  std::cout << "Data verified; both mappings released. No global THP setting changed.\n";
#endif
}
