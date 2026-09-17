#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
#ifdef __APPLE__
  task_vm_info_data_t fixture{};
  fixture.compressed = 123456; fixture.decompressions = 17;
  const auto valid = bench::decompressionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV5_COUNT, fixture);
  assert(valid.count == 17 && valid.rawCount == 17 && !valid.saturated && valid.error.empty());
  fixture.decompressions = 0;
  assert(bench::decompressionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV5_COUNT, fixture).count == 0);
  fixture.decompressions = INT32_MAX;
  const auto capped = bench::decompressionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV5_COUNT, fixture);
  assert(capped.count == INT32_MAX && capped.rawCount == INT32_MAX && capped.saturated && capped.error.empty());
  fixture.decompressions = -1;
  const auto negative = bench::decompressionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV5_COUNT, fixture);
  assert(!negative.count && negative.rawCount == -1 && !negative.error.empty());
  const auto shortReply = bench::decompressionsFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV5_COUNT - 1, fixture);
  assert(!shortReply.count && !shortReply.rawCount && !shortReply.error.empty());
  const auto failed = bench::decompressionsFromTaskVmInfo(KERN_FAILURE, 0, fixture);
  assert(!failed.count && !failed.rawCount && !failed.error.empty());
  std::cout << "Mach field selection, zero, saturation, negative, short reply and failure checks passed\n";
  const auto direct = [] {
    task_vm_info_data_t info{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV5_COUNT && info.decompressions >= 0);
    return static_cast<uint32_t>(info.decompressions);
  };
  for (int i = 0; i < 3; ++i) {
    const auto before = direct(); const auto sample = bench::readResidentMemory(); const auto after = direct();
    assert(sample.decompressions.count && sample.decompressions.error.empty());
    assert(*sample.decompressions.count >= before && *sample.decompressions.count <= after);
    assert(sample.compressed.bytes && sample.physicalFootprint.bytes);
    std::cout << "Live sample " << i + 1 << ": before=" << before << ", collector=" << *sample.decompressions.count
      << ", after=" << after << " events\n";
  }
#else
  std::istringstream input("Rss: 8 kB\nPss: 8 kB\nPrivate_Clean: 4 kB\nPrivate_Dirty: 4 kB\nShared_Clean: 0 kB\nShared_Dirty: 0 kB\n");
  const auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 8192 && !reading.decompressions.count);
#endif
}
