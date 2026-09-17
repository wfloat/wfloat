#include "../cpp/FileFaultProbe.h"
#include <cassert>
#include <dirent.h>
#include <iostream>
#include <thread>

size_t entries(const char *path) {
  DIR *dir = opendir(path);
  assert(dir);
  size_t result = 0;
  while (const auto *entry = readdir(dir)) if (entry->d_name[0] != '.') ++result;
  closedir(dir);
  return result;
}

int main() {
  char directory[] = "/tmp/wfloat-file-probe-test-XXXXXX";
  assert(mkdtemp(directory));
  bench::FileFaultProbe probe;
  const auto openFiles = entries("/dev/fd");
  const auto complete = probe.run(directory, probe.token());
  std::cout << complete.json() << '\n';
  assert(complete.status == "completed" && complete.passes.size() == 2);
  assert(complete.passes[0].touchedPages == complete.fileBytes / complete.pageSizeBytes);
  assert(complete.passes[0].touchedPages == complete.passes[1].touchedPages);
  assert(complete.passes[0].checksum == complete.passes[1].checksum);
  for (const auto &pass : complete.passes) {
    assert(pass.after.counters.first >= pass.before.counters.first);
    assert(pass.after.counters.second >= pass.before.counters.second);
    assert(pass.readFinishedMs >= pass.readStartedMs);
  }
  assert(entries(directory) == 0 && entries("/dev/fd") == openFiles && !probe.running());

  const auto oldToken = probe.token();
  probe.cancel();
  assert(probe.run(directory, oldToken).status == "cancelled");
  assert(probe.run(directory, probe.token(), bench::FileFaultProbe::capacity, 1).status == "deadline");
  assert(probe.run(std::string(directory) + "/missing", probe.token()).status == "failed");
  assert(entries(directory) == 0 && entries("/dev/fd") == openFiles);

  bench::FileFaultResult interrupted;
  std::thread worker([&] { interrupted = probe.run(directory, probe.token()); });
  while (!probe.running()) std::this_thread::yield();
  std::this_thread::sleep_for(std::chrono::milliseconds(2));
  bool overlappingRejected = false;
  try { probe.run(directory, probe.token()); }
  catch (const std::exception &) { overlappingRejected = true; }
  assert(overlappingRejected);
  probe.cancel();
  worker.join();
  assert(interrupted.status == "cancelled" && !probe.running());
  assert(entries(directory) == 0 && entries("/dev/fd") == openFiles);
  // Cancellation cannot poison the next run.
  assert(probe.run(directory, probe.token(), 1024 * 1024).status == "completed");
  assert(entries(directory) == 0 && entries("/dev/fd") == openFiles);
  assert(rmdir(directory) == 0);
  std::cout << "Native file probe: completion, verification, cancellation, deadline, overlap and cleanup passed\n";
}
