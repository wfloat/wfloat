#include "../cpp/ProcessCpuCounters.h"
#include <cassert>
#include <chrono>
#include <iostream>
#include <unistd.h>

template<class F> void fails(F f) { bool threw = false; try { f(); } catch (const std::exception &) { threw = true; } assert(threw); }
int main() {
  assert(bench::cpuTimevalUs(timeval{3, 125001}) == 3125001);
  assert(bench::cpuTimevalUs(timeval{0, 0}) == 0);
  fails([] { bench::cpuTimevalUs(timeval{-1, 0}); });
  fails([] { bench::cpuTimevalUs(timeval{0, -1}); });
  fails([] { bench::cpuTimevalUs(timeval{0, 1000000}); });
  fails([] { bench::cpuTimevalUs(timeval{bench::maxExactCpuUs / 1000000 + 1, 0}); });
  assert(bench::cpuTimevalUs(timeval{bench::maxExactCpuUs / 1000000, bench::maxExactCpuUs % 1000000}) == bench::maxExactCpuUs);
  fails([] { bench::ProcessCpuCounters{bench::maxExactCpuUs, 1}.totalUs(); });
  const auto before = bench::readProcessCpuCounters();
  volatile double value = 0.1;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
  do { for (int i = 0; i < 10000; ++i) value = value * .99999 + .00001; }
  while (std::chrono::steady_clock::now() < deadline);
  const auto arithmetic = bench::readProcessCpuCounters();
  assert(arithmetic.userUs > before.userUs);
  assert(arithmetic.systemUs >= before.systemUs);
  int descriptors[2]; assert(pipe(descriptors) == 0);
  char byte = 'a', readByte = 0;
  for (int i = 0; i < 100000; ++i) {
    assert(write(descriptors[1], &byte, 1) == 1);
    assert(read(descriptors[0], &readByte, 1) == 1);
    assert(readByte == byte);
  }
  assert(close(descriptors[0]) == 0); assert(close(descriptors[1]) == 0);
  const auto syscalls = bench::readProcessCpuCounters();
  assert(syscalls.systemUs > arithmetic.systemUs);
  assert(syscalls.userUs >= arithmetic.userUs);
  std::cout << "PASS: conversion and exact-integer limits; arithmetic user/kernel deltas "
    << arithmetic.userUs - before.userUs << "/" << arithmetic.systemUs - before.systemUs
    << " us; pipe-loop user/kernel deltas " << syscalls.userUs - arithmetic.userUs << "/"
    << syscalls.systemUs - arithmetic.systemUs << " us; checksum " << value << '\n';
}
