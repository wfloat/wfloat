#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(75);
  task_vm_info_data_t fixture{};
  fixture.ledger_purgeable_volatile_compressed = 16777216;
  fixture.ledger_purgeable_novolatile_compressed = 33554432;
  fixture.ledger_purgeable_volatile = 67108864;
  const auto parsed = bench::purgeableVolatileCompressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
  assert(parsed.bytes == 16777216 && parsed.rawBytes == 16777216 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).ledger_purgeable_volatile_compressed");
  for (const int64_t value : {int64_t(0), INT64_MAX, int64_t(-1), INT64_MIN}) {
    fixture.ledger_purgeable_volatile_compressed = value;
    const auto result = bench::purgeableVolatileCompressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
    assert(result.rawBytes == value);
    if (value < 0) assert(!result.bytes && !result.error.empty());
    else assert(result.bytes == static_cast<uint64_t>(value) && result.error.empty());
  }
  for (auto status : {KERN_SUCCESS, KERN_FAILURE}) {
    const auto result = bench::purgeableVolatileCompressedFromTaskVmInfo(status, TASK_VM_INFO_REV3_COUNT - 1, fixture);
    assert(!result.bytes && !result.rawBytes && !result.error.empty());
  }
  assert(!bench::purgeableVolatileCompressedFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).rawBytes);
  std::cout << "Field selection, revision, failure, zero and signed range passed\n";
  const auto direct = [] {
    task_vm_info_data_t info{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV3_COUNT);
    return info;
  };
  constexpr vm_size_t size = 16 * 1024 * 1024;
  unsigned exactPositiveComparisons = 0;
  const auto sample = [&direct, &exactPositiveComparisons](const char* phase, bool volatileState = false) {
    const auto before = direct();
    const auto collected = bench::readResidentMemory();
    const auto after = direct();
    assert(collected.purgeableVolatileCompressed.bytes && collected.purgeableVolatileCompressed.error.empty());
    const auto value = *collected.purgeableVolatileCompressed.bytes;
    assert(collected.purgeableVolatileCompressed.rawBytes == static_cast<int64_t>(value));
    assert(value <= size);
    if (!volatileState) {
      assert(value == 0 && before.ledger_purgeable_volatile_compressed == 0 && after.ledger_purgeable_volatile_compressed == 0);
    }
    const bool exact = before.ledger_purgeable_volatile_compressed == static_cast<int64_t>(value)
      && after.ledger_purgeable_volatile_compressed == static_cast<int64_t>(value);
    if (value > 0 && exact) ++exactPositiveComparisons;
    // While volatile, compression and discard may change the balance in either
    // direction. Preserve all three observations instead of asserting atomicity.
    std::cout << phase << " volatileCompressed=" << value
      << " directBefore=" << before.ledger_purgeable_volatile_compressed
      << " directAfter=" << after.ledger_purgeable_volatile_compressed << " exact=" << exact
      << " nonvolatileCompressed=" << *collected.purgeableNonvolatileCompressed.bytes
      << " volatileResident=" << *collected.purgeableVolatile.bytes << "\n";
    return collected;
  };
  sample("baseline");
  vm_address_t address = 0;
  auto status = vm_allocate(mach_task_self(), &address, size, VM_FLAGS_ANYWHERE | VM_FLAGS_PURGABLE);
  std::cout << "vm_allocate status=" << status << "\n";
  if (status != KERN_SUCCESS) return 77;
  auto data = reinterpret_cast<volatile unsigned char*>(address);
  bool positive = false;
  for (int attempt = 0; attempt < 2 && !positive; ++attempt) {
    std::cout << "attempt=" << attempt + 1 << "\n";
    int state = VM_PURGABLE_NONVOLATILE;
    assert(vm_purgable_control(mach_task_self(), address, VM_PURGABLE_SET_STATE, &state) == KERN_SUCCESS);
    for (size_t i = 0; i < size; ++i) data[i] = 71;
    auto prepared = sample("written_nonvolatile");
    for (int wait = 0; wait < 60 && *prepared.purgeableNonvolatileCompressed.bytes == 0; ++wait) {
      usleep(500000); prepared = sample("waiting_for_compression");
    }
    if (*prepared.purgeableNonvolatileCompressed.bytes == 0) {
      std::cout << "No natural compression in preparation window\n";
      break;
    }
    state = VM_PURGABLE_VOLATILE;
    const auto transition = vm_purgable_control(mach_task_self(), address, VM_PURGABLE_SET_STATE, &state);
    assert(transition == KERN_SUCCESS && (state & VM_PURGABLE_STATE_MASK) == VM_PURGABLE_NONVOLATILE);
    // Collect immediately: printing first gives the OS more time to discard.
    const auto observed = sample("marked_volatile", true);
    positive = *observed.purgeableVolatileCompressed.bytes > 0 && exactPositiveComparisons > 0;
    state = VM_PURGABLE_NONVOLATILE;
    assert(vm_purgable_control(mach_task_self(), address, VM_PURGABLE_SET_STATE, &state) == KERN_SUCCESS);
    std::cout << "restored previousState=" << state << "\n";
    assert((state & VM_PURGABLE_STATE_MASK) == VM_PURGABLE_VOLATILE || (state & VM_PURGABLE_STATE_MASK) == VM_PURGABLE_EMPTY);
    sample("restored_nonvolatile");
    if ((state & VM_PURGABLE_STATE_MASK) == VM_PURGABLE_VOLATILE)
      for (size_t i = 0; i < size; ++i) assert(data[i] == 71);
    // Contents may have been discarded; fully initialize before future use.
    for (size_t i = 0; i < size; ++i) data[i] = 93;
  }
  int state = VM_PURGABLE_VOLATILE;
  assert(vm_purgable_control(mach_task_self(), address, VM_PURGABLE_SET_STATE, &state) == KERN_SUCCESS);
  state = VM_PURGABLE_EMPTY; // This allocation only, never global purge.
  assert(vm_purgable_control(mach_task_self(), address, VM_PURGABLE_SET_STATE, &state) == KERN_SUCCESS);
  sample("emptied");
  assert(vm_deallocate(mach_task_self(), address, size) == KERN_SUCCESS);
  sample("released");
  if (!positive) {
    std::cout << "INCONCLUSIVE: no positive volatile compressed reading with bracketing agreement; zero is not positive proof\n";
    return 77;
  }
  std::cout << "Positive compressed volatile transition with exact bracketing queries, restoration and release verified\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  const auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 4096 && !reading.purgeableVolatileCompressed.bytes && !reading.purgeableVolatileCompressed.rawBytes);
  std::cout << "Android counters preserved; no synthetic iOS compressed volatile field\n";
#endif
}
