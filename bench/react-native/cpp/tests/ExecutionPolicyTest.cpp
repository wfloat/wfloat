#include "../AndroidExecutionPolicySources.h"
#include <cassert>
#include <cstdio>
#include <climits>
static unsigned calls = 0;
static long fakeQuery(int option, unsigned long selector) {
  ++calls;
  switch (option) {
    case 13: case 68:
      assert(selector == 0); errno = EIO; return 0;
    case 52:
      assert(selector <= 2);
      if (selector == 0) return 9;
      if (selector == 1) { errno = EINVAL; return -1; }
      errno = ENODEV; return -1;
    case 78: assert(selector == 2); return LONG_MAX;
    case 79: assert(selector == 1); errno = EPERM; return -1;
    default: assert(false); return -1; // Any setter or unexpected option fails.
  }
}
int main() {
  const auto record = bench::androidExecutionPolicySources(fakeQuery, 42);
  assert(calls == 7);
  assert(record.find("\"callingThreadId\":\"42\"") != std::string::npos);
  assert(record.find("\"returnValue\":\"0\",\"errno\":0,\"value\":\"0\"") != std::string::npos);
  assert(record.find("\"value\":\"9\"") != std::string::npos);
  assert(record.find("\"value\":\"" + std::to_string(LONG_MAX) + "\"") != std::string::npos);
  assert(record.find("\"value\":null") != std::string::npos);
  puts(record.c_str());
  puts("PASS: only reviewed getters/selectors; zero, denied, unsupported and exact large values remain distinct");
}
