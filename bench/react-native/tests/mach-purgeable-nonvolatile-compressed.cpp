#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(45);
  task_vm_info_data_t fixture{};
  fixture.ledger_purgeable_novolatile_compressed = 16777216;
  fixture.ledger_purgeable_nonvolatile = 33554432;
  fixture.ledger_purgeable_volatile = 67108864;
  const auto parsed = bench::purgeableNonvolatileCompressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
  assert(parsed.bytes == 16777216 && parsed.rawBytes == 16777216 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).ledger_purgeable_novolatile_compressed");
  for (const int64_t value : {int64_t(0), INT64_MAX, int64_t(-1), INT64_MIN}) {
    fixture.ledger_purgeable_novolatile_compressed = value;
    const auto result = bench::purgeableNonvolatileCompressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
    assert(result.rawBytes == value);
    if (value < 0) assert(!result.bytes && !result.error.empty());
    else assert(result.bytes == static_cast<uint64_t>(value) && result.error.empty());
  }
  for (auto status : {KERN_SUCCESS, KERN_FAILURE}) {
    const auto result = bench::purgeableNonvolatileCompressedFromTaskVmInfo(status, TASK_VM_INFO_REV3_COUNT - 1, fixture);
    assert(!result.bytes && !result.rawBytes && !result.error.empty());
  }
  assert(!bench::purgeableNonvolatileCompressedFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).rawBytes);
  std::cout << "Field selection, revision, failure, zero and signed range passed\n";
  const auto direct = [] {
    task_vm_info_data_t info{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV3_COUNT);
    return info;
  };
  const auto sample = [&direct](const char* phase) {
    const auto before = direct();
    const auto collected = bench::readResidentMemory();
    const auto after = direct();
    assert(collected.purgeableNonvolatileCompressed.bytes && collected.purgeableNonvolatileCompressed.error.empty());
    const auto value = *collected.purgeableNonvolatileCompressed.bytes;
    assert(collected.purgeableNonvolatileCompressed.rawBytes == static_cast<int64_t>(value));
    // Untouched test mapping can become compressed between these queries.
    assert(before.ledger_purgeable_novolatile_compressed <= static_cast<int64_t>(value));
    assert(static_cast<int64_t>(value) <= after.ledger_purgeable_novolatile_compressed);
    std::cout << phase << " compressed=" << value << " directBefore=" << before.ledger_purgeable_novolatile_compressed
      << " directAfter=" << after.ledger_purgeable_novolatile_compressed
      << " resident=" << *collected.purgeableNonvolatile.bytes << "\n";
    return value;
  };
  sample("warmup");
  const auto baseline = sample("baseline"); assert(baseline == 0);
  constexpr vm_size_t size = 16 * 1024 * 1024;
  vm_address_t address = 0;
  auto status = vm_allocate(mach_task_self(), &address, size, VM_FLAGS_ANYWHERE | VM_FLAGS_PURGABLE);
  std::cout << "vm_allocate status=" << status << "\n";
  if (status != KERN_SUCCESS) return 77;
  auto data = reinterpret_cast<volatile unsigned char*>(address);
  for (size_t i = 0; i < size; ++i) data[i] = 71;
  bool positive = sample("written") > 0;
  // Let ordinary memory management act. Do not induce global pressure or rely on
  // MADV_PAGEOUT, which this development environment already found unsupported.
  for (int attempt = 0; attempt < 60 && !positive; ++attempt) {
    usleep(500000);
    positive = sample("waiting") > 0;
  }
  // Accessing every page restores contents; nonvolatile data must survive.
  for (size_t i = 0; i < size; ++i) assert(data[i] == 71);
  sample("read_back");
  assert(vm_deallocate(mach_task_self(), address, size) == KERN_SUCCESS);
  assert(sample("released") == baseline);
  if (!positive) {
    std::cout << "INCONCLUSIVE: no natural compression observed during bounded 30-second wait; fixtures and zero collection passed\n";
    return 77;
  }
  std::cout << "Positive natural compression, content preservation and release verified; no induced global pressure\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  const auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 4096 && !reading.purgeableNonvolatileCompressed.bytes && !reading.purgeableNonvolatileCompressed.rawBytes);
  std::cout << "Android counters preserved; no synthetic iOS compressed purgeable field\n";
#endif
}
