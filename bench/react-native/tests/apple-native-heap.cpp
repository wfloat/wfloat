#include "../cpp/AppleNativeHeap.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif

int main() {
#ifdef __APPLE__
  alarm(30);
  setvbuf(stdout, nullptr, _IONBF, 0);
  malloc_statistics_t fixture{};
  fixture.size_in_use = 17; fixture.size_allocated = 999; fixture.max_size_in_use = 555;
  assert(bench::nativeHeapFromMallocStatistics(fixture).bytes == 17);
  fixture.size_in_use = 0; assert(bench::nativeHeapFromMallocStatistics(fixture).bytes == 0);
  fixture.size_in_use = SIZE_MAX; assert(bench::nativeHeapFromMallocStatistics(fixture).bytes == SIZE_MAX);
  constexpr size_t MiB = 1024 * 1024;
  auto *zone = malloc_create_zone(0, 0); assert(zone);
  malloc_set_zone_name(zone, "Wfloat bounded native heap test");
  void* ordinary[8]{}; void* custom[8]{};
  const auto near = [](uint64_t a, uint64_t b, int64_t tolerance = 262144) {
    auto d = static_cast<int64_t>(a) - static_cast<int64_t>(b);
    assert(d >= -tolerance && d <= tolerance);
  };
  const auto sample = [&](const char* label) {
    auto counter = bench::readAppleNativeHeapAllocated();
    assert(counter.bytes && counter.error.empty());
    assert(counter.source == "malloc_zone_statistics(NULL).size_in_use");
    malloc_statistics_t direct{}, customStats{}, defaultStats{};
    malloc_zone_statistics(nullptr, &direct);
    if (zone) malloc_zone_statistics(zone, &customStats);
    malloc_zone_statistics(malloc_default_zone(), &defaultStats);
    near(*counter.bytes, direct.size_in_use, 65536);
    printf("%s bytes=%llu direct=%zu custom=%zu default=%zu\n", label,
      (unsigned long long)*counter.bytes, direct.size_in_use, customStats.size_in_use, defaultStats.size_in_use);
    return *counter.bytes;
  };
  sample("warmup"); auto baseline = sample("baseline");
  for (auto &p : ordinary) { p = malloc(MiB); assert(p);
    for (size_t n=0; n<MiB; n+=4096) static_cast<volatile unsigned char*>(p)[n] = 0x5a; }
  near(sample("ordinary_8MiB"), baseline + 8*MiB);
  for (auto &p : custom) {
    p = malloc_zone_malloc(zone, MiB); assert(p && malloc_zone_from_ptr(p) == zone);
    memset(p, 0x6b, MiB);
  }
  near(sample("ordinary_plus_custom_16MiB"), baseline + 16*MiB);
  uintptr_t previous[8]{};
  for (int i=0; i<8; ++i) previous[i] = reinterpret_cast<uintptr_t>(custom[i]);
  for (auto &p : custom) { malloc_zone_free(zone, p); p = nullptr; }
  auto afterCustom = sample("custom_freed");
  malloc_statistics_t customAfter{}; malloc_zone_statistics(zone, &customAfter);
  // Cached frees may remain in zone accounting. Verify their removal by
  // destroying only this diagnostic zone, without changing allocator settings.
  const size_t retained = customAfter.size_in_use;
  assert(retained <= 8*MiB && retained % MiB == 0);
  near(afterCustom, baseline + 8*MiB + retained);
  if (retained) {
    void* reused = malloc_zone_malloc(zone, MiB); assert(reused);
    bool known = false;
    for (auto address : previous) if (reinterpret_cast<uintptr_t>(reused) == address) known = true;
    auto duringReuse = sample("after_free_reallocation");
    printf("Reallocated a previously freed block: %s; change=%lld\n", known ? "yes" : "no",
      (long long)duringReuse - (long long)afterCustom);
    malloc_zone_free(zone, reused);
  }
  malloc_destroy_zone(zone); zone = nullptr;
  near(sample("custom_zone_destroyed"), baseline + 8*MiB);
  for (auto &p : ordinary) { free(p); p = nullptr; }
  const auto afterFree = sample("all_freed");
#if TARGET_OS_SIMULATOR
  near(afterFree, baseline);
#else
  // The process default allocator can retain medium cached frees too. Record
  // this accounting; do not purge global caches to manufacture a zero result.
  assert(afterFree + 65536 >= baseline && afterFree <= baseline + 8*MiB + 65536);
#endif
  void* mapped = mmap(nullptr, 16*MiB, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
  assert(mapped != MAP_FAILED);
  // Volatile touches cannot be removed by optimization.
  for (size_t n=0; n<16*MiB; n+=4096) static_cast<volatile unsigned char*>(mapped)[n] = 93;
  near(sample("direct_mmap_16MiB"), afterFree);
  assert(munmap(mapped, 16*MiB) == 0);
  near(sample("unmapped"), afterFree);
  puts("PASS current field/zero/raw-range; registered custom zone included; malloc/free/direct mmap response; 256 KiB transition tolerance");
#else
  puts("Apple allocator collector excluded on non-Apple platforms");
#endif
}
