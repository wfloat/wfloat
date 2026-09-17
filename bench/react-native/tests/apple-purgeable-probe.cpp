#include "../cpp/ApplePurgeableProbe.h"
#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
int main() {
#ifdef __APPLE__
  bench::ApplePurgeableProbe probe;
  assert(probe.heldBytes() == 0);
  bool rejected = false;
  try { probe.setState(VM_PURGABLE_VOLATILE); } catch (const std::runtime_error&) { rejected = true; }
  assert(rejected);
  const auto baseline = bench::readResidentMemory();
  probe.hold(); assert(probe.heldBytes() == 16777216);
  const auto held = bench::readResidentMemory();
  assert(*held.purgeableNonvolatile.bytes == *baseline.purgeableNonvolatile.bytes + probe.heldBytes());
  assert(probe.setState(VM_PURGABLE_VOLATILE) == VM_PURGABLE_NONVOLATILE);
  const auto volatileReading = bench::readResidentMemory();
  assert(*volatileReading.purgeableNonvolatile.bytes == *baseline.purgeableNonvolatile.bytes);
  const auto previous = probe.setState(VM_PURGABLE_NONVOLATILE);
  assert(previous == VM_PURGABLE_VOLATILE || previous == VM_PURGABLE_EMPTY);
  probe.rewrite();probe.setState(VM_PURGABLE_EMPTY);
  probe.release();probe.release();assert(probe.heldBytes() == 0);
  assert(bench::readResidentMemory().purgeableNonvolatile.bytes == baseline.purgeableNonvolatile.bytes);
  probe.hold();probe.hold();probe.release();assert(probe.heldBytes() == 0);
  std::cout << "Bounded purgeable probe allocation, state transitions, rewrite, repeated hold/release passed\n";
#endif
}
