#include "../cpp/AppleNativeHeap.h"
#include <cassert>
#include <climits>
#include <cstdio>
#include <unistd.h>
int main() {
  alarm(30);setvbuf(stdout,nullptr,_IONBF,0);
  malloc_statistics_t fixture{};fixture.size_in_use=999;fixture.size_allocated=555;
  for(unsigned value:{0u,17u,UINT_MAX}){fixture.blocks_in_use=value;assert(bench::nativeHeapBlocksFromMallocStatistics(fixture)==value);}
  malloc_zone_t *zone=nullptr;
  auto sample=[&](const char *phase){
    const auto collected=bench::readAppleNativeHeap();
    malloc_statistics_t direct{},custom{};malloc_zone_statistics(nullptr,&direct);
    if(zone)malloc_zone_statistics(zone,&custom);
    assert(collected.blocksInUse==direct.blocks_in_use);
    assert(collected.blocksInUse>=custom.blocks_in_use);
    printf("%s collected=%u direct=%u custom=%u custom_bytes=%zu\n",phase,collected.blocksInUse,direct.blocks_in_use,custom.blocks_in_use,custom.size_in_use);
    return custom.blocks_in_use;
  };
  sample("warmup");zone=malloc_create_zone(0,0);assert(zone);malloc_set_zone_name(zone,"Wfloat heap block diagnostic");
  const auto baseline=sample("baseline");assert(baseline==0);
  void *small[64]{},*large[8]{};
  uintptr_t originalSmall[64]{};
  unsigned smallIndex=0;
  for(auto &p:small){p=malloc_zone_malloc(zone,4096);originalSmall[smallIndex++]=reinterpret_cast<uintptr_t>(p);assert(p&&malloc_zone_from_ptr(p)==zone);static_cast<volatile unsigned char*>(p)[0]=93;}
  assert(sample("64_small_created")==64);
  for(auto &p:large){p=malloc_zone_malloc(zone,1024*1024);assert(p&&malloc_zone_from_ptr(p)==zone);static_cast<volatile unsigned char*>(p)[0]=94;}
  assert(sample("plus_8_large_created")==72);
  for(int i=0;i<32;++i){malloc_zone_free(zone,small[i]);small[i]=nullptr;}
  const auto half=sample("32_small_freed");assert(half>=40&&half<=72);
  for(auto &p:small)if(p){malloc_zone_free(zone,p);p=nullptr;}
  const auto smallFreed=sample("all_small_freed");assert(smallFreed>=8&&smallFreed<=half);
  for(auto &p:large){malloc_zone_free(zone,p);p=nullptr;}
  const auto reportedAfterFree=sample("all_client_blocks_freed");assert(reportedAfterFree<=smallFreed);
  // Observe retained or inflated accounting without treating it as a live-object count.
  void *again=malloc_zone_malloc(zone,1024*1024);assert(again);static_cast<volatile unsigned char*>(again)[0]=95;
  sample("one_large_reallocated");malloc_zone_free(zone,again);sample("reallocation_freed");
  unsigned reusedAddresses=0;
  for(auto &p:small){p=malloc_zone_malloc(zone,4096);assert(p);static_cast<volatile unsigned char*>(p)[0]=97;
    for(auto old:originalSmall)if(reinterpret_cast<uintptr_t>(p)==old){++reusedAddresses;break;}}
  sample("64_small_reallocated");
  for(auto &p:small){malloc_zone_free(zone,p);p=nullptr;}
  const auto afterReuse=sample("all_reallocated_small_freed");
  printf("Repeated small allocations reused %u of 64 original addresses; reported count after all frees=%u\n",reusedAddresses,afterReuse);
  malloc_destroy_zone(zone);zone=nullptr;sample("custom_zone_destroyed");
  malloc_statistics_t before{},during{},after{};malloc_zone_statistics(nullptr,&before);
  auto *mapping=mmap(nullptr,16*1024*1024,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(mapping!=MAP_FAILED);
  for(size_t i=0;i<16*1024*1024;i+=4096)static_cast<volatile unsigned char*>(mapping)[i]=96;
  malloc_zone_statistics(nullptr,&during);assert(munmap(mapping,16*1024*1024)==0);malloc_zone_statistics(nullptr,&after);
  assert(before.blocks_in_use==during.blocks_in_use&&during.blocks_in_use==after.blocks_in_use);
  printf("mmap excluded: %u -> %u -> %u blocks; custom reported after all frees=%u\n",before.blocks_in_use,during.blocks_in_use,after.blocks_in_use,reportedAfterFree);
  puts("PASS unsigned field, exact collector/direct comparisons, known-size block count, frees/cache observation and mmap exclusion");
}
