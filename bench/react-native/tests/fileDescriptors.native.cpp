// Cross-compile for Android and run as a standalone process for exact deltas.
#include "../cpp/FileDescriptors.h"
#include <cassert>
#include <fcntl.h>
#include <iostream>
#include <unistd.h>
#include <vector>

int main() {
  int parsed = -1;
  assert(bench::parseDescriptorName("0", parsed) && parsed == 0);
  assert(bench::parseDescriptorName("2147483647", parsed) && parsed == INT_MAX);
  for (const auto *name : {"", ".", "..", "-1", "1x", "2147483648", "99999999999999999999"})
    assert(!bench::parseDescriptorName(name, parsed));
  bool failed = false;
  try { bench::readFileDescriptors("/path/that/does/not/exist"); }
  catch (const std::system_error &e) { failed = e.code().value() == ENOENT; }
  assert(failed);

  // Independent reference: inspect actual open descriptors without opening any.
  int reference = 0;
  for (int fd = 0; fd < 4096; ++fd) if (fcntl(fd, F_GETFD) != -1) ++reference;
  const int baseline = bench::readFileDescriptors().count;
  assert(baseline == reference);
  std::vector<int> held;
  for (int i = 0; i < 16; ++i) {
    int pipeFds[2]; assert(pipe(pipeFds) == 0);
    held.push_back(pipeFds[0]); held.push_back(pipeFds[1]);
  }
  assert(bench::readFileDescriptors().count == baseline + 32);
  const int duplicate = dup(held[0]); assert(duplicate >= 0);
  assert(bench::readFileDescriptors().count == baseline + 33);
  assert(close(held[3]) == 0); held[3] = -1; // Leave a hole in descriptor numbers.
  for (int i = 0; i < 1000; ++i) assert(bench::readFileDescriptors().count == baseline + 32);
  for (int fd : held) if (fd >= 0) assert(close(fd) == 0);
  assert(close(duplicate) == 0);
  assert(bench::readFileDescriptors().count == baseline);
  std::cout << "PASS: independent reference=" << reference
    << "; 32 pipe handles; duplicate +1; hole; 1000 scans without leaks; recovery=" << baseline << '\n';
}
