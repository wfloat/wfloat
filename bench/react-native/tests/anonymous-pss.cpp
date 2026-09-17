#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#include <sys/wait.h>

int main() {
  const auto parse = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 8}) {
    const auto r = parse("Rss: 16 kB\nPss: 12 kB\nPss_File: 999 kB\nAnonymous: 16 kB\nPss_Anon: " + std::to_string(kb) + " kB\n");
    assert(r.anonymousPss.bytes == kb * 1024ULL && r.anonymous.bytes == 16384 && r.pss.bytes == 12288);
  }
  for (const auto *bad : {"", "Pss_Anon: -1 kB\n", "Pss_Anon: 1 MB\n", "Pss_Anon: 1 kB extra\n",
      "Pss_Anon: 1 kB\nPss_Anon: 2 kB\n", "Pss_Anon: 18014398509481984 kB\n"}) {
    const auto r = parse(std::string("Rss: 8 kB\nPss: 4 kB\n") + bad);
    assert(!r.anonymousPss.bytes && !r.anonymousPss.error.empty() && r.bytes == 8192 && r.pss.bytes == 4096);
  }
  assert(!parse("Pss_Anon: 1 kB\nRss: 8 kB\n").anonymousPss.bytes);
  assert(parse("Rss: 8 kB\nPss_Anon: 18014398509481983 kB\n").anonymousPss.bytes == 18446744073709550592ULL);
  const auto fallback = parse("Rss: 8 kB\nPss: 4 kB\nAnonymous: 8 kB\nPss_Anon: 4 kB\n", false);
  assert(fallback.bytes == 8192 && fallback.pss.bytes == 4096 && !fallback.anonymousPss.bytes);
  assert(fallback.anonymousPss.source == "/proc/self/smaps_rollup:Pss_Anon");
  std::cout << "Pss_Anon field selection, zero, missing/duplicate/malformed/overflow and unavailable fallback passed\n";
#ifdef __ANDROID__
  alarm(30);
  constexpr size_t size = 64 * 1024 * 1024;
  constexpr int64_t tolerance = 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory(); assert(r.anonymousPss.bytes && r.anonymous.bytes);
    std::cout << phase << " anonymousPss=" << *r.anonymousPss.bytes << " anonymousRSS=" << *r.anonymous.bytes << " bytes\n";
    return r;
  };
  const auto near = [](int64_t actual, int64_t expected) { assert(std::abs(actual - expected) < tolerance); };
  sample("warmup"); const auto before = sample("before");
  auto *mapping = static_cast<volatile unsigned char *>(mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  assert(mapping != MAP_FAILED);
  near(*sample("reserved_untouched").anonymousPss.bytes - *before.anonymousPss.bytes, 0);
  for (size_t i = 0; i < size; i += page) mapping[i] = 7;
  const auto written = sample("private_written");
  near(*written.anonymousPss.bytes - *before.anonymousPss.bytes, size);
  int command[2], ready[2]; assert(pipe(command) == 0 && pipe(ready) == 0);
  std::cout.flush(); const auto child = fork(); assert(child >= 0);
  if (child == 0) {
    close(command[1]); close(ready[0]);
    if (write(ready[1], "R", 1) != 1) _exit(2);
    char op;
    while (read(command[0], &op, 1) == 1) {
      if (op == 'W') {
        for (size_t i = 0; i < size; i += page) mapping[i] = 9;
        if (write(ready[1], "D", 1) != 1) _exit(3);
      } else break;
    }
    _exit(0); // Also exits on parent failure when its command pipe closes.
  }
  close(command[0]); close(ready[1]); char ack;
  assert(read(ready[0], &ack, 1) == 1 && ack == 'R');
  const auto shared = sample("shared_with_child");
  near(static_cast<int64_t>(*written.anonymousPss.bytes) - *shared.anonymousPss.bytes, size / 2);
  near(static_cast<int64_t>(*shared.anonymous.bytes) - *written.anonymous.bytes, 0);
  assert(write(command[1], "W", 1) == 1);
  assert(read(ready[0], &ack, 1) == 1 && ack == 'D');
  const auto copied = sample("child_copied_pages");
  near(static_cast<int64_t>(*copied.anonymousPss.bytes) - *shared.anonymousPss.bytes, size / 2);
  near(static_cast<int64_t>(*copied.anonymous.bytes) - *written.anonymous.bytes, 0);
  for (size_t i = 0; i < size; i += page) assert(mapping[i] == 7);
  close(command[1]); close(ready[0]); int status; assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  assert(munmap(const_cast<unsigned char *>(mapping), size) == 0);
  near(static_cast<int64_t>(*sample("released").anonymousPss.bytes) - *before.anonymousPss.bytes, 0);
  alarm(0);
  std::cout << "64 MiB private allocation; fork apportioned about half without reducing anonymous RSS; child copy-on-write restored parent's share; cleanup passed\n";
#endif
}
