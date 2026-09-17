#pragma once
#include "ResidentMemory.h"
#ifdef __APPLE__
#include <malloc/malloc.h>
namespace bench {
inline MemoryCounter nativeHeapFromMallocStatistics(const malloc_statistics_t &stats) {
  return {static_cast<uint64_t>(stats.size_in_use),
    "malloc_zone_statistics(NULL).size_in_use", ""};
}
inline MemoryCounter nativeHeapReservedFromMallocStatistics(const malloc_statistics_t &stats) {
  return {static_cast<uint64_t>(stats.size_allocated),
    "malloc_zone_statistics(NULL).size_allocated", ""};
}
static_assert(sizeof(decltype(malloc_statistics_t{}.blocks_in_use)) == 4, "Expected Apple's 32-bit unsigned block count");
inline unsigned nativeHeapBlocksFromMallocStatistics(const malloc_statistics_t &stats) { return stats.blocks_in_use; }
struct AppleNativeHeapSnapshot { MemoryCounter allocated; MemoryCounter reserved; unsigned blocksInUse = 0; };
inline AppleNativeHeapSnapshot readAppleNativeHeap() {
  // Construct source strings before measuring: their allocations can themselves
  // expand a malloc zone's reservation. Keep all fields from one OS snapshot.
  malloc_statistics_t stats{};
  AppleNativeHeapSnapshot result{nativeHeapFromMallocStatistics(stats), nativeHeapReservedFromMallocStatistics(stats)};
  // Public API: NULL aggregates registered zones. There is no status return.
  malloc_zone_statistics(nullptr, &stats);
  result.allocated.bytes = static_cast<uint64_t>(stats.size_in_use);
  result.reserved.bytes = static_cast<uint64_t>(stats.size_allocated);
  result.blocksInUse = nativeHeapBlocksFromMallocStatistics(stats);
  return result;
}
inline MemoryCounter readAppleNativeHeapAllocated() {
  return readAppleNativeHeap().allocated;
}
}
#endif
