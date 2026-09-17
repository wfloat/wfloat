#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>

int main() {
  std::cout << std::unitbuf;
#ifdef __APPLE__
  alarm(30);
  task_vm_info_data_t fixture{};
  fixture.external = 16777216;
  fixture.external_peak = 33554432;
  fixture.compressed = 67108864;
  const auto parsed = bench::externalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture);
  assert(parsed.bytes == 16777216 && parsed.error.empty());
  assert(parsed.source == "task_info(TASK_VM_INFO).external");
  fixture.external = 0;
  assert(bench::externalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == 0);
  fixture.external = UINT64_MAX;
  assert(bench::externalFromTaskVmInfo(KERN_SUCCESS, TASK_VM_INFO_REV0_COUNT, fixture).bytes == UINT64_MAX);
  for (const auto status : {KERN_SUCCESS, KERN_FAILURE}) {
    const auto value = bench::externalFromTaskVmInfo(status, TASK_VM_INFO_REV0_COUNT - 1, fixture);
    assert(!value.bytes && !value.error.empty());
  }
  assert(!bench::externalFromTaskVmInfo(KERN_FAILURE, TASK_VM_INFO_COUNT, fixture).bytes);
  std::cout << "Mach response revision, failure, exact raw range, zero and field-selection checks passed\n";
  struct Reading { uint64_t external, internal; };
  const auto near = [](uint64_t actual, uint64_t expected, int64_t tolerance = 262144) {
    const auto delta = static_cast<int64_t>(actual) - static_cast<int64_t>(expected);
    assert(delta >= -tolerance && delta <= tolerance);
  };
  const auto sample = [&](const char* phase) {
    const auto r = bench::readResidentMemory();
    task_vm_info_data_t direct{};mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    assert(task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&direct), &count) == KERN_SUCCESS);
    assert(count >= TASK_VM_INFO_REV0_COUNT && r.external.bytes && r.internal.bytes && r.reusable.bytes && r.compressed.bytes);
    assert(r.external.error.empty() && r.physicalFootprint.bytes);
    near(*r.external.bytes, direct.external, 65536);
    std::cout << phase << " external=" << *r.external.bytes << " direct=" << direct.external
      << " internal=" << *r.internal.bytes << " reusable=" << *r.reusable.bytes
      << " compressed=" << *r.compressed.bytes << " RSS=" << r.bytes
      << " footprint=" << *r.physicalFootprint.bytes << "\n";
    return Reading{*r.external.bytes, *r.internal.bytes};
  };
  constexpr size_t size = 16 * 1024 * 1024;
  const long page = sysconf(_SC_PAGESIZE);assert(page > 0 && size % page == 0);
  char name[] = "/tmp/wfloat-external-XXXXXX";
  const int fd = mkstemp(name);assert(fd >= 0);assert(unlink(name) == 0);
  std::array<unsigned char, 65536> block{};block.fill(71);
  for(size_t offset = 0; offset < size;) {
    const auto written = write(fd, block.data(), block.size());assert(written > 0);offset += written;
  }
  sample("warmup");const auto baseline = sample("baseline");
  void* first = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);assert(first != MAP_FAILED);
  near(sample("mapped_untouched").external, baseline.external);
  auto bytes = static_cast<volatile unsigned char*>(first);
  for(size_t offset = 0; offset < size; offset += page) assert(bytes[offset] == 71);
  const auto one = sample("one_read_mapping");near(one.external, baseline.external + size);
  void* second = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);assert(second != MAP_FAILED);
  auto alias = static_cast<volatile const unsigned char*>(second);
  for(size_t offset = 0; offset < size; offset += page) assert(alias[offset] == 71);
  const auto two = sample("two_read_mappings");near(two.external, one.external + size);
  // Private writes fault in anonymous copies; the file and read-only alias survive.
  for(size_t offset = 0; offset < size / 2; offset += page) bytes[offset] = 93;
  const auto cow = sample("half_private_copy");near(cow.external + size / 2, two.external);near(cow.internal, two.internal + size / 2);
  for(size_t offset = 0; offset < size; offset += page) {
    assert(alias[offset] == 71);assert(bytes[offset] == (offset < size / 2 ? 93 : 71));
    unsigned char original = 0;assert(pread(fd, &original, 1, offset) == 1 && original == 71);
  }
  assert(munmap(second, size) == 0);near(sample("alias_released").external + size, cow.external);
  assert(munmap(first, size) == 0);const auto released = sample("all_released");near(released.external, baseline.external);near(released.internal, baseline.internal);
  assert(close(fd) == 0);
  std::cout << "File and alias integrity verified; mapping-based 0/16/32/24/8/0 MiB external response verified; private-copy internal increase 8 MiB; 256 KiB bookkeeping tolerance; temporary file released\n";
#else
  std::istringstream input("Rss: 8 kB\nPss: 4 kB\nKSM: 0 kB\nLocked: 0 kB\n");
  auto reading = bench::memoryFromSmaps(input, true);
  assert(reading.bytes == 8192 && reading.pss.bytes == 4096 && !reading.external.bytes);
  std::cout << "Android counters preserved; no synthetic iOS external field\n";
#endif
}
