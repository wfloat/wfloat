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
    const auto r = parse("Rss: 16 kB\nPss: 12 kB\nPrivate_Dirty: 999 kB\nPss_Dirty: " + std::to_string(kb) + " kB\n");
    assert(r.dirtyPss.bytes == kb * 1024ULL && r.pss.bytes == 12288);
  }
  for (const auto *bad : {"", "Pss_Dirty: -1 kB\n", "Pss_Dirty: 1 MB\n", "Pss_Dirty: 1 kB extra\n",
      "Pss_Dirty: 1 kB\nPss_Dirty: 2 kB\n", "Pss_Dirty: 18014398509481984 kB\n"}) {
    const auto r = parse(std::string("Rss: 8 kB\nPss: 4 kB\n") + bad);
    assert(!r.dirtyPss.bytes && !r.dirtyPss.error.empty() && r.bytes == 8192 && r.pss.bytes == 4096);
  }
  assert(!parse("Pss_Dirty: 1 kB\nRss: 8 kB\n").dirtyPss.bytes);
  assert(parse("Rss: 8 kB\nPss_Dirty: 18014398509481983 kB\n").dirtyPss.bytes == 18446744073709550592ULL);
  const auto sum = parse("Rss: 8 kB\nPss_Dirty: 3 kB\nRss: 8 kB\nPss_Dirty: 5 kB\n", false);
  assert(sum.dirtyPss.bytes == 8192 && sum.dirtyPss.source == "/proc/self/smaps:sum(Pss_Dirty)");
  for (const auto *text : {"Rss: 8 kB\nRss: 8 kB\nPss_Dirty: 4 kB\n",
      "Rss: 8 kB\nPss_Dirty: 4 kB\nRss: 8 kB\n",
      "Rss: 8 kB\nPss_Dirty: 18014398509481983 kB\nRss: 8 kB\nPss_Dirty: 1 kB\n"})
    assert(!parse(text, false).dirtyPss.bytes);
  std::cout << "Pss_Dirty field selection, zero, missing/duplicate/malformed/overflow and complete fallback sums passed\n";
#ifdef __ANDROID__
  alarm(30);
  constexpr size_t size = 64 * 1024 * 1024;
  constexpr int64_t tolerance = 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory(); assert(r.dirtyPss.bytes && r.pss.bytes && r.privateDirty.bytes && r.sharedDirty.bytes);
    std::cout << phase << " dirtyPss=" << *r.dirtyPss.bytes << " totalPss=" << *r.pss.bytes
      << " privateDirty=" << *r.privateDirty.bytes << " sharedDirty=" << *r.sharedDirty.bytes << " RSS=" << r.bytes << " bytes\n";
    return r;
  };
  const auto delta = [](uint64_t after, uint64_t before) { return static_cast<int64_t>(after) - static_cast<int64_t>(before); };
  const auto near = [](int64_t actual, int64_t expected) {
    if (std::abs(actual - expected) >= tolerance) std::cerr << "Unexpected delta " << actual << ", expected " << expected << " bytes\n";
    assert(std::abs(actual - expected) < tolerance);
  };
  char path[] = "/data/local/tmp/wfloat-dirty-pss-XXXXXX";
  const int fd = mkstemp(path); assert(fd >= 0); assert(unlink(path) == 0);
  unsigned char data[4096]; memset(data, 7, sizeof(data));
  for (size_t i = 0; i < size; i += sizeof(data)) assert(write(fd, data, sizeof(data)) == sizeof(data));
  assert(fsync(fd) == 0);
  sample("warmup"); const auto before = sample("before");
  auto *mapping = static_cast<volatile unsigned char *>(mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0));
  assert(mapping != MAP_FAILED);
  near(delta(*sample("mapped_untouched").dirtyPss.bytes, *before.dirtyPss.bytes), 0);
  for (size_t i = 0; i < size; i += page) assert(mapping[i] == 7);
  const auto clean = sample("clean_file_read");
  near(delta(*clean.dirtyPss.bytes, *before.dirtyPss.bytes), 0);
  near(delta(*clean.pss.bytes, *before.pss.bytes), size);
  for (size_t i = 0; i < size; i += page) mapping[i] = 9;
  const auto dirty = sample("private_pages_modified");
  near(delta(*dirty.dirtyPss.bytes, *clean.dirtyPss.bytes), size);
  near(delta(*dirty.pss.bytes, *clean.pss.bytes), 0);
  int command[2], ready[2]; assert(pipe(command) == 0 && pipe(ready) == 0);
  const auto child = fork(); assert(child >= 0);
  if (child == 0) {
    close(command[1]); close(ready[0]);
    for (size_t i = 0; i < size; i += page) if (mapping[i] != 9) _exit(2);
    if (write(ready[1], "R", 1) != 1) _exit(3);
    char op; read(command[0], &op, 1);
    _exit(0); // Also exits if parent failure closes its command pipe.
  }
  close(command[0]); close(ready[1]); char ack;
  assert(read(ready[0], &ack, 1) == 1 && ack == 'R');
  const auto shared = sample("dirty_pages_shared_with_child");
  near(delta(*dirty.dirtyPss.bytes, *shared.dirtyPss.bytes), size / 2);
  near(delta(*shared.sharedDirty.bytes, *dirty.sharedDirty.bytes), size);
  near(delta(shared.bytes, dirty.bytes), 0);
  close(command[1]); close(ready[0]); int status;
  assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  near(delta(*sample("child_exited").dirtyPss.bytes, *dirty.dirtyPss.bytes), 0);
  unsigned char original = 0;
  for (size_t i = 0; i < size; i += page) assert(pread(fd, &original, 1, i) == 1 && original == 7 && mapping[i] == 9);
  assert(munmap(const_cast<unsigned char *>(mapping), size) == 0); assert(close(fd) == 0);
  near(delta(*sample("released").dirtyPss.bytes, *before.dirtyPss.bytes), 0);
  alarm(0);
  std::cout << "Clean file pages raised total PSS but not dirty PSS; private modifications raised dirty PSS; sharing apportioned dirty pages; original file unchanged and cleanup passed\n";
#endif
}
