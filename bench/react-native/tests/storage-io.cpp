#include "../cpp/StorageIo.h"
#include <cassert>
#include <dirent.h>
#include <iostream>
template<typename F> void rejects(F f) { bool failed = false; try { f(); } catch (const std::exception &) { failed = true; } assert(failed); }
int main() {
  const std::string valid = "rchar: 123\nwchar: 456\nsyscr: 7\nsyscw: 8\nread_bytes: 9\nwrite_bytes: 10\ncancelled_write_bytes: 11\n";
  std::istringstream input(valid);
  const auto parsed = bench::parseStorageIo(input);
  assert(parsed.at("readBytes") == 9 && parsed.at("cancelledWriteBytes") == 11);
  for (const auto &bad : {valid + "read_bytes: 99\n", valid + "write_bytes: -1\n", std::string("read_bytes: 1\n"),
      std::string("rchar: 9007199254740992\n"), valid + "syscr: 1 bytes\n"})
    rejects([&] { std::istringstream stream(bad); bench::parseStorageIo(stream); });
  assert(bench::ioBlocksToBytes(2) == 1024);
  rejects([] { bench::ioBlocksToBytes(-1); });
  rejects([] { bench::ioBlocksToBytes(9007199254740991LL / 512 + 1); });
  assert(bench::exactIoBytes(9007199254740991ULL) == 9007199254740991ULL);
  rejects([] { bench::exactIoBytes(9007199254740992ULL); });

#ifdef __ANDROID__
  char androidPattern[] = "/data/local/tmp/wfloat-storage-test-XXXXXX";
  char *directory = mkdtemp(androidPattern);
#else
  char pattern[] = "/tmp/wfloat-storage-test-XXXXXX";
  char *directory = mkdtemp(pattern);
#endif
  assert(directory);
  bench::StorageIoCheck check;
  const auto cancelled = check.token(); check.cancel();
  rejects([&] { check.run(directory, cancelled); });
  for (int attempt = 0; attempt < 4; ++attempt) {
    const auto result = check.run(directory, check.token(), attempt >= 2);
    assert(result.snapshots.size() == 4 && result.fileBytes == 32 * 1024 * 1024);
    for (size_t i = 1; i < result.snapshots.size(); ++i) {
      assert(result.snapshots[i].sequence > result.snapshots[i - 1].sequence);
      assert(result.snapshots[i].beforeMs >= result.snapshots[i - 1].afterMs);
      for (const auto &[key, value] : result.snapshots[i].counters) assert(value >= result.snapshots[i - 1].counters.at(key));
    }
    assert(result.snapshots[1].counters.at("writeBytes") - result.snapshots[0].counters.at("writeBytes") >= result.fileBytes);
    std::cout << result.json() << '\n';
  }
  DIR *listing = opendir(directory); assert(listing);
  while (auto *entry = readdir(listing)) assert(std::string(entry->d_name) == "." || std::string(entry->d_name) == "..");
  closedir(listing); assert(rmdir(directory) == 0);
  std::cout << "Storage parsing, exact integers, file verification, repeat, cancellation and cleanup passed\n";
}
