#pragma once
#include <malloc/malloc.h>
#include <array>
#include <cstdint>
#include <stdexcept>
#include <utility>
namespace bench {
struct MallocCheckPhase {
  const char *stage = "idle";
  malloc_statistics_t process{};
  malloc_statistics_t zone{};
  bool hasZone = false;
  unsigned heldBlocks = 0;
  uint64_t heldBytes = 0;
};
struct MallocCheckResult {
  std::array<MallocCheckPhase,14> phases{};
  unsigned count = 0;
  unsigned defaultReused = 0;
  unsigned customReused = 0;
};
// RAII owns every allocation, including partial setup and interruption paths.
class MallocCheckStorage {
public:
  malloc_zone_t *zone = nullptr;
  std::array<void *,64> small{};
  void *large = nullptr;
  MallocCheckStorage() = default;
  MallocCheckStorage(const MallocCheckStorage&) = delete;
  ~MallocCheckStorage() { release(); if(zone) malloc_destroy_zone(zone); }
  void freeSmall() noexcept { for(auto &p:small) if(p) { if(zone) malloc_zone_free(zone,p); else free(p); p=nullptr; } }
  void release() noexcept { freeSmall(); if(large) { malloc_zone_free(zone,large);large=nullptr; } }
};
// No strings, result vectors or logging are allocated between phase captures.
// Process readings may still include concurrent app activity. The private zone
// isolates the test allocations from that activity; it is destroyed on exit.
template<class IsActive>
void runAppleMallocCheck(MallocCheckResult &out, IsActive &&active) {
  out = {};
  MallocCheckStorage storage;
  auto check = [&] { if(!active()) throw std::runtime_error("Malloc check interrupted"); };
  auto capture = [&](const char *stage, unsigned blocks, uint64_t bytes) {
    check();
    auto &row=out.phases.at(out.count++);
    row.stage=stage;row.heldBlocks=blocks;row.heldBytes=bytes;row.hasZone=storage.zone!=nullptr;
    malloc_zone_statistics(nullptr,&row.process);
    if(storage.zone) malloc_zone_statistics(storage.zone,&row.zone);
  };
  std::array<uintptr_t,64> prior{};
  auto allocateSmall = [&](bool reuse) {
    unsigned reused=0;
    for(size_t i=0;i<storage.small.size();++i) {
      check();auto &p=storage.small[i];
      p=storage.zone ? malloc_zone_malloc(storage.zone,4096) : malloc(4096);
      if(!p) throw std::runtime_error("Malloc check allocation failed");
      static_cast<volatile unsigned char *>(p)[0]=93;
      if(reuse) { for(auto address:prior) if(reinterpret_cast<uintptr_t>(p)==address){++reused;break;} }
      else prior[i]=reinterpret_cast<uintptr_t>(p);
    }
    return reused;
  };
  capture("default_baseline",0,0);
  allocateSmall(false);capture("default_created",64,262144);
  storage.freeSmall();capture("default_freed",0,0);
  out.defaultReused=allocateSmall(true);capture("default_recreated",64,262144);
  storage.freeSmall();capture("default_freed_again",0,0);
  check();storage.zone=malloc_create_zone(0,0);
  if(!storage.zone) throw std::runtime_error("Malloc check zone creation failed");
  capture("zone_baseline",0,0);
  allocateSmall(false);capture("zone_created",64,262144);
  storage.freeSmall();capture("zone_freed",0,0);
  out.customReused=allocateSmall(true);capture("zone_recreated",64,262144);
  storage.freeSmall();capture("zone_freed_again",0,0);
  check();storage.large=malloc_zone_malloc(storage.zone,32*1024*1024);
  if(!storage.large) throw std::runtime_error("Malloc check large allocation failed");
  capture("large_created",1,32*1024*1024);
  for(size_t i=0;i<32*1024*1024;i+=4096){check();static_cast<volatile unsigned char *>(storage.large)[i]=94;}
  capture("large_touched",1,32*1024*1024);
  storage.release();capture("large_freed",0,0);
  malloc_destroy_zone(storage.zone);storage.zone=nullptr;
  capture("zone_destroyed",0,0);
}
}
