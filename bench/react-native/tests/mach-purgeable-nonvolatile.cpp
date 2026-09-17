#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(30);
  task_vm_info_data_t fixture{};
  fixture.ledger_purgeable_nonvolatile = 16777216;
  fixture.ledger_purgeable_novolatile_compressed = 33554432;
  fixture.ledger_purgeable_volatile = 67108864;
  const auto parsed = bench::purgeableNonvolatileFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
  assert(parsed.bytes == 16777216 && parsed.rawBytes == 16777216 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).ledger_purgeable_nonvolatile");
  for (const int64_t value : {int64_t(0), INT64_MAX, int64_t(-1), INT64_MIN}) {
    fixture.ledger_purgeable_nonvolatile = value;
    const auto result = bench::purgeableNonvolatileFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
    assert(result.rawBytes == value);
    if (value < 0) assert(!result.bytes && !result.error.empty());
    else assert(result.bytes == static_cast<uint64_t>(value) && result.error.empty());
  }
  for (auto status : {KERN_SUCCESS, KERN_FAILURE}) {
    const auto result = bench::purgeableNonvolatileFromTaskVmInfo(status, TASK_VM_INFO_REV3_COUNT - 1, fixture);
    assert(!result.bytes && !result.rawBytes && !result.error.empty());
  }
  assert(!bench::purgeableNonvolatileFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).rawBytes);
  std::cout << "Field selection, revision, failure, zero and signed range passed\n";
  const auto sample = [](const char* phase) {
    const auto collected = bench::readResidentMemory();
    task_vm_info_data_t direct{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV3_COUNT);
    assert(collected.purgeableNonvolatile.bytes && collected.purgeableNonvolatile.error.empty());
    assert(collected.purgeableNonvolatile.rawBytes == direct.ledger_purgeable_nonvolatile);
    assert(*collected.purgeableNonvolatile.bytes == static_cast<uint64_t>(direct.ledger_purgeable_nonvolatile));
    assert(collected.physicalFootprint.bytes && collected.reusable.bytes && collected.peakReusable.bytes);
    std::cout << phase << " nonvolatile=" << *collected.purgeableNonvolatile.bytes
      << " direct=" << direct.ledger_purgeable_nonvolatile
      << " compressedDiagnostic=" << direct.ledger_purgeable_novolatile_compressed
      << " volatileDiagnostic=" << direct.ledger_purgeable_volatile << "\n";
    return *collected.purgeableNonvolatile.bytes;
  };
  sample("warmup");
  const auto baseline = sample("baseline");
  constexpr vm_size_t size = 16 * 1024 * 1024;
  vm_address_t address = 0;
  auto status = vm_allocate(mach_task_self(), &address, size, VM_FLAGS_ANYWHERE | VM_FLAGS_PURGABLE);
  std::cout << "vm_allocate status=" << status << "\n";
  if (status != KERN_SUCCESS) return 77;
  assert(sample("allocated_untouched") == baseline);
  auto data = reinterpret_cast<volatile unsigned char*>(address);
  for (size_t i = 0; i < size; ++i) data[i] = 71;
  assert(sample("written_nonvolatile") == baseline + size);
  int state = VM_PURGABLE_VOLATILE;
  status = vm_purgable_control(mach_task_self(), address, VM_PURGABLE_SET_STATE, &state);
  std::cout << "set_volatile status=" << status << " previousState=" << state << "\n";
  assert(status == KERN_SUCCESS && (state & VM_PURGABLE_STATE_MASK) == VM_PURGABLE_NONVOLATILE);
  assert(sample("volatile") == baseline);
  state = VM_PURGABLE_NONVOLATILE;
  status = vm_purgable_control(mach_task_self(), address, VM_PURGABLE_SET_STATE, &state);
  std::cout << "restore_nonvolatile status=" << status << " previousState=" << state << "\n";
  assert(status == KERN_SUCCESS);
  assert((state & VM_PURGABLE_STATE_MASK) == VM_PURGABLE_VOLATILE || (state & VM_PURGABLE_STATE_MASK) == VM_PURGABLE_EMPTY);
  // The old state may report discarded contents. Reinitialize before using them.
  for (size_t i = 0; i < size; ++i) data[i] = 93;
  assert(sample("restored_and_rewritten") == baseline + size);
  assert(vm_deallocate(mach_task_self(), address, size) == KERN_SUCCESS);
  assert(sample("released") == baseline);
  std::cout << "Resident nonvolatile ledger 0/16/0/16/0 MiB response verified; no global purge or pressure\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  const auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 4096 && !reading.purgeableNonvolatile.bytes && !reading.purgeableNonvolatile.rawBytes);
  std::cout << "Android counters preserved; no synthetic iOS purgeable field\n";
#endif
}
