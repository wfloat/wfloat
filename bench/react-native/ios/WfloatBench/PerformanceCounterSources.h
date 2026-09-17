#pragma once
#include <sys/sysctl.h>
#include <cerrno>
// XNU kern_kpc.c makes class/config/counter-count queries public. The input
// integer selects a class: it is not a counter configuration or enablement.
static NSDictionary *performanceCounterSources() {
  NSMutableArray *queries=[NSMutableArray new];
  auto integer=[&](const char *name,int32_t *selector){int32_t value=0;size_t size=sizeof(value);errno=0;
    const int status=sysctlbyname(name,&value,&size,selector,selector?sizeof(*selector):0);const int saved=errno;
    [queries addObject:@{@"name":@(name),@"selector":selector?@(*selector):(id)NSNull.null,@"returnedBytes":@(size),@"value":status==0&&size==sizeof(value)?@(value):(id)NSNull.null,@"status":@(status),@"errno":@(status? saved:0)}];};
  integer("kpc.classes",nullptr);integer("kpc.pmu_version",nullptr);
  for(int32_t classes: {1,2,4,8}){integer("kpc.counter_count",&classes);integer("kpc.config_count",&classes);}
  int32_t tid=0;uint64_t counters[64]{};size_t length=sizeof(counters);errno=0;
  const int status=sysctlbyname("kpc.thread_counters",counters,&length,&tid,sizeof(tid));const int saved=errno;NSMutableArray *raw=[NSMutableArray new];
  if(status==0&&length<=sizeof(counters)&&length%sizeof(uint64_t)==0)for(size_t i=0;i<length/sizeof(uint64_t);++i)[raw addObject:exact(counters[i])];
  return @{@"queries":queries,@"collectorThreadCounters":@{@"status":@(status),@"errno":@(status?saved:0),@"returnedBytes":@(length),@"rawSlots":raw},@"scope":@"read-only KPC capability/class counts and existing collector-thread counters; native class masks/slots, no event selection or counting enablement; kernel may require privileged tracing access for values"};
}
