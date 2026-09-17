#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(30);
  task_vm_info_data_t fixture{};
  fixture.ledger_tag_graphics_footprint = 16777216;
  fixture.ledger_tag_graphics_footprint_compressed = 33554432;
  fixture.ledger_tag_graphics_nofootprint = 67108864;
  const auto parsed = bench::graphicsFootprintFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
  assert(parsed.bytes == 16777216 && parsed.rawBytes == 16777216 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).ledger_tag_graphics_footprint");
  for (const int64_t value : {int64_t(0), INT64_MAX, int64_t(-1), INT64_MIN}) {
    fixture.ledger_tag_graphics_footprint = value;
    const auto result = bench::graphicsFootprintFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
    assert(result.rawBytes == value);
    if (value < 0) assert(!result.bytes && !result.error.empty());
    else assert(result.bytes == static_cast<uint64_t>(value) && result.error.empty());
  }
  for (auto status : {KERN_SUCCESS, KERN_FAILURE}) {
    const auto result = bench::graphicsFootprintFromTaskVmInfo(status, TASK_VM_INFO_REV3_COUNT - 1, fixture);
    assert(!result.bytes && !result.rawBytes && !result.error.empty());
  }
  assert(!bench::graphicsFootprintFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).rawBytes);
  std::cout << "Field selection, revision, failure, zero and signed range passed\n";
  const auto sample = [](const char* phase) {
    const auto collected = bench::readResidentMemory();
    task_vm_info_data_t direct{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV3_COUNT);
    assert(collected.graphicsFootprint.bytes && collected.graphicsFootprint.error.empty());
    assert(collected.graphicsFootprint.rawBytes == direct.ledger_tag_graphics_footprint);
    assert(*collected.graphicsFootprint.bytes == static_cast<uint64_t>(direct.ledger_tag_graphics_footprint));
    assert(collected.physicalFootprint.bytes && collected.reusable.bytes && collected.peakReusable.bytes);
    std::cout << phase << " graphics=" << *collected.graphicsFootprint.bytes
      << " direct=" << direct.ledger_tag_graphics_footprint
      << " compressedDiagnostic=" << direct.ledger_tag_graphics_footprint_compressed
      << " nofootprintDiagnostic=" << direct.ledger_tag_graphics_nofootprint << "\n";
    return *collected.graphicsFootprint.bytes;
  };
  sample("warmup");
  const auto baseline = sample("baseline");
  (void)baseline;
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  const auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 4096 && !reading.graphicsFootprint.bytes && !reading.graphicsFootprint.rawBytes);
  std::cout << "Android counters preserved; no synthetic iOS graphics field\n";
#endif
}
