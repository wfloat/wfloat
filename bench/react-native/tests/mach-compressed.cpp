#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
#ifdef __APPLE__
  task_vm_info_data_t fixture{};
  fixture.compressed = 67108864;
  fixture.compressed_peak = 134217728;
  fixture.compressed_lifetime = 268435456;
  const auto valid = bench::compressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture);
  assert(valid.bytes == 67108864 && valid.error.empty());
  assert(valid.source == "task_info(TASK_VM_INFO).compressed");
  fixture.compressed = 0;
  assert(bench::compressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == 0);
  fixture.compressed = UINT64_MAX;
  assert(bench::compressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == UINT64_MAX);
  const auto shortReply = bench::compressedFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT - 1, fixture);
  assert(!shortReply.bytes && !shortReply.error.empty());
  const auto failed = bench::compressedFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture);
  assert(!failed.bytes && !failed.error.empty());
  const auto noReply = bench::compressedFromTaskVmInfo(KERN_FAILURE, 0, fixture);
  assert(!noReply.bytes && !noReply.error.empty());
  std::cout << "Mach response revision, failure, exact raw range, zero and field-selection checks passed\n";
  for (int i = 0; i < 3; ++i) {
    task_vm_info_data_t direct{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    const auto status = task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count);
    assert(status == KERN_SUCCESS && count >= TASK_VM_INFO_REV0_COUNT);
    const auto collected = bench::readResidentMemory();
    assert(collected.compressed.bytes && collected.compressed.error.empty());
    assert(collected.physicalFootprint.bytes && collected.peakRss.bytes);
    std::cout << "Live sample " << i + 1 << ": direct compressed=" << direct.compressed
      << " bytes, collector compressed=" << *collected.compressed.bytes
      << " bytes, RSS=" << collected.bytes << " bytes, footprint=" << *collected.physicalFootprint.bytes << " bytes\n";
  }
#else
  std::istringstream source("Rss: 8 kB\nPss: 8 kB\nPrivate_Clean: 4 kB\nPrivate_Dirty: 4 kB\nShared_Clean: 0 kB\nShared_Dirty: 0 kB\n");
  const auto reading = bench::memoryFromSmaps(source, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 8192 && !reading.compressed.bytes);
  std::cout << "Android memory fields retain independent values; no synthetic compressed counter\n";
#endif
}
