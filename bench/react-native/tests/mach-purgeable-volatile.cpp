#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(30);
  task_vm_info_data_t fixture{};
  fixture.ledger_purgeable_volatile = 16777216;
  fixture.ledger_purgeable_nonvolatile = 33554432;
  fixture.ledger_purgeable_volatile_compressed = 67108864;
  fixture.purgeable_volatile_resident = 134217728;
  const auto parsed = bench::purgeableVolatileFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
  assert(parsed.bytes == 16777216 && parsed.rawBytes == 16777216 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).ledger_purgeable_volatile");
  for (const int64_t value : {int64_t(0), INT64_MAX, int64_t(-1), INT64_MIN}) {
    fixture.ledger_purgeable_volatile = value;
    const auto result = bench::purgeableVolatileFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
    assert(result.rawBytes == value);
    if (value < 0) assert(!result.bytes && !result.error.empty());
    else assert(result.bytes == static_cast<uint64_t>(value) && result.error.empty());
  }
  for (auto status : {KERN_SUCCESS, KERN_FAILURE}) {
    const auto result = bench::purgeableVolatileFromTaskVmInfo(status, TASK_VM_INFO_REV3_COUNT - 1, fixture);
    assert(!result.bytes && !result.rawBytes && !result.error.empty());
  }
  assert(!bench::purgeableVolatileFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).rawBytes);
  std::cout << "Field selection, revision, failure, zero and signed range passed\n";
  const auto direct = [] {
    task_vm_info_data_t info{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV3_COUNT);
    return info;
  };
  const auto sample = [&direct](const char* phase, bool discardMayRace = false) {
    const auto before = direct();
    const auto collected = bench::readResidentMemory();
    const auto after = direct();
    assert(collected.purgeableVolatile.bytes && collected.purgeableVolatile.error.empty());
    const auto value = *collected.purgeableVolatile.bytes;
    assert(collected.purgeableVolatile.rawBytes == static_cast<int64_t>(value));
    assert(collected.purgeableNonvolatile.bytes && collected.physicalFootprint.bytes);
    if (discardMayRace) {
      // This isolated process only loses volatile pages between these calls.
      // Do not misidentify a real asynchronous discard as a collector mismatch.
      assert(before.ledger_purgeable_volatile >= static_cast<int64_t>(value));
      assert(static_cast<int64_t>(value) >= after.ledger_purgeable_volatile);
    } else {
      assert(before.ledger_purgeable_volatile == static_cast<int64_t>(value));
      assert(after.ledger_purgeable_volatile == static_cast<int64_t>(value));
    }
    std::cout << phase << " volatile=" << value << " directBefore=" << before.ledger_purgeable_volatile
      << " directAfter=" << after.ledger_purgeable_volatile << " nonvolatile=" << *collected.purgeableNonvolatile.bytes
      << " compressedDiagnostic=" << after.ledger_purgeable_volatile_compressed << "\n";
    return value;
  };
  sample("warmup");
  const auto baseline = sample("baseline");
  assert(baseline == 0); // Dedicated diagnostic process, no UI/framework caches.
  constexpr vm_size_t size = 16 * 1024 * 1024;
  vm_address_t address = 0;
  const auto allocationStatus = vm_allocate(mach_task_self(), &address, size, VM_FLAGS_ANYWHERE | VM_FLAGS_PURGABLE);
  std::cout << "vm_allocate status=" << allocationStatus << "\n";
  if (allocationStatus != KERN_SUCCESS) return 77;
  auto data = reinterpret_cast<volatile unsigned char*>(address);
  const auto setState = [address](int desired) {
    int state = desired;
    const auto status = vm_purgable_control(mach_task_self(), address, VM_PURGABLE_SET_STATE, &state);
    std::cout << "setState=" << desired << " status=" << status << " previousState=" << state << "\n";
    assert(status == KERN_SUCCESS);
    return state & VM_PURGABLE_STATE_MASK;
  };
  assert(sample("allocated_untouched") == baseline);
  bool positive = false;
  // Bounded retries permit immediate OS discard without accepting zero as positive proof.
  for (int attempt = 0; attempt < 4 && !positive; ++attempt) {
    const int old = setState(VM_PURGABLE_NONVOLATILE);
    assert(old == VM_PURGABLE_NONVOLATILE || old == VM_PURGABLE_VOLATILE || old == VM_PURGABLE_EMPTY);
    for (size_t i = 0; i < size; ++i) data[i] = 71;
    assert(sample("written_nonvolatile") == baseline);
    assert(setState(VM_PURGABLE_VOLATILE) == VM_PURGABLE_NONVOLATILE);
    const auto value = sample("volatile", true);
    assert(value <= size);
    positive = value > 0;
  }
  const int old = setState(VM_PURGABLE_NONVOLATILE);
  assert(old == VM_PURGABLE_VOLATILE || old == VM_PURGABLE_EMPTY);
  // Volatile contents can be gone. Reinitialize before relying on their values.
  for (size_t i = 0; i < size; ++i) data[i] = 93;
  assert(sample("restored_and_rewritten") == baseline);
  assert(setState(VM_PURGABLE_VOLATILE) == VM_PURGABLE_NONVOLATILE);
  sample("volatile_again", true);
  setState(VM_PURGABLE_EMPTY); // This allocation only; never VM_PURGABLE_PURGE_ALL.
  assert(sample("emptied") == baseline);
  assert(vm_deallocate(mach_task_self(), address, size) == KERN_SUCCESS);
  assert(sample("released") == baseline);
  if (!positive) {
    std::cout << "INCONCLUSIVE: no positive collector value before discard in four bounded attempts\n";
    return 77;
  }
  std::cout << "Positive volatile response, restoration, targeted empty and release verified; no global purge or pressure\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  const auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 4096 && !reading.purgeableVolatile.bytes && !reading.purgeableVolatile.rawBytes);
  std::cout << "Android counters preserved; no synthetic iOS volatile purgeable field\n";
#endif
}
