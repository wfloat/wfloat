#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

#ifdef __APPLE__
static bench::ResidentMemory read(const char *phase) {
  const auto value = bench::readResidentMemory();
  assert(value.peakPhysicalFootprint.bytes && value.physicalFootprint.bytes);
  assert(value.peakPhysicalFootprint.error.empty());
  assert(*value.peakPhysicalFootprint.rawBytes >= 0);
  assert(*value.peakPhysicalFootprint.bytes >= *value.physicalFootprint.bytes);
  std::cout << phase << " footprint=" << *value.physicalFootprint.bytes
    << " peak=" << *value.peakPhysicalFootprint.bytes << " RSS=" << value.bytes << " bytes\n";
  return value;
}

static void touchAndRelease(size_t size) {
  const long page = sysconf(_SC_PAGESIZE);
  assert(page > 0 && size % page == 0);
  void *mapping = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  assert(mapping != MAP_FAILED);
  auto *bytes = static_cast<volatile unsigned char *>(mapping);
  for (size_t i = 0; i < size; i += page) bytes[i] = static_cast<unsigned char>((i / page) % 251 + 1);
  for (size_t i = 0; i < size; i += page) assert(bytes[i] == static_cast<unsigned char>((i / page) % 251 + 1));
  // Deliberately no collector or direct Mach query while this mapping exists.
  assert(munmap(mapping, size) == 0);
}
#endif

int main() {
#ifdef __APPLE__
  task_vm_info_data_t fixture{};
  fixture.phys_footprint = 4096;
  fixture.resident_size_peak = 8192;
  fixture.ledger_phys_footprint_peak = 16384;
  const auto valid = bench::peakFootprintFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV3_COUNT, fixture);
  assert(valid.bytes == 16384 && valid.rawBytes == 16384 && valid.error.empty());
  assert(valid.source == "task_info(TASK_VM_INFO).ledger_phys_footprint_peak");
  for (int64_t value : {int64_t(0), int64_t(9007199254740992LL), INT64_MAX}) {
    fixture.ledger_phys_footprint_peak = value;
    const auto result = bench::peakFootprintFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_COUNT, fixture);
    assert(result.bytes == static_cast<uint64_t>(value) && result.rawBytes == value && result.error.empty());
  }
  for (int64_t value : {int64_t(-1), INT64_MIN}) {
    fixture.ledger_phys_footprint_peak = value;
    const auto result = bench::peakFootprintFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_COUNT, fixture);
    assert(!result.bytes && result.rawBytes == value && !result.error.empty());
  }
  for (auto count : {mach_msg_type_number_t(0), TASK_VM_INFO_REV3_COUNT - 1}) {
    const auto result = bench::peakFootprintFromTaskVmInfo(KERN_SUCCESS, count, fixture);
    assert(!result.bytes && !result.rawBytes && !result.error.empty());
  }
  const auto failed = bench::peakFootprintFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture);
  assert(!failed.bytes && !failed.rawBytes && !failed.error.empty());
  std::cout << "Field selection, revision guards, Mach failure, zero and signed raw range passed\n";
  read("warmup");
  const auto before = read("before");
  constexpr uint64_t size = 128ULL * 1024 * 1024;
  constexpr uint64_t tolerance = 2ULL * 1024 * 1024;
  touchAndRelease(size);
  const auto released = read("after_unobserved_allocation");
  assert(*released.peakPhysicalFootprint.bytes >= *before.physicalFootprint.bytes + size - tolerance);
  assert(*released.peakPhysicalFootprint.bytes > *before.peakPhysicalFootprint.bytes);
  assert(*released.physicalFootprint.bytes <= *before.physicalFootprint.bytes + tolerance);
  touchAndRelease(size / 2);
  const auto smaller = read("after_smaller_allocation");
  assert(smaller.peakPhysicalFootprint.bytes == released.peakPhysicalFootprint.bytes);
  assert(*smaller.physicalFootprint.bytes <= *before.physicalFootprint.bytes + tolerance);
  task_vm_info_data_t direct{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count) == KERN_SUCCESS);
  assert(count >= TASK_VM_INFO_REV3_COUNT);
  assert(static_cast<uint64_t>(direct.ledger_phys_footprint_peak) == *smaller.peakPhysicalFootprint.bytes);
  std::cout << "OS retained an unobserved 128 MiB dirty allocation peak; current footprint recovered; smaller allocation did not lower peak; direct Mach agrees\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\n");
  const auto value = bench::memoryFromSmaps(input, true);
  assert(value.bytes == 8192 && value.pss.bytes == 4096 && !value.peakPhysicalFootprint.bytes);
  std::cout << "Android RSS/PSS intact; no synthetic physical-footprint peak\n";
#endif
}
