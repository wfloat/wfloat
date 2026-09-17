#pragma once
#import <Foundation/Foundation.h>
#include <malloc/malloc.h>
#include <mach/mach.h>
#include <dlfcn.h>
#include <cstring>
// Snapshot allocator metadata through Mach reads. Never call an arbitrary/custom
// zone callback or dereference a zone that might have been concurrently destroyed.
namespace benchAllocator {
struct Reads {vm_address_t address[512]{};vm_size_t size[512]{};size_t count=0,bytes=0,lastRequestedBytes=0;kern_return_t error=KERN_SUCCESS;
  ~Reads(){for(size_t i=0;i<count;++i)vm_deallocate(mach_task_self(),address[i],size[i]);}};
static thread_local Reads *active=nullptr;
static kern_return_t reader(task_t task,vm_address_t address,vm_size_t size,void **out){
  if(!active||task!=mach_task_self())return KERN_INVALID_ARGUMENT;
  active->lastRequestedBytes=size;
  if(size>4*1024*1024||active->bytes+size>32*1024*1024||active->count==512){active->error=KERN_RESOURCE_SHORTAGE;return active->error;}
  vm_address_t copy=0;kern_return_t code=vm_allocate(mach_task_self(),&copy,size?:1,VM_FLAGS_ANYWHERE);if(code){active->error=code;return code;}
  vm_size_t read=0;code=vm_read_overwrite(task,address,size,copy,&read);
  if(code||read!=size){vm_deallocate(mach_task_self(),copy,size?:1);active->error=code?:KERN_INVALID_ADDRESS;return active->error;}
  active->address[active->count]=copy;active->size[active->count++]=size?:1;active->bytes+=size;*out=reinterpret_cast<void*>(copy);return KERN_SUCCESS;
}
static NSDictionary *capture(){
  static NSMutableDictionary *boundedAttempts=[NSMutableDictionary new];
  Reads listing;active=&listing;vm_address_t *addresses=nullptr;unsigned count=0;kern_return_t code=malloc_get_all_zones(mach_task_self(),reader,&addresses,&count);NSMutableArray *rows=[NSMutableArray new];
  if(!code)for(unsigned i=0;i<count&&i<256;++i){Reads reads;active=&reads;void *memory=nullptr;auto rc=reader(mach_task_self(),addresses[i],sizeof(malloc_zone_t),&memory);
    NSMutableDictionary *row=[@{@"index":@(i),@"zoneAddress":[NSString stringWithFormat:@"%llu",(unsigned long long)addresses[i]],@"metadataReadCode":@(rc)} mutableCopy];
    if(!rc){malloc_zone_t zone{};memcpy(&zone,memory,sizeof(zone));row[@"version"]=@(zone.version);Dl_info image{};bool builtin=zone.introspect&&dladdr(zone.introspect,&image)&&image.dli_fname&&strstr(image.dli_fname,"libsystem_malloc");
      row[@"trustedSystemIntrospection"]=@(builtin);
      unsigned type=builtin&&zone.version>=14?zone.introspect->zone_type:0;row[@"nativeZoneType"]=@(type);
      NSString *attemptKey=[NSString stringWithFormat:@"%llu:%u:%u",(unsigned long long)addresses[i],zone.version,type];
      if(builtin&&zone.version>=14&&(type==1||type==2)&&zone.introspect->task_statistics){
        NSDictionary *prior=boundedAttempts[attemptKey];
        if(prior){row[@"statistics"]=NSNull.null;row[@"statisticsAttemptCached"]=@YES;row[@"cachedStatisticsAttempt"]=prior;}
        else {row[@"statisticsAttemptCached"]=@NO;row[@"statisticsAttemptUptimeMs"]=@(NSProcessInfo.processInfo.systemUptime*1000);malloc_statistics_t stats{};reads.error=KERN_SUCCESS;zone.introspect->task_statistics(mach_task_self(),addresses[i],reader,&stats);row[@"statisticsReadCode"]=@(reads.error);row[@"callbackHasNoStatusReturn"]=@YES;
        if(!reads.error)row[@"statistics"]=@{@"blocks_in_use":@(stats.blocks_in_use),@"size_in_use":[NSString stringWithFormat:@"%llu",(unsigned long long)stats.size_in_use],@"max_size_in_use":[NSString stringWithFormat:@"%llu",(unsigned long long)stats.max_size_in_use],@"size_allocated":[NSString stringWithFormat:@"%llu",(unsigned long long)stats.size_allocated]};
        else row[@"statistics"]=NSNull.null;
        if(zone.version>=14)row[@"nativeZoneType"]=@(zone.introspect->zone_type);
        }
      }else{row[@"statistics"]=NSNull.null;row[@"reason"]=@"Only reviewed XZONE/PGM task_statistics callbacks are invoked. Legacy magazine callbacks can read outside requested copied ranges; unknown/custom and sanitizer callbacks stay unavailable";}
    }
    row[@"readerCopiedBytes"]=@(reads.bytes);row[@"readerCopyCount"]=@(reads.count);row[@"readerLastRequestedBytes"]=@(reads.lastRequestedBytes);row[@"readerMaximumSingleCopyBytes"]=@(4*1024*1024);row[@"readerMaximumTotalCopyBytes"]=@(32*1024*1024);
    if([row[@"statisticsReadCode"] intValue]==KERN_RESOURCE_SHORTAGE&&boundedAttempts.count<256){NSString *key=[NSString stringWithFormat:@"%llu:%u:%u",(unsigned long long)addresses[i],[row[@"version"] unsignedIntValue],[row[@"nativeZoneType"] unsignedIntValue]];boundedAttempts[key]=[row copy];}
    [rows addObject:row];
  }
  active=nullptr;return @{@"enumerationCode":@(code),@"registeredZoneCount":@(count),@"zones":rows,@"limitReached":@(count>256),@"scope":@"Per registered allocator zone, using system-libmalloc task_statistics and bounded copied Mach reads. Not an atomic heap snapshot; concurrent zone destruction returns read errors. No live allocation-address export, zone locking or pressure relief. Snapshot copies add temporary VM use. Copy-limit failures are cached by zone address/version/type until process restart; cachedStatisticsAttempt retains the original attempt, not a current reading. Zone address reuse can retain a prior limit outcome. max_size_in_use is native touched-memory accounting, not necessarily a live-allocation peak."};
}
}
