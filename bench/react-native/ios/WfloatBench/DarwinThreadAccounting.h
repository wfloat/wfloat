#pragma once
#include <dlfcn.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <cstdint>
#include <cerrno>
#include <cstddef>
#include <pthread.h>
// Published private XNU proc_info ABI. Read-only, own PID and existing thread ID.
struct BenchThreadCountsData {uint64_t instructions,cycles,userMach,systemMach,energyNj;};
struct BenchThreadCounts {uint16_t length,reserved0;uint32_t reserved1;BenchThreadCountsData counts[16];};
static_assert(sizeof(BenchThreadCountsData)==40 && offsetof(BenchThreadCounts,counts)==8);
static NSDictionary *darwinPerfLevelNames() {
  uint32_t count=0;size_t bytes=sizeof(count);errno=0;int rc=sysctlbyname("hw.nperflevels",&count,&bytes,nullptr,0),error=rc?errno:0;
  NSMutableArray *names=[NSMutableArray new];
  if(!rc && bytes==sizeof(count))for(uint32_t i=0;i<std::min(count,16u);++i){
    NSString *key=[NSString stringWithFormat:@"hw.perflevel%u.name",i];char text[128]{};size_t size=sizeof(text);errno=0;int result=sysctlbyname(key.UTF8String,text,&size,nullptr,0),saved=result?errno:0;
    NSString *name=!result&&size<=sizeof(text)?[[NSString alloc] initWithBytes:text length:strnlen(text,size) encoding:NSUTF8StringEncoding]:nil;
    [names addObject:@{@"index":@(i),@"name":name?: (id)NSNull.null,@"errno":@(saved),@"returnedBytes":@(size)}];
  }
  return @{@"reportedCount":!rc&&bytes==sizeof(count)?@(count):(id)NSNull.null,@"errno":@(error),@"returnedBytes":@(bytes),@"names":names,@"limitReached":@(count>16)};
}
static NSArray *darwinThreadAccounting(uint64_t tid) {
  using Fn=int(*)(int,int,uint64_t,void *,int);static Fn query=(Fn)dlsym(RTLD_DEFAULT,"proc_pidinfo");
  if(!query)return @[@{@"source":@"proc_thread_accounting",@"error":@"proc_pidinfo unavailable"}];
  NSMutableArray *rows=[NSMutableArray new];
  uint64_t currentTid=0;pthread_threadid_np(nullptr,&currentTid);
  if(tid==currentTid){uint64_t ns=0;errno=0;int size=query(getpid(),33,tid,&ns,sizeof(ns)),error=size<=0?errno:0;
   [rows addObject:@{@"source":@"PROC_PIDTHREADSCHEDINFO",@"returnedBytes":@(size),@"expectedBytes":@(sizeof(ns)),@"errno":@(error),@"scope":@"collector thread only; XNU returns a zero placeholder unless SCHED_HYGIENE_DEBUG is compiled in",@"values":size==sizeof(ns)?@{@"int_time_ns":exact(ns)}:(id)NSNull.null}];}
  {BenchThreadCounts v{};errno=0;int size=query(getpid(),34,tid,&v,sizeof(v)),error=size<=0?errno:0;
   bool valid=size>=8 && v.length<=16 && size==8+v.length*sizeof(BenchThreadCountsData);NSMutableArray *levels=[NSMutableArray new];
   if(valid)for(unsigned i=0;i<v.length;++i){auto &c=v.counts[i];[levels addObject:@{@"perfLevelIndex":@(i),@"ptcd_instructions":exact(c.instructions),@"ptcd_cycles":exact(c.cycles),@"ptcd_user_time_mach":exact(c.userMach),@"ptcd_system_time_mach":exact(c.systemMach),@"ptcd_energy_nj":exact(c.energyNj)}];}
   [rows addObject:@{@"source":@"PROC_PIDTHREADCOUNTS",@"returnedBytes":@(size),@"errno":@(error),@"reportedCount":size>=8?@(v.length):(id)NSNull.null,@"layoutValid":@(valid),@"values":valid?levels:(id)NSNull.null,@"scope":@"cumulative per-thread counters by native perf-level index; CPU times in Mach units, energy in native nJ accounting, not whole-phone energy; unsupported counters may be zero"}];}
  return rows;
}
