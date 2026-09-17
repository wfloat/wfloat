#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#ifdef __ANDROID__
#include <android/sharedmem.h>
#include <sys/wait.h>
#endif

int main() {
  std::cout << std::unitbuf;
  const auto parse = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 8}) {
    const auto r = parse("Rss: 16 kB\nPss: 12 kB\nPss_Anon: 999 kB\nAnonymous: 16 kB\nPss_Shmem: " + std::to_string(kb) + " kB\n");
    assert(r.shmemPss.bytes == kb * 1024ULL && r.anonymous.bytes == 16384 && r.pss.bytes == 12288);
  }
  for (const auto *bad : {"", "Pss_Shmem: -1 kB\n", "Pss_Shmem: 1 MB\n", "Pss_Shmem: 1 kB extra\n",
      "Pss_Shmem: 1 kB\nPss_Shmem: 2 kB\n", "Pss_Shmem: 18014398509481984 kB\n"}) {
    const auto r = parse(std::string("Rss: 8 kB\nPss: 4 kB\n") + bad);
    assert(!r.shmemPss.bytes && !r.shmemPss.error.empty() && r.bytes == 8192 && r.pss.bytes == 4096);
  }
  assert(!parse("Pss_Shmem: 1 kB\nRss: 8 kB\n").shmemPss.bytes);
  assert(parse("Rss: 8 kB\nPss_Shmem: 18014398509481983 kB\n").shmemPss.bytes == 18446744073709550592ULL);
  const auto fallback = parse("Rss: 8 kB\nPss: 4 kB\nAnonymous: 8 kB\nPss_Shmem: 4 kB\n", false);
  assert(fallback.bytes == 8192 && fallback.pss.bytes == 4096 && !fallback.shmemPss.bytes);
  assert(fallback.shmemPss.source == "/proc/self/smaps_rollup:Pss_Shmem");
  std::cout << "Pss_Shmem field selection, zero, missing/duplicate/malformed/overflow and unavailable fallback passed\n";
#ifdef __ANDROID__
  alarm(30);
  constexpr size_t size = 64 * 1024 * 1024;
  constexpr int64_t tolerance = 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE); assert(page > 0);
  const auto sample = [](const char *phase) {
    const auto r = bench::readResidentMemory(); assert(r.shmemPss.bytes && r.filePss.bytes && r.anonymousPss.bytes);
    std::cout << phase << " shmemPss=" << *r.shmemPss.bytes << " filePss=" << *r.filePss.bytes
      << " anonymousPss=" << *r.anonymousPss.bytes << " RSS=" << r.bytes << " bytes\n";
    return r;
  };
  const auto delta = [](uint64_t after, uint64_t before) { return static_cast<int64_t>(after) - static_cast<int64_t>(before); };
  const auto near = [](int64_t actual, int64_t expected) {
    if (std::abs(actual - expected) >= tolerance) std::cerr << "Unexpected delta " << actual << ", expected " << expected << " bytes\n";
    assert(std::abs(actual - expected) < tolerance);
  };
  const int fd = ASharedMemory_create("wfloat-shmem-pss-test", size); assert(fd >= 0);
  sample("warmup"); const auto before = sample("before");
  auto *first = static_cast<volatile unsigned char *>(mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0));
  assert(first != MAP_FAILED);
  near(delta(*sample("mapped_untouched").shmemPss.bytes, *before.shmemPss.bytes), 0);
  for (size_t i = 0; i < size; i += page) first[i] = 7;
  const auto once = sample("written_once");
  near(delta(*once.shmemPss.bytes, *before.shmemPss.bytes), size);
  near(delta(*once.filePss.bytes, *before.filePss.bytes), 0);
  near(delta(*once.anonymousPss.bytes, *before.anonymousPss.bytes), 0);
  auto *second = static_cast<volatile unsigned char *>(mmap(nullptr, size, PROT_READ, MAP_SHARED, fd, 0));
  assert(second != MAP_FAILED);
  for (size_t i = 0; i < size; i += page) assert(second[i] == 7);
  const auto twice = sample("read_two_mappings");
  near(delta(*twice.shmemPss.bytes, *once.shmemPss.bytes), 0);
  near(delta(twice.bytes, once.bytes), size);

  int command[2], ready[2]; assert(pipe(command) == 0 && pipe(ready) == 0);
  const auto child = fork(); assert(child >= 0);
  if (child == 0) {
    close(command[1]); close(ready[0]);
    for (size_t i = 0; i < size; i += page) if (first[i] != 7 || second[i] != 7) _exit(2);
    if (write(ready[1], "R", 1) != 1) _exit(3);
    char op;
    while (read(command[0], &op, 1) == 1) {
      if (op == 'W') {
        for (size_t i = 0; i < size; i += page) first[i] = 9;
        if (write(ready[1], "D", 1) != 1) _exit(4);
      } else break;
    }
    _exit(0); // Parent failure also closes the command pipe.
  }
  close(command[0]); close(ready[1]); char ack;
  assert(read(ready[0], &ack, 1) == 1 && ack == 'R');
  const auto shared = sample("shared_with_child");
  near(delta(*twice.shmemPss.bytes, *shared.shmemPss.bytes), size / 2);
  near(delta(shared.bytes, twice.bytes), 0);
  assert(write(command[1], "W", 1) == 1);
  assert(read(ready[0], &ack, 1) == 1 && ack == 'D');
  for (size_t i = 0; i < size; i += page) assert(first[i] == 9 && second[i] == 9);
  near(delta(*sample("child_shared_writes").shmemPss.bytes, *shared.shmemPss.bytes), 0);
  close(command[1]); close(ready[0]); int status;
  assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  near(delta(*sample("child_exited").shmemPss.bytes, *twice.shmemPss.bytes), 0);
  assert(munmap(const_cast<unsigned char *>(second), size) == 0);
  near(delta(*sample("one_mapping_remaining").shmemPss.bytes, *once.shmemPss.bytes), 0);
  assert(munmap(const_cast<unsigned char *>(first), size) == 0); assert(close(fd) == 0);
  near(delta(*sample("released").shmemPss.bytes, *before.shmemPss.bytes), 0);
  alarm(0);
  std::cout << "64 MiB Android shared memory stayed in shmem; duplicate mappings did not double PSS; child shared the charge and writes; cleanup passed\n";
#endif
}
