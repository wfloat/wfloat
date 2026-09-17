#include "../cpp/AppleMallocCheck.h"
#include <mach/mach.h>
#include <cassert>
#include <cstdio>
#include <unistd.h>
unsigned zones() { vm_address_t *addresses=nullptr;unsigned count=0;assert(malloc_get_all_zones(mach_task_self(),nullptr,&addresses,&count)==KERN_SUCCESS);return count; }
int main(){
 alarm(30);setvbuf(stdout,nullptr,_IONBF,0);
 bench::MallocCheckResult result{};const auto beforeZones=zones();
 bench::runAppleMallocCheck(result,[]{return true;});assert(result.count==14);assert(zones()==beforeZones);
 for(unsigned i=0;i<result.count;++i){const auto &p=result.phases[i];printf("%s process_blocks=%u zone_blocks=%u zone_allocated=%zu zone_reserved=%zu held=%llu\n",p.stage,p.process.blocks_in_use,p.zone.blocks_in_use,p.zone.size_in_use,p.zone.size_allocated,(unsigned long long)p.heldBytes);}
 assert(result.phases[5].zone.blocks_in_use==0);assert(result.phases[6].zone.blocks_in_use==64);
 assert(result.phases[10].zone.size_allocated-result.phases[9].zone.size_allocated==32*1024*1024);
 assert(result.phases[11].zone.size_allocated==result.phases[10].zone.size_allocated);
 assert(result.phases[12].zone.size_allocated==result.phases[9].zone.size_allocated);
 assert(!result.phases[13].hasZone&&result.phases[13].heldBytes==0);
 printf("Reuse default=%u custom=%u\n",result.defaultReused,result.customReused);
 for(unsigned limit:{1u,40u,130u,200u,270u,300u,500u,8000u}){
  unsigned calls=0;bool interrupted=false;const auto count=zones();malloc_statistics_t before{},after{};malloc_zone_statistics(nullptr,&before);
  try{bench::runAppleMallocCheck(result,[&]{return ++calls<limit;});}catch(const std::runtime_error&){interrupted=true;}
  malloc_zone_statistics(nullptr,&after);assert(interrupted);assert(zones()==count);
  assert(after.size_in_use<=before.size_in_use+65536);
  printf("cancel check=%u phases=%u no_new_zones=1 retained_byte_delta=%lld\n",limit,result.count,(long long)after.size_in_use-(long long)before.size_in_use);
 }
 puts("PASS complete phases, isolated reservation response, cancellation at eight points, zone cleanup and bounded retained byte accounting");
}
