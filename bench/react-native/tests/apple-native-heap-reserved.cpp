#include "../cpp/AppleNativeHeap.h"
#include <cassert>
#include <cstdio>
#include <unistd.h>
int main() {
  alarm(30); setvbuf(stdout, nullptr, _IONBF, 0);
  malloc_statistics_t fixture{};
  fixture.size_in_use = 17; fixture.size_allocated = 999; fixture.max_size_in_use = 555;
  assert(bench::nativeHeapReservedFromMallocStatistics(fixture).bytes == 999);
  assert(bench::nativeHeapFromMallocStatistics(fixture).bytes == 17);
  fixture.size_allocated = 0; assert(bench::nativeHeapReservedFromMallocStatistics(fixture).bytes == 0);
  fixture.size_allocated = SIZE_MAX; assert(bench::nativeHeapReservedFromMallocStatistics(fixture).bytes == SIZE_MAX);
  constexpr size_t MiB = 1024 * 1024;
  auto near = [](uint64_t a, uint64_t b) { auto delta = int64_t(a) - int64_t(b); assert(delta >= -65536 && delta <= 65536); };
  malloc_zone_t *zone = nullptr;
  auto sample = [&](const char *label) {
    const auto result = bench::readAppleNativeHeap();
    malloc_statistics_t direct{}; malloc_zone_statistics(nullptr, &direct);
    assert(result.reserved.bytes && result.allocated.bytes && result.reserved.error.empty());
    assert(result.reserved.source == "malloc_zone_statistics(NULL).size_allocated");

    printf("%s reserved=%llu allocated=%llu direct_reserved=%zu\n", label,
      (unsigned long long)*result.reserved.bytes, (unsigned long long)*result.allocated.bytes, direct.size_allocated);
    near(*result.reserved.bytes, direct.size_allocated); near(*result.allocated.bytes, direct.size_in_use);
    malloc_statistics_t custom{};
    if (zone) malloc_zone_statistics(zone, &custom);
    printf("custom_reserved=%zu\n", custom.size_allocated);
    assert(*result.reserved.bytes >= custom.size_allocated);
    return custom.size_allocated;
  };
  sample("warmup"); const auto baseline = sample("baseline");
  zone = malloc_create_zone(0, 0); assert(zone);
  malloc_set_zone_name(zone, "Wfloat reserved heap diagnostic");
  const auto before = sample("custom_zone_created");
  auto *buffer = malloc_zone_malloc(zone, 32 * MiB); assert(buffer && malloc_zone_from_ptr(buffer) == zone);
  const auto created = sample("buffer_created");
  assert(created == before + 32 * MiB);
  for (size_t i = 0; i < 32 * MiB; i += 4096) static_cast<volatile unsigned char *>(buffer)[i] = 93;
  near(sample("buffer_touched"), created);
  malloc_zone_free(zone, buffer); buffer = nullptr;
  sample("buffer_freed"); // Caches may retain reservation; do not force global relief.
  malloc_statistics_t zoneStats{}; malloc_zone_statistics(zone, &zoneStats);
  const auto beforeDestroy = sample("before_zone_destroy");
  printf("custom_zone_remaining_reservation=%zu\n", zoneStats.size_allocated);
  malloc_destroy_zone(zone);
  zone = nullptr;
  const auto destroyed = sample("custom_zone_destroyed");
  assert(destroyed == 0 && baseline == 0);
  assert(beforeDestroy == zoneStats.size_allocated);
  // Direct mmap is outside malloc: use raw allocation-free queries around it
  // so source-label construction and printf cannot contaminate this check.
  malloc_statistics_t mapBefore{}, mapDuring{}, mapAfter{};
  malloc_zone_statistics(nullptr, &mapBefore);
  void *mapping = mmap(nullptr, 16 * MiB, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0); assert(mapping != MAP_FAILED);
  for (size_t i = 0; i < 16 * MiB; i += 4096) static_cast<volatile unsigned char *>(mapping)[i] = 94;
  malloc_zone_statistics(nullptr, &mapDuring);
  assert(munmap(mapping, 16 * MiB) == 0);
  malloc_zone_statistics(nullptr, &mapAfter);
  printf("direct_mmap raw_reserved before=%zu touched=%zu released=%zu\n", mapBefore.size_allocated, mapDuring.size_allocated, mapAfter.size_allocated);
  assert(mapBefore.size_allocated == mapDuring.size_allocated && mapDuring.size_allocated == mapAfter.size_allocated);
  puts("PASS reserved field, registered-zone aggregation, allocation/touch/free/destroy and direct mmap exclusion; 64 KiB comparison tolerance");
}
