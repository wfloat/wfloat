#import <Foundation/Foundation.h>
#include <malloc/malloc.h>
#include <mach/mach.h>
#include <dlfcn.h>
#include <cassert>
static malloc_zone_t testZone{};
static malloc_introspection_t testIntrospection{};
static vm_address_t testAddress=(vm_address_t)&testZone;
static unsigned attempts=0;
static kern_return_t testZones(task_t,memory_reader_t,vm_address_t **out,unsigned *count){*out=&testAddress;*count=1;return KERN_SUCCESS;}
static int testImage(const void *,Dl_info *image){image->dli_fname="/usr/lib/system/libsystem_malloc.dylib";return 1;}
#define malloc_get_all_zones testZones
#define dladdr testImage
#include "../WfloatBench/AllocatorZoneSources.h"
#undef malloc_get_all_zones
#undef dladdr
int main(){@autoreleasepool{
 testZone.version=14;testZone.introspect=&testIntrospection;testIntrospection.zone_type=1;
 testIntrospection.task_statistics=+[](task_t task,vm_address_t zone,memory_reader_t reader,malloc_statistics_t *){++attempts;void *out=nullptr;assert(reader(task,zone,4*1024*1024+1,&out)==KERN_RESOURCE_SHORTAGE);};
 NSDictionary *first=benchAllocator::capture();NSDictionary *second=benchAllocator::capture();assert(attempts==1);
 NSDictionary *a=first[@"zones"][0],*b=second[@"zones"][0];assert([a[@"statisticsReadCode"] intValue]==KERN_RESOURCE_SHORTAGE);assert(![a[@"statisticsAttemptCached"] boolValue]);assert([b[@"statisticsAttemptCached"] boolValue]);assert(b[@"statistics"]==NSNull.null);assert([b[@"cachedStatisticsAttempt"][@"statisticsAttemptUptimeMs"] isEqual:a[@"statisticsAttemptUptimeMs"]]);
 puts("PASS: copy-limit callback attempted once; subsequent metadata capture retains explicitly historical failure with original timestamp and null statistics");
}}
